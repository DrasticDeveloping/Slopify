import type { Playlist } from "../data/types";
import { ThisDevice, thisDevice } from "../lib/native";
import { likedPlaylist } from "../data/library";
import type { Listen } from "../recommend/taste";
import { adoptMixes, currentMixes, onMixes, type Mix } from "../recommend/mixes";
import { applyEngineSettings, setSpeed, toast, toggleShuffle } from "./actions";
import { connectLibrarySync, defaultSettings, flushPersist, getState, initialLibrarySync, setState, subscribe, type AppState, type Settings } from "./store";
import { adoptPlaybackSpot, device, onPlaybackSpot, playbackSpot, type PlaybackSpot } from "./resume";
import { adoptSlipIns, allSlipIns, onSlipIns, type SlipIn } from "./slipins";
import { syncServerLibrary } from "./importer";
import { flushSongChanges } from "./song-api";
import { CloudError, cloudCall, deleteSignIn, getAccount, onSignedIn, signOut } from "./cloud";
import { leaveRoom } from "./listen";
import { forgetCloudSongs, syncCloudSongs } from "./cloud-sync";

/*
 * Library data on the music server: playlists, likes, listening history,
 * settings, slip-ins, today's mixes, shuffle/repeat/speed and the song you were
 * playing, kept in step between every browser that uses this server.
 *
 * The server holds one versioned document. Each browser remembers the version
 * it last agreed on (the base) and merges three ways: anything changed only
 * here or only there is kept, deletions included; something changed on both
 * sides keeps this browser's version. Counters (listening minutes, kept/rejected
 * tallies, slip-in plays) are kept per device instead, and added up (see below).
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
/** The account's copy costs a request to the online service, so it's only checked this often while the window has focus. */
const CLOUD_POLL = 30_000;
/** Listening progress and where you left off reach the account within this long. */
const CLOUD_SLOW = 5 * 60_000;
/** A failed account sync waits this long before an automatic retry. */
const CLOUD_RETRY = 60_000;
/** Coming back to the window checks the account if it hasn't been checked for this long. */
const CLOUD_ON_FOCUS = 30_000;
const MAX_LISTENS = 500;
/** Where the account's agreed copy is kept, per account. */
const CLOUD_BASE = "slopify.cloud-state.v1.";

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
  /** Each device's own counters. `reasons`, `listenLog` and the slip-in counts above are their totals, for older versions. */
  counts?: Record<string, DeviceCounts>;
  /** When recommendations were last reset: kept/rejected counts from before it are forgotten. */
  reasonsResetAt?: number;
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

/* ───────────────────────── counters, kept per device ───────────────────────── */

/*
 * Each device publishes only its own counts (`counts[device]`), and the totals
 * are their sum. A device's counts that arrive twice (by the music server and
 * by the account), or late, only replace its older ones (the higher `seq`
 * wins), so nothing is counted twice and nothing is lost.
 *
 * Totals synced before counts were kept per device are one more entry,
 * "legacy". A device's own counts are what it added beyond its `baseline`: its
 * counters when it first ran this version, less anything it hadn't synced yet.
 * Nothing stored is rewritten for that, so it can never happen twice.
 *
 * A copy saved by an older version has totals but no `counts`. Its totals are
 * taken as legacy only while no other device's counts are known (once they
 * are, an older version's totals already include them); that device's later
 * plays reach the others once it updates. Two such copies (the music server's
 * and the account's) usually share most of their plays, so legacy keeps the
 * higher of each count.
 *
 * Kept/rejected counts can also shrink (they're halved as they grow, see
 * countReason), so a device's own may be below its baseline: negative.
 *
 * Resetting recommendations forgets kept/rejected counts from before it: each
 * device's counts say which reset they were written after (`resetAt`), and
 * those written before the latest one (legacy and baseline too) have none.
 *
 * Tabs of one browser are one device. Two tabs counting at once keep the
 * newest tab's counts, as their shared storage already does.
 */
const LEGACY = "legacy";
/** A slip-in's [slipped, finished, skipped]. */
type Slips = [number, number, number];
interface Counts { reasons: Record<string, [number, number]>; listenLog: Record<string, number>; slipIns: Record<string, Slips> }
interface DeviceCounts extends Counts { seq: number; /** The recommendations reset this device had taken in when it wrote these. */ resetAt?: number }
/** This device's counts as last published, what they're measured from, and every other device's as last seen. */
interface Tallies { own: DeviceCounts; baseline: Counts; peers: Record<string, DeviceCounts> }

