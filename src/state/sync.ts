import type { Playlist } from "../data/types";
import { likedPlaylist } from "../data/library";
import type { Listen } from "../recommend/taste";
import { adoptMixes, currentMixes, onMixes, type Mix } from "../recommend/mixes";
import { applyEngineSettings, setSpeed, toast, toggleShuffle, updateToast } from "./actions";
import { connectLibrarySync, defaultSettings, flushPersist, getState, initialLibrarySync, setState, subscribe, type AppState, type Settings } from "./store";
import { adoptPlaybackSpot, onPlaybackSpot, playbackSpot, type PlaybackSpot } from "./resume";
import { adoptSlipIns, allSlipIns, onSlipIns, type SlipIn } from "./slipins";
import { syncServerLibrary } from "./importer";
import { flushSongChanges } from "./song-api";
import { CloudError, cloudCall, getAccount, onSignedIn } from "./cloud";
import { syncCloudSongs } from "./cloud-sync";

/*
 * Library data on the music server: playlists, likes, listening history,
 * settings, slip-ins, today's mixes, shuffle/repeat/speed and the song you were
 * playing, kept in step between every browser that uses this server.
 *
 * The server holds one versioned document. Each browser remembers the version
 * it last agreed on (the base) and merges three ways: anything changed only
 * here or only there is kept, deletions included; something changed on both
 * sides keeps this browser's version, except counters (listening minutes,
 * kept/rejected tallies), which add up.
 *
 * Only songs on the music server (track ids "srv_…") are synced. Songs added
 * from this computer and streamed suggestions stay on this device.
 *
 * Signed in to a Slopify account, the same data is also merged, the same way,
 * with the account's copy (cloud/), so it follows the account to other
 * computers. The account's songs are synced first (cloud-sync.ts), so the
 * songs its playlists name exist here under the same ids.
 */

/** Settings that describe this device rather than the listener. */
const DEVICE_SETTINGS = new Set<keyof Settings>(["downloadMode"]);
const QUICK = 2000;
const SLOW = 30_000;
const POLL = 30_000;
const MAX_LISTENS = 500;

type Counter = number | number[];
interface LibraryData {
  version: 1;
  playlists: Record<string, Playlist>;
  playlistOrder: string[];
  likes: Record<string, number>;
  saves: Record<string, Record<string, number>>;
  hidden: Record<string, number>;
  hiddenDiscoveries: Record<string, number>;
  reasons: Record<string, Counter>;
  listens: Record<string, Listen>;
  plays: Record<string, { id: string; at: number }>;
  listenLog: Record<string, number>;
  settings: Record<string, unknown>;
  // Added later: a copy saved by an older version lacks these, which counts as unchanged.
  slipIns?: Record<string, SlipIn>;
  mixes?: Record<string, Mix>;
  /** Shuffle, repeat and speed. Volume stays with each device (speakers and headphones differ). */
  playback?: Record<string, unknown>;
  /** Where you left off. */
  spot?: PlaybackSpot | null;
}
interface Base { rev: number; data: LibraryData | null }

const synced = (id: string) => id.startsWith("srv_");
const same = (a: unknown, b: unknown) => a === b || JSON.stringify(a) === JSON.stringify(b);
const pick = <T>(map: Record<string, T>, keep: (key: string) => boolean) => Object.fromEntries(Object.entries(map).filter(([key]) => keep(key))) as Record<string, T>;
/** Liked Songs always has the app's own name, description and art; only its songs are synced. */
const canonical = (p: Playlist) => (p.id === "liked" ? likedPlaylist(p) : p);
const canonicalAll = (list: Record<string, Playlist>) => Object.fromEntries(Object.entries(list).map(([id, p]) => [id, canonical(p)]));
/** The listener's settings (not this device's), limited to settings this version of the app has. */
const listenerSettings = (settings: Record<string, unknown>) => pick(settings, (key) => key in defaultSettings && !DEVICE_SETTINGS.has(key as keyof Settings));
/** Shuffle, repeat and speed as a new device starts: the baseline, so its defaults never override yours. */
const PLAYBACK_DEFAULTS: Record<string, unknown> = { shuffle: false, repeat: "off", speed: 1 };
/** Mixes keyed in one order everywhere, so devices listing them differently still agree. */
const byId = <T>(map: Record<string, T>) => Object.fromEntries(Object.entries(map).sort(([a], [b]) => a.localeCompare(b)));