const noCounts = (): Counts => ({ reasons: {}, listenLog: {}, slipIns: {} });
/** `a` with `b` worked in, key by key (and position by position). */
function combine<T extends number | number[]>(a: Record<string, T>, b: Record<string, T>, f: (x: number, y: number) => number): Record<string, T> {
  const out: Record<string, number | number[]> = { ...a };
  for (const [key, y] of Object.entries(b)) {
    const x = out[key];
    out[key] = typeof y === "number" ? f(typeof x === "number" ? x : 0, y) : y.map((n, i) => f(Array.isArray(x) ? x[i] ?? 0 : 0, n));
  }
  return out as Record<string, T>;
}
/** `a`'s keys only, each worked with `b`'s (zero where `b` has none). */
function within<T extends number | number[]>(a: Record<string, T>, b: Record<string, T>, f: (x: number, y: number) => number): Record<string, T> {
  return pick(combine(a, b, f), (key) => key in a);
}
const plus = (x: number, y: number) => x + y;
const less = (x: number, y: number) => Math.max(0, x - y);
const minus = (x: number, y: number) => x - y;
const eachCount = (a: Counts, b: Counts, f: (x: number, y: number) => number): Counts => ({
  reasons: combine(a.reasons, b.reasons, f), listenLog: combine(a.listenLog, b.listenLog, f), slipIns: combine(a.slipIns, b.slipIns, f),
});
const eachWithin = (a: Counts, b: Counts, f: (x: number, y: number) => number): Counts => ({
  reasons: within(a.reasons, b.reasons, f), listenLog: within(a.listenLog, b.listenLog, f), slipIns: within(a.slipIns, b.slipIns, f),
});

const slipsOf = (records: Record<string, SlipIn> = {}) => Object.fromEntries(Object.entries(records).map(([id, r]) => [id, [r.slipped, r.finished, r.skipped] as Slips]));
const pairs = (reasons: Record<string, Counter> = {}) => pick(reasons, (k) => Array.isArray(reasons[k]) && (reasons[k] as number[]).length === 2) as Record<string, [number, number]>;
/** A copy saved before counts were kept per device: its totals, as one device's. */
const legacyOf = (d: LibraryData): DeviceCounts => ({ seq: 0, reasons: pairs(d.reasons), listenLog: d.listenLog ?? {}, slipIns: slipsOf(pick(d.slipIns ?? {}, synced)) });
/**
 * A copy's per-device counts. One saved by an older version gives its totals as
 * legacy only if `fresh`: no other device's counts are known yet (only this
 * device's own, and legacy). Otherwise it's an older version's rewrite of totals
 * that the known counts already include.
 */
const countsOf = (d: LibraryData | null | undefined, fresh: boolean): Record<string, DeviceCounts> =>
  !d ? {} : d.counts ?? (fresh ? { [LEGACY]: legacyOf(d) } : {});
const noOtherDevices = (known: Record<string, DeviceCounts>) => Object.keys(known).every((id) => id === device || id === LEGACY);

/** Every device's latest counts. The same `seq` with different counts (only legacy totals, from two older copies) keeps the higher of each. */
function mergeCounts(...all: Array<Record<string, DeviceCounts>>) {
  const out: Record<string, DeviceCounts> = {};
  for (const counts of all) {
    for (const [id, c] of Object.entries(counts)) {
      const had = out[id];
      out[id] = !had || c.seq > had.seq ? c : c.seq < had.seq || same(c, had) ? had : { seq: c.seq, ...eachCount(had, c, Math.max) };
    }
  }
  return byId(out);
}

/** Every device's counts added up, keyed in one order everywhere (so every device's copy agrees). Kept/rejected counts from before a reset are left out. */
function allTotal(counts: Record<string, DeviceCounts>, resetAt = 0): Counts {
  let total = noCounts();
  for (const c of Object.values(byId(counts))) total = eachCount(total, (c.resetAt ?? 0) < resetAt ? { ...c, reasons: {} } : c, plus);
  // A device's own kept/rejected counts can be negative (see above), never the total.
  const reasons = Object.fromEntries(Object.entries(total.reasons).map(([k, pair]) => [k, pair.map((n) => Math.max(0, n)) as [number, number]]));
  return { reasons: byId(reasons), listenLog: byId(total.listenLog), slipIns: byId(total.slipIns) };
}

/** This browser's counters as they stand (everything it shows as its own). */
const localCounts = (s: AppState): Counts => ({ reasons: s.taste.reasons as Counts["reasons"], listenLog: s.listenLog, slipIns: slipsOf(pick(allSlipIns(), synced)) });
/** The baseline, without kept/rejected counts once recommendations were reset. */
const baselineNow = (s: AppState): Counts => (s.taste.resetAt ? { ...tallies.baseline, reasons: {} } : tallies.baseline);

/** This device's counts as they are now, with a new `seq` when they changed. */
function ownCounts(s: AppState): DeviceCounts {
  const local = localCounts(s);
  const baseline = baselineNow(s);
  const now = { ...eachWithin(local, baseline, less), reasons: within(local.reasons, baseline.reasons, minus), ...(s.taste.resetAt ? { resetAt: s.taste.resetAt } : {}) };
  const { seq, ...was } = tallies.own;
  if (!same(now, was)) tallies.own = { seq: Math.max(seq + 1, Date.now()), ...now };
  return tallies.own;
}

/** Slip-ins with the counts from your other devices set as `elsewhere`. */
function slipInsWith(records: Record<string, SlipIn>, elsewhere: Record<string, Slips>) {
  return Object.fromEntries(Object.entries(records).map(([id, { elsewhere: _old, ...r }]) => [id, elsewhere[id] ? { ...r, elsewhere: elsewhere[id] } : r])) as Record<string, SlipIn>;
}

const nonZero = <T extends number | number[]>(map: Record<string, T>) => pick(map, (k) => [map[k]].flat().some((n) => n !== 0));

/** Shows every device's counts: the totals less this browser's own counters, kept beside them as `elsewhere`. */
function showTotals() {
  const s = getState();
  const total = allTotal({ ...tallies.peers, [device]: ownCounts(s) }, s.taste.resetAt);
  const elsewhere = eachCount(total, localCounts(s), minus);
  const reasons = nonZero(elsewhere.reasons);
  const listenElsewhere = nonZero(elsewhere.listenLog);
  if (!same(reasons, s.taste.elsewhere ?? {}) || !same(listenElsewhere, s.listenElsewhere)) {
    setState((st) => ({ taste: { ...st.taste, rev: st.taste.rev + 1, elsewhere: reasons }, listenElsewhere }));
  }
  adoptSlipIns(slipInsWith(allSlipIns(), nonZero(elsewhere.slipIns)));
}

/** Takes in other devices' counts. A reset on another device forgets this device's kept/rejected counts too. */
function applyOthers(counts: Record<string, DeviceCounts>, resetAt = 0) {
  tallies.peers = pick(counts, (id) => id !== device);
  if (resetAt > (getState().taste.resetAt ?? 0)) {
    setState((s) => ({ taste: { ...s.taste, rev: s.taste.rev + 1, reasons: {}, resetAt } }));
  }
  showTotals();
}

/**
 * This device's counts as published elsewhere, when they're newer than this
 * browser's (saved by another tab, or before this browser's data was cleared):
 * they become this browser's own, on top of the same baseline.
 */
function catchUp(remote: LibraryData | null) {
  const theirs = remote?.counts?.[device];
  if (!theirs || theirs.seq <= tallies.own.seq) return;
  const s = getState();
  // Counted before a reset made here: their kept/rejected counts are forgotten too.
  const latest: DeviceCounts = (theirs.resetAt ?? 0) < (s.taste.resetAt ?? 0) ? { ...theirs, reasons: {}, resetAt: s.taste.resetAt } : theirs;
  tallies.own = latest;
  // Their kept/rejected counts can be below zero (halved, see above). Without the
  // baseline they were measured from (app data cleared), it's raised to match, so
  // this browser's own counters never go negative.
  for (const [kind, pair] of Object.entries(latest.reasons)) {
    const had = tallies.baseline.reasons[kind] ?? [0, 0];
    const raised = had.map((n, i) => Math.max(n, -pair[i])) as [number, number];
    if (raised.some((n, i) => n !== had[i])) tallies.baseline = { ...tallies.baseline, reasons: { ...tallies.baseline.reasons, [kind]: raised } };
  }
  const now = eachCount(baselineNow(s), latest, plus);
  setState((st) => ({ taste: { ...st.taste, rev: st.taste.rev + 1, reasons: now.reasons }, listenLog: now.listenLog }));
  // Including slip-ins this browser hasn't taken in yet (the merge brings in the rest of them).
  const records = allSlipIns();
  const next = { ...records };
  for (const [id, [slipped, finished, skipped]] of Object.entries(now.slipIns)) {
    const record = records[id] ?? remote?.slipIns?.[id];
    if (record) next[id] = { ...record, slipped, finished, skipped };
  }
  adoptSlipIns(next);
}