/* ───────────────────────── this browser's data ───────────────────────── */

/**
 * This browser's library data. Server songs it doesn't know yet (its song list
 * may still be loading) keep their base entries, so they're never taken as deleted.
 */
function localData(s: AppState, base: LibraryData | null): LibraryData {
  const unknown = (id: string) => synced(id) && !s.tracks[id];
  const withUnknown = <T>(own: Record<string, T>, fromBase: Record<string, T> | undefined) => ({ ...pick(fromBase ?? {}, unknown), ...pick(own, synced) });
  const playlists: Record<string, Playlist> = {};
  for (const p of s.playlists) {
    const kept = base?.playlists[p.id]?.trackIds.filter(unknown) ?? [];
    playlists[p.id] = { ...canonical(p), trackIds: [...p.trackIds.filter(synced), ...kept] };
  }
  return {
    version: 1,
    playlists,
    playlistOrder: s.playlists.map((p) => p.id),
    likes: withUnknown(s.taste.likes, base?.likes),
    saves: withUnknown(s.taste.saves, base?.saves),
    hidden: withUnknown(s.taste.hidden, base?.hidden),
    hiddenDiscoveries: s.taste.hiddenDiscoveries,
    reasons: s.taste.reasons as Record<string, Counter>,
    listens: Object.fromEntries(s.taste.listens.filter((l) => synced(l.trackId)).map((l) => [l.id, l])),
    plays: Object.fromEntries(s.listens.filter((l) => synced(l.id)).map((l) => [`${l.id}@${l.at}`, l])),
    listenLog: s.listenLog,
    settings: listenerSettings(s.settings as unknown as Record<string, unknown>),
    slipIns: withUnknown(allSlipIns(), base?.slipIns),
    mixes: byId(Object.fromEntries(currentMixes().map((m) => [m.id, m]))),
    // A Listen Along guest plays at the host's speed, which isn't their own setting: theirs stays as agreed.
    playback: { shuffle: s.shuffle, repeat: s.repeat, speed: s.listen.mode === "guest" ? (base?.playback ?? PLAYBACK_DEFAULTS).speed : s.speed },
    spot: playbackSpot(),
  };
}

/* ───────────────────────── merging ───────────────────────── */

/** Three-way merge of one map: a side that didn't change takes the other's value (or deletion). */
function mergeMap<T>(base: Record<string, T> = {}, mine: Record<string, T> = {}, theirs: Record<string, T> = {}, both?: (b: T | undefined, m: T, t: T) => T) {
  const out: Record<string, T> = {};
  for (const key of new Set([...Object.keys(base), ...Object.keys(mine), ...Object.keys(theirs)])) {
    const b = base[key];
    const m = mine[key];
    const t = theirs[key];
    const value = same(m, b) ? t : same(t, b) ? m : m !== undefined && t !== undefined && both ? both(b, m, t) : m;
    if (value !== undefined) out[key] = value;
  }
  return out;
}

/** Counters changed on both sides add both changes: mine + theirs - base. */
const addCounters = (b: Counter | undefined, m: Counter, t: Counter): Counter => {
  if (typeof m === "number" && typeof t === "number") return m + t - (typeof b === "number" ? b : 0);
  if (Array.isArray(m) && Array.isArray(t)) return m.map((n, i) => n + (t[i] ?? 0) - (Array.isArray(b) ? b[i] ?? 0 : 0));
  return m;
};

/**
 * A slip-in changed on both sides: the latest play decides, and each count is
 * the higher one. (Adding them up would count a change twice when it reaches a
 * device by both the music server and the account.)
 */
const mergeSlipIn = (_b: SlipIn | undefined, m: SlipIn, t: SlipIn): SlipIn => {
  const [latest, other] = (m.lastAt ?? 0) >= (t.lastAt ?? 0) ? [m, t] : [t, m];
  return {
    ...latest,
    addedAt: Math.min(m.addedAt, t.addedAt),
    slipped: Math.max(m.slipped, t.slipped),
    finished: Math.max(m.finished, t.finished),
    skipped: Math.max(m.skipped, t.skipped),
    offered: Boolean(m.offered || t.offered),
    ...(other.lastAt && !latest.lastAt ? { lastAt: other.lastAt } : {}),
  };
};

/**
 * Mix editions: the newer edition wins, then a finished one, then (so every
 * device settles on the same one) the same pick whichever side is which. Songs
 * hidden from a mix stay hidden. Expired editions go.
 */