/**
 * Where this device's counts start. Saved with the app data; the first time
 * this version runs, every synced copy's counts become the peers (an older
 * copy's totals as legacy), and the baseline is what those already include.
 */
function startTallies(): Tallies {
  const saved = (initialLibrarySync() as { tallies?: Tallies } | undefined)?.tallies;
  const valid = (c?: Partial<Counts>) => Boolean(c?.reasons && c.listenLog && c.slipIns);
  if (saved && Number.isFinite(saved.own?.seq) && valid(saved.own) && valid(saved.baseline) && saved.peers) return saved;
  const copies: LibraryData[] = [];
  const add = (d: LibraryData | null | undefined) => {
    if (d?.version === 1) copies.push(d);
  };
  add(agreedBase.data);
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key?.startsWith(CLOUD_BASE)) add((JSON.parse(localStorage.getItem(key) || "null") as Base | null)?.data);
    }
  } catch { /* Only the music server's copy, then. */ }
  const known = mergeCounts(...copies.map((d) => d.counts ?? {}));
  const peers = pick(mergeCounts(known, ...copies.map((d) => countsOf(d, noOtherDevices(known)))), (id) => id !== device);
  // Whatever this browser counted beyond what was synced stays its own.
  const baseline = eachWithin(localCounts(getState()), allTotal(peers), Math.min);
  return { own: { seq: 0, ...noCounts() }, baseline, peers };
}

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
  const counts = byId({ ...tallies.peers, [device]: ownCounts(s) });
  // Totals, for older versions (this one reads `counts`), worked out as merge() does.
  const totals = allTotal(counts, s.taste.resetAt);
  return {
    version: 1,
    playlists,
    playlistOrder: s.playlists.map((p) => p.id),
    likes: withUnknown(s.taste.likes, base?.likes),
    saves: withUnknown(s.taste.saves, base?.saves),
    hidden: withUnknown(s.taste.hidden, base?.hidden),
    hiddenDiscoveries: s.taste.hiddenDiscoveries,
    reasons: totals.reasons,
    listens: Object.fromEntries(s.taste.listens.filter((l) => synced(l.trackId)).map((l) => [l.id, l])),
    plays: Object.fromEntries(s.listens.filter((l) => synced(l.id)).map((l) => [`${l.id}@${l.at}`, l])),
    listenLog: totals.listenLog,
    settings: listenerSettings(s.settings as unknown as Record<string, unknown>),
    slipIns: withUnknown(sharedSlipIns(allSlipIns(), totals.slipIns), base?.slipIns),
    mixes: byId(Object.fromEntries(currentMixes().map((m) => [m.id, m]))),
    // A Listen Along guest plays at the host's speed, which isn't their own setting: theirs stays as agreed.
    playback: { shuffle: s.shuffle, repeat: s.repeat, speed: s.listen.mode === "guest" ? (base?.playback ?? PLAYBACK_DEFAULTS).speed : s.speed },
    spot: playbackSpot(),
    counts,
    reasonsResetAt: s.taste.resetAt,
  };
}

/** Slip-ins as synced: with every device's counts added up, and nothing kept only for this one. */
const sharedSlipIns = (records: Record<string, SlipIn>, totals: Record<string, Slips>) => Object.fromEntries(Object.entries(records).map(([id, { elsewhere: _here, ...r }]) => {
  const total = totals[id];
  return [id, total ? { ...r, slipped: total[0], finished: total[1], skipped: total[2] } : r];
})) as Record<string, SlipIn>;

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

/** A slip-in changed on both sides: the latest play decides. (Its counts are set from `counts` afterwards.) */
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
    // One side unchanged: the other's (which may be no edition at all, when it was cleared) stands.
    const settled = same(m, b) || same(t, b);
    let chosen = same(m, b) ? t : same(t, b) ? m : undefined;
    if (!settled) {
      const [x, y] = [m, t].filter((e): e is Mix => Boolean(e)).sort((p, q) => q.expires - p.expires || Number(q.complete) - Number(p.complete) || (JSON.stringify(p) < JSON.stringify(q) ? -1 : 1));
      chosen = y && y.edition === x.edition ? { ...x, hidden: [...new Set([...x.hidden, ...y.hidden])] } : x;
    }
    if (chosen && chosen.expires > now) out[id] = chosen;
  }
  return byId(out);
}

/**
 * A playlist changed on two devices: each detail takes the side that changed
 * it (this device's if both did), and songs added or removed on either side
 * are added or removed. Songs added on the other side follow the song they
 * came after there.
 */
function mergePlaylist(b: Playlist, m: Playlist, t: Playlist): Playlist {
  const out = { ...m };
  for (const key of Object.keys({ ...b, ...m, ...t }) as Array<keyof Playlist>) {
    if (key !== "trackIds" && same(m[key], b[key])) (out as Record<string, unknown>)[key] = t[key];
  }
  // The order comes from the side that reordered (this device's if both did, or if neither did but
  // it added or removed songs); songs removed on either side go, and the other's additions join it.
  const was = new Set(b.trackIds);
  const reordered = (ids: string[]) => {
    const kept = ids.filter((id) => was.has(id));
    return !same(kept, b.trackIds.filter((id) => kept.includes(id)));
  };
  const theirsLead = reordered(m.trackIds) ? false : reordered(t.trackIds) || same(m.trackIds, b.trackIds);
  const [first, second] = theirsLead ? [t.trackIds, m.trackIds] : [m.trackIds, t.trackIds];
  const removed = new Set(b.trackIds.filter((id) => !m.trackIds.includes(id) || !t.trackIds.includes(id)));
  const ids = first.filter((id) => !removed.has(id));
  second.forEach((id, i) => {
    if (was.has(id) || ids.includes(id)) return;
    const after = second.slice(0, i).reverse().find((x) => ids.includes(x));
    ids.splice(after === undefined ? 0 : ids.indexOf(after) + 1, 0, id);
  });
  out.trackIds = ids;
  return out;
}

const newestSpot = (...spots: Array<PlaybackSpot | null | undefined>) => spots.filter((x): x is PlaybackSpot => Boolean(x)).sort((a, b) => b.at - a.at)[0] ?? null;