function mergeMixes(base: Record<string, Mix> = {}, mine: Record<string, Mix> = {}, theirs: Record<string, Mix> = {}) {
  const now = Date.now();
  const out: Record<string, Mix> = {};
  for (const id of new Set([...Object.keys(mine), ...Object.keys(theirs)])) {
    const [b, m, t] = [base[id], mine[id], theirs[id]];
    let chosen = same(m, b) ? t : same(t, b) ? m : undefined;
    if (!chosen) {
      const [x, y] = [m, t].filter((e): e is Mix => Boolean(e)).sort((p, q) => q.expires - p.expires || Number(q.complete) - Number(p.complete) || (JSON.stringify(p) < JSON.stringify(q) ? -1 : 1));
      chosen = y && y.edition === x.edition ? { ...x, hidden: [...new Set([...x.hidden, ...y.hidden])] } : x;
    }
    if (chosen && chosen.expires > now) out[id] = chosen;
  }
  return byId(out);
}

const newestSpot = (...spots: Array<PlaybackSpot | null | undefined>) => spots.filter((x): x is PlaybackSpot => Boolean(x)).sort((a, b) => b.at - a.at)[0] ?? null;

function merge(base: LibraryData | null, mine: LibraryData, theirs: LibraryData): LibraryData {
  const playlists = mergeMap(base ? canonicalAll(base.playlists) : undefined, canonicalAll(mine.playlists), canonicalAll(theirs.playlists), (_b, m, t) => {
    // A fresh browser creates an empty Liked Songs automatically; it isn't an edit
    // to the listener's server collection. Preserve both libraries on first sync.
    if (!base && m.id === "liked" && t.id === "liked") return { ...t, trackIds: [...new Set([...t.trackIds, ...m.trackIds])] };
    return m;
  });
  // The order that changed (this browser's if both did), then playlists new from the other side.
  const [first, second] = base && same(mine.playlistOrder, base.playlistOrder) ? [theirs, mine] : [mine, theirs];
  const order = [...first.playlistOrder, ...second.playlistOrder].filter((id, i, all) => playlists[id] && all.indexOf(id) === i);
  const listens = Object.values(mergeMap(base?.listens, mine.listens, theirs.listens)).sort((a, b) => b.at - a.at).slice(0, MAX_LISTENS);
  return {
    version: 1,
    playlists,
    playlistOrder: order,
    likes: mergeMap(base?.likes, mine.likes, theirs.likes),
    saves: mergeMap(base?.saves, mine.saves, theirs.saves),
    hidden: mergeMap(base?.hidden, mine.hidden, theirs.hidden),
    hiddenDiscoveries: mergeMap(base?.hiddenDiscoveries, mine.hiddenDiscoveries, theirs.hiddenDiscoveries),
    reasons: mergeMap(base?.reasons, mine.reasons, theirs.reasons, addCounters),
    listens: Object.fromEntries(listens.map((l) => [l.id, l])),
    plays: mergeMap(base?.plays, mine.plays, theirs.plays),
    listenLog: mergeMap(base?.listenLog, mine.listenLog, theirs.listenLog, addCounters) as Record<string, number>,
    // Initial defaults are the baseline, rather than deliberate preference edits.
    settings: mergeMap(base?.settings ?? listenerSettings(defaultSettings as unknown as Record<string, unknown>), mine.settings, theirs.settings),
    slipIns: mergeMap(base?.slipIns, mine.slipIns, theirs.slipIns ?? base?.slipIns, mergeSlipIn),
    mixes: mergeMixes(base?.mixes, mine.mixes, theirs.mixes ?? base?.mixes),
    playback: mergeMap(base?.playback ?? PLAYBACK_DEFAULTS, mine.playback, theirs.playback ?? base?.playback ?? PLAYBACK_DEFAULTS),
    spot: newestSpot(mine.spot, theirs.spot),
  };
}

/**
 * A synced playlist's songs with this device's own songs put back where they
 * were: each follows the synced song it came after (or leads, if it came first).
 */
function keepDeviceSongs(syncedIds: string[], own: string[], isDeviceSong: (id: string) => boolean) {
  const present = new Set(syncedIds);
  const after = new Map<string | null, string[]>();
  let anchor: string | null = null;
  for (const id of own) {
    if (isDeviceSong(id)) after.set(anchor, [...(after.get(anchor) ?? []), id]);
    else if (present.has(id)) anchor = id;
  }
  return [...(after.get(null) ?? []), ...syncedIds.flatMap((id) => [id, ...(after.get(id) ?? [])])];
}