function merge(base: LibraryData | null, mine: LibraryData, theirs: LibraryData): LibraryData {
  const playlists = mergeMap(base ? canonicalAll(base.playlists) : undefined, canonicalAll(mine.playlists), canonicalAll(theirs.playlists), (b, m, t) => {
    // A fresh browser creates an empty Liked Songs automatically; it isn't an edit
    // to the listener's server collection. Preserve both libraries on first sync.
    if (!base && m.id === "liked" && t.id === "liked") return { ...t, trackIds: [...new Set([...t.trackIds, ...m.trackIds])] };
    return b ? mergePlaylist(b, m, t) : m;
  });
  // The order that changed (this browser's if both did), then playlists new from the other side.
  const [first, second] = base && same(mine.playlistOrder, base.playlistOrder) ? [theirs, mine] : [mine, theirs];
  const order = [...first.playlistOrder, ...second.playlistOrder].filter((id, i, all) => playlists[id] && all.indexOf(id) === i);
  const listens = Object.values(mergeMap(base?.listens, mine.listens, theirs.listens)).sort((a, b) => b.at - a.at).slice(0, MAX_LISTENS);
  const known = mergeCounts(base?.counts ?? {}, mine.counts ?? {});
  // Totals from an older version count once: when this copy has never had counts
  // here (a copy agreed before had none) and no other device's are known. Legacy
  // already taken from another such copy keeps the higher of each.
  const counts = mergeCounts(known, countsOf(theirs, !base?.counts && noOtherDevices(known)));
  const resetAt = Math.max(base?.reasonsResetAt ?? 0, mine.reasonsResetAt ?? 0, theirs.reasonsResetAt ?? 0) || undefined;
  const totals = allTotal(counts, resetAt);
  const slipIns = mergeMap(base?.slipIns, mine.slipIns, theirs.slipIns ?? base?.slipIns, mergeSlipIn);
  for (const [id, [slipped, finished, skipped]] of Object.entries(totals.slipIns)) {
    if (slipIns[id]) slipIns[id] = { ...slipIns[id], slipped, finished, skipped };
  }
  return {
    version: 1,
    playlists,
    playlistOrder: order,
    likes: mergeMap(base?.likes, mine.likes, theirs.likes),
    saves: mergeMap(base?.saves, mine.saves, theirs.saves),
    hidden: mergeMap(base?.hidden, mine.hidden, theirs.hidden),
    hiddenDiscoveries: mergeMap(base?.hiddenDiscoveries, mine.hiddenDiscoveries, theirs.hiddenDiscoveries),
    reasons: totals.reasons,
    listens: Object.fromEntries(listens.map((l) => [l.id, l])),
    plays: mergeMap(base?.plays, mine.plays, theirs.plays),
    listenLog: totals.listenLog,
    // Initial defaults are the baseline, rather than deliberate preference edits.
    settings: mergeMap(base?.settings ?? listenerSettings(defaultSettings as unknown as Record<string, unknown>), mine.settings, theirs.settings),
    slipIns,
    mixes: mergeMixes(base?.mixes, mine.mixes, theirs.mixes ?? base?.mixes),
    playback: mergeMap(base?.playback ?? PLAYBACK_DEFAULTS, mine.playback, theirs.playback ?? base?.playback ?? PLAYBACK_DEFAULTS),
    spot: newestSpot(mine.spot, theirs.spot),
    counts,
    reasonsResetAt: resetAt,
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
        listens: [...Object.values(data.listens), ...ownListens].sort((a, b) => b.at - a.at).slice(0, MAX_LISTENS),
      },
      listens: [...Object.values(data.plays), ...s.listens.filter((l) => !synced(l.id))].sort((a, b) => b.at - a.at),
      settings: { ...s.settings, ...(listenerSettings(data.settings) as Partial<Settings>) },
    };
  });
  if (data.slipIns) {
    // Which songs are slip-ins, and how they last went, come from the synced copy; this device's counts stay its own.
    const records = allSlipIns();
    const own = (id: string) => ({ slipped: records[id]?.slipped ?? 0, finished: records[id]?.finished ?? 0, skipped: records[id]?.skipped ?? 0 });
    adoptSlipIns({ ...pick(records, (id) => !synced(id)), ...Object.fromEntries(Object.entries(data.slipIns).map(([id, r]) => [id, { ...r, ...own(id) }])) });
  }
  if (data.counts) applyOthers(data.counts, data.reasonsResetAt);
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
  if (Number.isSafeInteger(base?.rev) && (base?.data === null || base?.data?.version === 1)) return { rev: base!.rev, data: base!.data };
  return { rev: 0, data: null };
}
// Tabs share persistence, but only this tab can advance its in-memory merge base.
let agreedBase = readBase();
let tallies = startTallies();
// Saved with the app data, so this device's counts and what it knows of others' always match it.
connectLibrarySync(() => ({ ...agreedBase, tallies }));
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
    catchUp(remote.data);
    const agreed = base();
    const mine = localData(getState(), agreed.data);
    const merged = remote.data ? merge(remote.rev === agreed.rev ? remote.data : agreed.data, mine, remote.data) : mine;
    if (remote.data && !same(merged, localData(getState(), remote.data))) apply(merged);
    if (remote.data && same(merged, remote.data)) {
      setBase({ rev: remote.rev, data: remote.data });
      showTotals();
      return;
    }
    const saved = await save(remote.rev, merged);
    if (!saved.conflict) {
      setBase({ rev: saved.rev, data: merged });
      showTotals();
      return;
    }
    // Another browser saved first: merge with theirs and try again.
    setBase({ rev: remote.rev, data: remote.data });
    remote = saved;
  }
  throw new Error("The library changed during sync. Try again.");
}

/* ───────────────────────── the account's copy ───────────────────────── */

const cloudBaseKey = (userId: string) => `${CLOUD_BASE}${userId}`;
function cloudBase(userId: string): Base {
  try {
    const base = JSON.parse(localStorage.getItem(cloudBaseKey(userId)) || "null") as Base | null;
    if (base && Number.isSafeInteger(base.rev) && (base.data === null || base.data?.version === 1)) return base;
  } catch { /* Start afresh: the first merge keeps both sides. */ }
  return { rev: 0, data: null };
}
let cloudAgreed: { userId: string; base: Base } | null = null;

async function cloudState(userId: string): Promise<Remote> {
  const { rev, data } = await cloudCall<{ rev: number; data: LibraryData | null }>("/v1/library/state", { as: userId });
  return { conflict: false, rev, data: data?.version === 1 ? data : null };
}

async function saveCloudState(userId: string, baseRev: number, data: LibraryData): Promise<Remote> {
  try {
    const saved = await cloudCall<{ rev: number }>("/v1/library/state", { method: "PUT", body: { baseRev, data }, as: userId });
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
    wantAccount(0);
    schedule(QUICK);
  }
  return true;
}