/** Puts merged data into this browser, keeping what it holds for songs that aren't synced. */
function apply(data: LibraryData) {
  setState((s) => {
    const local = (id: string) => !synced(id) && Boolean(s.tracks[id]);
    const known = (id: string) => Boolean(s.tracks[id]);
    const ownPlaylists = new Map(s.playlists.map((p) => [p.id, p]));
    const playlists = data.playlistOrder.map((id) => {
      const p = canonical(data.playlists[id]);
      return { ...p, trackIds: keepDeviceSongs(p.trackIds.filter(known), ownPlaylists.get(id)?.trackIds ?? [], local) };
    });
    const ownListens = s.taste.listens.filter((l) => !synced(l.trackId));
    return {
      playlists,
      taste: {
        ...s.taste,
        rev: s.taste.rev + 1,
        likes: { ...pick(s.taste.likes, local), ...data.likes },
        saves: { ...pick(s.taste.saves, local), ...data.saves },
        hidden: { ...pick(s.taste.hidden, local), ...data.hidden },
        hiddenDiscoveries: data.hiddenDiscoveries,
        reasons: data.reasons as AppState["taste"]["reasons"],
        listens: [...Object.values(data.listens), ...ownListens].sort((a, b) => b.at - a.at).slice(0, MAX_LISTENS),
      },
      listens: [...Object.values(data.plays), ...s.listens.filter((l) => !synced(l.id))].sort((a, b) => b.at - a.at),
      listenLog: data.listenLog,
      settings: { ...s.settings, ...(listenerSettings(data.settings) as Partial<Settings>) },
    };
  });
  if (data.slipIns) adoptSlipIns({ ...pick(allSlipIns(), (id) => !synced(id)), ...data.slipIns });
  if (data.mixes) {
    // Kept in this device's order (Daily Mixes first), with new ones after.
    const order = currentMixes().map((m) => m.id);
    const rank = (id: string) => (order.includes(id) ? order.indexOf(id) : order.length);
    adoptMixes(Object.values(data.mixes).sort((a, b) => rank(a.id) - rank(b.id) || a.id.localeCompare(b.id)));
  }
  applyPlayback(data.playback);
  adoptPlaybackSpot(data.spot);
}

/** Shuffle, repeat and speed as chosen on another device, applied the way the buttons apply them. */
function applyPlayback(playback: LibraryData["playback"]) {
  if (!playback) return;
  const s = getState();
  if (typeof playback.shuffle === "boolean" && playback.shuffle !== s.shuffle) toggleShuffle();
  if ((playback.repeat === "off" || playback.repeat === "one" || playback.repeat === "all") && playback.repeat !== s.repeat) {
    setState({ repeat: playback.repeat });
    applyEngineSettings();
  }
  if (typeof playback.speed === "number" && playback.speed > 0 && playback.speed !== s.speed && s.listen.mode !== "guest") setSpeed(playback.speed);
}

/* ───────────────────────── talking to the server ───────────────────────── */

function readBase(): Base {
  const base = initialLibrarySync() as Base | undefined;
  if (Number.isSafeInteger(base?.rev) && (base?.data === null || base?.data?.version === 1)) return base!;
  return { rev: 0, data: null };
}
// Tabs share persistence, but only this tab can advance its in-memory merge base.
let agreedBase = readBase();
connectLibrarySync(() => agreedBase);
function writeBase(base: Base) {
  agreedBase = base;
  flushPersist();
}

async function request(init?: RequestInit) {
  const res = await fetch("/api/state", { cache: "no-store", ...init });
  const body = await res.json().catch(() => null);
  if ((!res.ok && res.status !== 409) || !Number.isSafeInteger(body?.rev)) throw new Error(body?.error?.message || `Music server error (HTTP ${res.status}).`);
  return { conflict: res.status === 409, rev: body.rev as number, data: body.data as LibraryData | null };
}

type Remote = { conflict: boolean; rev: number; data: LibraryData | null };

/**
 * Merges this browser's data with one remote copy until they agree: fetch,
 * merge three ways against the last agreed base, save, and merge again if
 * someone else saved first.
 */