/** An account being deleted: nothing syncs with it again, so its data isn't put back. */
let deletingAccount: string | null = null;

/**
 * Deletes the signed-in account: its profile and library on Slopify's online
 * service, then the sign-in itself. This computer's library stays, unlinked.
 */
export async function deleteAccount(): Promise<string | null> {
  const { userId } = getAccount();
  if (!userId) return null;
  deletingAccount = userId;
  try {
    await running?.catch(() => undefined);
    // The service removes the account from its rooms too; this leaves this window's cleanly.
    if (getState().listen.mode !== "idle") leaveRoom();
    await cloudCall("/v1/me", { method: "DELETE" });
  } catch (error) {
    deletingAccount = null;
    throw error;
  }
  const unlinked = await unlinkComputer(userId);
  forgetCloudSongs(userId);
  try {
    localStorage.removeItem(cloudBaseKey(userId));
  } catch { /* Nothing kept. */ }
  if (cloudAgreed?.userId === userId) cloudAgreed = null;
  const notes: string[] = [];
  if (!unlinked) notes.push(`${ThisDevice}'s library is still marked as that account's; Slopify tries again next time it starts.`);
  try {
    await deleteSignIn();
  } catch {
    // The data is gone either way; without the sign-in deleted, at least sign out.
    await signOut().catch(() => undefined);
    notes.unshift("Your library was deleted from your account, but the sign-in couldn't be. Sign in and choose Delete account again, or delete it under Manage → Security.");
  } finally {
    // Signed out (or the user is gone) either way. Signing in again later syncs as usual,
    // once the service stops refusing the deleted account (a few minutes).
    deletingAccount = null;
  }
  return notes.length ? notes.join(" ") : null;
}

const PENDING_UNLINK = "slopify.cloud.pending-unlink";

/** Removes this computer's link to a deleted account; one that fails is retried on the next start. */
async function unlinkComputer(userId: string) {
  try {
    const res = await fetch(`/api/cloud-link?userId=${encodeURIComponent(userId)}`, { method: "DELETE" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    localStorage.removeItem(PENDING_UNLINK);
    return true;
  } catch {
    try {
      localStorage.setItem(PENDING_UNLINK, userId);
    } catch { /* Can't remember it; Settings still shows whose library this is. */ }
    return false;
  }
}

/** Finishes an unlink that failed when an account was deleted (see deleteAccount). */
async function retryPendingUnlink() {
  let userId: string | null = null;
  try {
    userId = localStorage.getItem(PENDING_UNLINK);
  } catch { /* Nothing pending. */ }
  if (userId) await unlinkComputer(userId);
}

/** The account sync failure last told (see syncWithAccount). */
let toldAccountError = "";

/** The account's songs, then its playlists, likes and settings. A failure here never stops this computer's own sync. */
async function syncWithAccount() {
  const { status, userId } = getAccount();
  if (status !== "signedIn" || !userId || userId === deletingAccount) return;
  try {
    // Before anything reads whose library this is.
    await retryPendingUnlink();
    // Another account's library lives here: leave both alone until the listener chooses.
    const link = await computerLink();
    if (link && link.userId !== userId) {
      setState((s) => ({ server: { ...s.server, linkedElsewhere: link.email || link.name || "another account", cloudError: undefined } }));
      return;
    }
    if (!link && !(await linkComputer())) return;
    // Another account signed in while that was checked: its own sync starts afresh.
    if (getAccount().userId !== userId) return;
    if (getState().server.linkedElsewhere) setState((s) => ({ server: { ...s.server, linkedElsewhere: undefined } }));
    if (await syncCloudSongs(userId)) await syncServerLibrary();
    if (cloudAgreed?.userId !== userId) cloudAgreed = { userId, base: cloudBase(userId) };
    const mine = cloudAgreed;
    await mergeWith(await cloudState(userId), (rev, data) => saveCloudState(userId, rev, data), () => mine.base, (base) => {
      mine.base = base;
      try {
        localStorage.setItem(cloudBaseKey(userId), JSON.stringify(base));
      } catch { /* Kept for this session. */ }
    });
    setState((s) => ({ server: { ...s.server, cloudSyncedAt: Date.now(), cloudError: undefined } }));
    toldAccountError = "";
  } catch (error) {
    // Another account signed in partway through: its own sync starts afresh.
    if (getAccount().userId !== userId) return;
    const message = error instanceof Error ? error.message : "Couldn't sync with your account.";
    setState((s) => ({ server: { ...s.server, cloudError: message } }));
    // Said once per problem; a sync with the account that works lets it be said again.
    if (message !== toldAccountError) {
      toldAccountError = message;
      toast("Couldn't sync with your account", { tone: "error", detail: `${message} Your library is safe on ${thisDevice}; Slopify keeps trying.`, duration: 8000 });
    }
  }
}

/*
 * When the account is contacted: soon after something changes here
 * (`wantAccount`), and otherwise every 30 seconds while the window has
 * focus, never while it's merely open, hidden or in the tray.
 */
let accountDue = 0;
let accountCheckedAt = 0;
function wantAccount(delay: number) {
  accountDue = Math.min(accountDue, Date.now() + delay);
}
const inFront = () => document.visibilityState === "visible" && document.hasFocus();
function accountWanted() {
  const now = Date.now();
  return now >= accountDue || (inFront() && now - accountCheckedAt >= CLOUD_POLL);
}

// Signing in brings the account's library here straight away.
onSignedIn(() => {
  wantAccount(0);
  void syncLibraryData().catch(() => undefined);
});

let running: Promise<void> | null = null;
let again = false;
/** The sync failure last told, so each problem is said once rather than on every try. Cleared by a sync that works. */
let toldError = "";
function syncFailed(error: unknown) {
  const message = error instanceof Error ? error.message : "Couldn't reach your music server.";
  if (message === toldError) return;
  toldError = message;
  toast("Couldn't sync your library", { tone: "error", detail: message, duration: 8000 });
}

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
    toldError = "";
    if (getAccount().status === "signedIn" && accountWanted()) {
      accountDue = Infinity;
      accountCheckedAt = Date.now();
      await syncWithAccount();
      if (getState().server.cloudError) wantAccount(CLOUD_RETRY);
    }
  })().catch((error: unknown) => {
    // Syncing happens on its own, so a failure is told here (once), not left to whoever asked.
    syncFailed(error);
    throw error;
  }).finally(() => {
    running = null;
    if (again) {
      again = false;
      schedule(QUICK);
    }
  });
  return running;
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