async function mergeWith(remoteNow: Remote, save: (baseRev: number, data: LibraryData) => Promise<Remote>, base: () => Base, setBase: (b: Base) => void) {
  let remote = remoteNow;
  for (let tries = 0; tries < 4; tries++) {
    const agreed = base();
    const mine = localData(getState(), agreed.data);
    const merged = remote.data ? merge(remote.rev === agreed.rev ? remote.data : agreed.data, mine, remote.data) : mine;
    if (remote.data && !same(merged, localData(getState(), remote.data))) apply(merged);
    if (remote.data && same(merged, remote.data)) {
      setBase({ rev: remote.rev, data: remote.data });
      return;
    }
    const saved = await save(remote.rev, merged);
    if (!saved.conflict) {
      setBase({ rev: saved.rev, data: merged });
      return;
    }
    // Another browser saved first: merge with theirs and try again.
    setBase({ rev: remote.rev, data: remote.data });
    remote = saved;
  }
  throw new Error("The library changed during sync. Try again.");
}

/* ───────────────────────── the account's copy ───────────────────────── */

const cloudBaseKey = (userId: string) => `slopify.cloud-state.v1.${userId}`;
function cloudBase(userId: string): Base {
  try {
    const base = JSON.parse(localStorage.getItem(cloudBaseKey(userId)) || "null") as Base | null;
    if (base && Number.isSafeInteger(base.rev) && (base.data === null || base.data?.version === 1)) return base;
  } catch { /* Start afresh: the first merge keeps both sides. */ }
  return { rev: 0, data: null };
}
let cloudAgreed: { userId: string; base: Base } | null = null;

async function cloudState(): Promise<Remote> {
  const { rev, data } = await cloudCall<{ rev: number; data: LibraryData | null }>("/v1/library/state");
  return { conflict: false, rev, data: data?.version === 1 ? data : null };
}

async function saveCloudState(baseRev: number, data: LibraryData): Promise<Remote> {
  try {
    const saved = await cloudCall<{ rev: number }>("/v1/library/state", { method: "PUT", body: { baseRev, data } });
    return { conflict: false, rev: saved.rev, data };
  } catch (error) {
    if (error instanceof CloudError && error.status === 409) {
      const body = error.body as { rev: number; data: LibraryData | null };
      return { conflict: true, rev: body.rev, data: body.data?.version === 1 ? body.data : null };
    }
    throw error;
  }
}

/* ───────────────────────── which account this computer's library is ───────────────────────── */

export interface ComputerLink { userId: string; name: string | null; email: string | null }

/** The account this computer's library syncs with (kept by its music server), or null when none yet. */
export async function computerLink(): Promise<ComputerLink | null> {
  const res = await fetch("/api/cloud-link", { cache: "no-store" });
  const body = (await res.json().catch(() => null)) as { ok?: boolean; link?: ComputerLink | null } | null;
  if (!res.ok || !body?.ok) throw new Error("The music server couldn't say which account this library belongs to.");
  return body.link ?? null;
}

/**
 * Makes this computer's library the signed-in account's. The first account to
 * sign in here gets it automatically; moving it to another account (`replace`)
 * adds this computer's songs and playlists to that account, so it's only done
 * when asked for (Settings → Account).
 */
export async function linkComputer(replace = false) {
  const { userId, profile, email } = getAccount();
  if (!userId) return false;
  const res = await fetch("/api/cloud-link", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ userId, name: profile?.displayName ?? null, email, replace }),
  });
  if (res.status === 409) return false;
  if (!res.ok) throw new Error("The music server couldn't link this library to your account.");
  if (replace) {
    setState((s) => ({ server: { ...s.server, linkedElsewhere: undefined } }));
    schedule(QUICK);
  }
  return true;
}

/** The account's songs, then its playlists, likes and settings. A failure here never stops this computer's own sync. */
async function syncWithAccount() {
  const { status, userId } = getAccount();
  if (status !== "signedIn" || !userId) return;
  try {
    // Another account's library lives here: leave both alone until the listener chooses.
    const link = await computerLink();
    if (link && link.userId !== userId) {
      setState((s) => ({ server: { ...s.server, linkedElsewhere: link.email || link.name || "another account", cloudError: undefined } }));
      return;
    }
    if (!link && !(await linkComputer())) return;
    if (getState().server.linkedElsewhere) setState((s) => ({ server: { ...s.server, linkedElsewhere: undefined } }));
    if (await syncCloudSongs()) await syncServerLibrary();
    if (cloudAgreed?.userId !== userId) cloudAgreed = { userId, base: cloudBase(userId) };
    const mine = cloudAgreed;
    await mergeWith(await cloudState(), saveCloudState, () => mine.base, (base) => {
      mine.base = base;
      try {
        localStorage.setItem(cloudBaseKey(userId), JSON.stringify(base));
      } catch { /* Kept for this session. */ }
    });
    setState((s) => ({ server: { ...s.server, cloudSyncedAt: Date.now(), cloudError: undefined } }));
  } catch (error) {
    setState((s) => ({ server: { ...s.server, cloudError: error instanceof Error ? error.message : "Couldn't sync with your account." } }));
  }
}

// Signing in brings the account's library here straight away.
onSignedIn(() => void syncLibraryData().catch(() => undefined));

let running: Promise<void> | null = null;
let again = false;

/** Brings this browser and the server into step: fetch, merge, save, and save again if someone else saved meanwhile. */
export function syncLibraryData(): Promise<void> {
  if (running) {
    again = true;
    return running;
  }
  running = (async () => {
    if (getState().server.status !== "connected") return;
    // One song's pending edit must not stop unrelated library data from syncing.
    await flushSongChanges().catch(() => undefined);
    await syncServerLibrary();
    const save = (baseRev: number, data: LibraryData) =>
      request({ method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ baseRev, data }) });
    await mergeWith(await request(), save, () => agreedBase, writeBase);
    setState((s) => ({ server: { ...s.server, syncedAt: Date.now() } }));
    await syncWithAccount();
  })().finally(() => {
    running = null;
    if (again) {
      again = false;
      schedule(QUICK);
    }
  });
  return running;
}

/** "Sync now", with the outcome shown. */
export async function syncNow() {
  if (getState().server.status !== "connected") {
    toast("The music server is offline", { tone: "error", detail: "Reconnect in Settings → Server." });
    return;
  }
  const id = toast("Syncing your library…", { sticky: true, progress: 0.3 });
  try {
    await syncLibraryData();
    // This computer synced; say so plainly if the account didn't.
    const { cloudError, linkedElsewhere } = getState().server;
    if (getAccount().status === "signedIn" && (cloudError || linkedElsewhere)) {
      updateToast(id, {
        message: "Synced this computer, but not your account",
        detail: linkedElsewhere ? `This computer's library belongs to ${linkedElsewhere}. See Settings → Account.` : cloudError,
        tone: "error", progress: undefined, sticky: false,
      }, 6000);
      return;
    }
    updateToast(id, { message: "Library synced", detail: "Playlists, likes and history are up to date.", tone: "success", progress: undefined, sticky: false }, 2400);
  } catch (error) {
    updateToast(id, { message: "Couldn't sync your library", detail: error instanceof Error ? error.message : undefined, tone: "error", progress: undefined, sticky: false }, 6000);
  }
}

let timer = 0;
let due = Infinity;
function schedule(delay: number) {
  const at = Date.now() + delay;
  if (timer && at >= due) return;
  clearTimeout(timer);
  due = at;
  timer = window.setTimeout(() => {
    timer = 0;
    due = Infinity;
    void syncLibraryData().catch(() => undefined);
  }, delay);
}

/** Syncs shortly after library changes (listening progress less often) and checks for other browsers' changes every 30 seconds. */
let watching = false;
export function watchLibraryData() {
  if (watching) return;
  watching = true;
  let last = getState();
  subscribe(() => {
    const s = getState();
    const prev = last;
    last = s;
    if (s.playlists !== prev.playlists || s.settings !== prev.settings || s.taste.likes !== prev.taste.likes || s.taste.saves !== prev.taste.saves
      || s.taste.hidden !== prev.taste.hidden || s.taste.hiddenDiscoveries !== prev.taste.hiddenDiscoveries
      || s.shuffle !== prev.shuffle || s.repeat !== prev.repeat || s.speed !== prev.speed) schedule(QUICK);
    else if (s.listens !== prev.listens || s.listenLog !== prev.listenLog || s.taste.listens !== prev.taste.listens) schedule(SLOW);
  });
  onSlipIns(() => schedule(QUICK));
  onMixes(() => schedule(QUICK));
  onPlaybackSpot(() => schedule(SLOW));
  window.setInterval(() => void syncLibraryData().catch(() => undefined), POLL);
}