/**
 * Syncs shortly after library changes (listening progress less often) and
 * checks for other browsers' changes every 30 seconds; the account's copy only
 * as `accountWanted` allows.
 */
let watching = false;
export function watchLibraryData() {
  if (watching) return;
  watching = true;
  void retryPendingUnlink();
  let last = getState();
  subscribe(() => {
    const s = getState();
    const prev = last;
    last = s;
    if (s.playlists !== prev.playlists || s.settings !== prev.settings || s.taste.likes !== prev.taste.likes || s.taste.saves !== prev.taste.saves
      || s.taste.hidden !== prev.taste.hidden || s.taste.hiddenDiscoveries !== prev.taste.hiddenDiscoveries
      || s.shuffle !== prev.shuffle || s.repeat !== prev.repeat || s.speed !== prev.speed || s.trackIds !== prev.trackIds || s.clips !== prev.clips) {
      wantAccount(0);
      schedule(QUICK);
    } else if (s.listens !== prev.listens || s.listenLog !== prev.listenLog || s.taste.listens !== prev.taste.listens) {
      wantAccount(CLOUD_SLOW);
      schedule(SLOW);
    } else if (s.tracks !== prev.tracks) wantAccount(CLOUD_SLOW); // Song details reach the account with the next sync.
  });
  onSlipIns(() => {
    wantAccount(0);
    schedule(QUICK);
  });
  // Mixes are republished unchanged every minute; only a real change is worth contacting the account.
  const mixesNow = () => JSON.stringify(byId(Object.fromEntries(currentMixes().map((m) => [m.id, m]))));
  let lastMixes = mixesNow();
  onMixes(() => {
    const now = mixesNow();
    if (now === lastMixes) return;
    lastMixes = now;
    wantAccount(0);
    schedule(QUICK);
  });
  onPlaybackSpot(() => {
    wantAccount(CLOUD_SLOW);
    schedule(SLOW);
  });
  window.setInterval(() => void syncLibraryData().catch(() => undefined), POLL);
  // Back at the window: catch up with your other devices.
  const back = () => {
    if (!inFront() || Date.now() - accountCheckedAt < CLOUD_ON_FOCUS) return;
    wantAccount(0);
    schedule(QUICK);
  };
  window.addEventListener("focus", back);
  document.addEventListener("visibilitychange", back);
}
