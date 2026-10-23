import { engine } from "../audio/engine";
import { hashString, likedPlaylist, paletteFromSeed } from "../data/library";
import type { ClipRange, Genre, Playlist, Track } from "../data/types";
import { todayKey } from "../lib/format";
import { wakeLive } from "../lib/live";
import { adoptMixes } from "../recommend/mixes";
import { recommend, type RankOptions } from "../recommend/rank";
import {
  countReason, emptyTaste, ListeningCollector, noteLikes, noteSaves, recordListen, setLinks, type Listen, type ReasonKind, type SongLink,
} from "../recommend/taste";
import { deviceUrl, dropFromDevice } from "./device";
import { deleteSong, saveSongChanges } from "./song-api";
import { defaultSettings, flushPersist, getState, setState, snoozedUntil, type AppState, type MenuState, type Modal, type Route, type Settings, type Toast } from "./store";

/* ───────────────────────── selectors ───────────────────────── */

/** Saved on the music server (as opposed to added from this computer, or a streamed suggestion). */
export const isOnServer = (t: Track) => Boolean(t.serverId);

export function isPlayable(t: Track | undefined, s: AppState = getState()) {
  if (!t) return false;
  if (t.storage === "server") return s.server.status === "connected";
  return true;
}

/** Songs that appear in the Library: everything saved, on the music server or added from this computer. */
export function libraryIds(s: AppState) {
  return s.trackIds.filter((id) => s.tracks[id] && !s.tracks[id].stream);
}

export function effectiveRange(id: string, s: AppState = getState()): ClipRange {
  const t = s.tracks[id];
  const duration = t?.duration || 0;
  const r = s.clipDraft?.trackId === id ? s.clipDraft : s.clips[id];
  // A clip that no longer fits (e.g. the length was corrected to something shorter) plays the whole song.
  if (!r || r.end <= r.start || r.start >= duration) return { start: 0, end: duration };
  return { start: Math.max(0, Math.min(r.start, duration)), end: Math.min(duration, Math.max(r.end, r.start + 1)) };
}

export function likedIds(s: AppState) {
  return s.playlists.find((p) => p.id === "liked")?.trackIds ?? [];
}

export function isLiked(id: string, s: AppState = getState()) {
  return likedIds(s).includes(savedStreams.get(id) ?? id);
}

/** Library songs ranked for you (see src/recommend/rank.ts). */
export function recommendations(s: AppState, options: RankOptions = {}) {
  return recommend({ tracks: s.tracks, artists: s.artists, playlists: s.playlists, taste: s.taste, trackIds: s.trackIds, playable: (t) => isPlayable(t, s) }, options);
}

const picksOf = (list: Array<{ id: string; kind: ReasonKind }>) => Object.fromEntries(list.map((r) => [r.id, r.kind]));

/* ───────────────────────── streamed recommendations ───────────────────────── */

/*
 * Recommended songs from outside the library play in full, like any other song,
 * without being added to it. The importer provides the audio (the import API
 * downloads the whole song once and serves it with seeking) and saving to the
 * library; these hooks keep this module free of an import cycle.
 */
/** Where a streamed song plays from. A video can start on its audio, with `picture` (its video, or null if it has none) to follow. */
export interface StreamMedia {
  url: string;
  picture?: Promise<string | null>;
}
interface StreamHooks {
  /** The full song's audio, or its video. */
  source(id: string): Promise<StreamMedia>;
  /** Downloads the song into the library (one at a time, in order), then hands `then` its library id. */
  save(id: string, then?: (libraryId: string) => void): void;
  dismiss(id: string): void;
}
// `var` with no initializer: importer.ts calls connectStreams while this module is still loading
// (actions -> recommend/mixes -> importer), before a `let` here would exist.
var streamHooks: StreamHooks | undefined;
export function connectStreams(hooks: StreamHooks) {
  streamHooks = hooks;
}
/** Streamed songs already saved, and the library copy each became (so the heart stays filled). */
const savedStreams = new Map<string, string>();
export function linkSavedStream(streamId: string, libraryId: string) {
  savedStreams.set(streamId, libraryId);
}
export const saveStream = (id: string, then?: (libraryId: string) => void) => streamHooks?.save(id, then);
const isStream = (id: string) => Boolean(getState().tracks[id]?.stream);
/** Streamed songs join a playlist (or Liked Songs) once they are in the library, since playlists only keep library songs. */
function addStreamsLater(playlistId: string, ids: string[]) {
  for (const id of ids) {
    const saved = savedStreams.get(id);
    if (saved) addToPlaylist(playlistId, [saved], { silent: true });
    else saveStream(id, (libraryId) => addToPlaylist(playlistId, [libraryId], { silent: true }));
  }
}
export const dismissStream = (id: string) => streamHooks?.dismiss(id);

/**
 * Audio fetched for streamed songs. The server's cache turns over, so fetched
 * audio is only reused while the server protects it as the current or next song,
 * and for at most five minutes; it is used once, then fetched (and checked) again.
 */
const streamUrls = new Map<string, { url: string; at: number; usable: boolean }>();
const fetchingStreams = new Map<string, Promise<string>>();
/** Audio a streamed video plays from until its picture is ready. */
const standIns = new Set<string>();
const PROTECT_REFRESH = 60_000;
let protectedTokens = { key: "", at: 0 };

function streamReady(id: string) {
  const ready = streamUrls.get(id);
  return Boolean(ready?.usable && Date.now() - ready.at < 5 * 60_000 && getState().tracks[id]?.mediaUrl === ready.url);
}
const previewToken = (url: string | undefined) => url?.match(/\/api\/import\/preview\/([a-f0-9]{32})$/)?.[1];

/** Asks the server to keep the current and next songs' audio; anything else may be evicted, so it is no longer reused. */
function protectStreams() {
  const s = getState();
  const ids = [s.currentId, peekNext(s)?.id].filter((id): id is string => Boolean(id));
  for (const [id, ready] of streamUrls) if (!ids.includes(id)) ready.usable = false;
  const tokens = [...new Set(ids.map((id) => previewToken(streamUrls.get(id)?.url)).filter((t): t is string => Boolean(t)))];
  // The server's protection lasts ten minutes, so an unchanged set only needs renewing now and then.
  const key = tokens.join(",");
  if (key === protectedTokens.key && Date.now() - protectedTokens.at < PROTECT_REFRESH) return;
  protectedTokens = { key, at: Date.now() };
  void fetch("/api/import/protect", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ tokens }) }).catch(() => {});
}

/** Fetches a streamed song's audio, sharing a fetch already under way. */
function fetchStream(id: string) {
  if (!streamHooks) return Promise.reject(new Error("Streaming is unavailable."));
  const pending = fetchingStreams.get(id);
  if (pending) return pending;
  const task = streamHooks
    .source(id)
    .then(({ url, picture }) => {
      streamUrls.set(id, { url, at: Date.now(), usable: true });
      setState((s) => (s.tracks[id] ? { tracks: { ...s.tracks, [id]: { ...s.tracks[id], mediaUrl: url } } } : {}));
      protectStreams();
      if (picture) {
        standIns.add(url);
        void picture.then((videoUrl) => (videoUrl ? showPicture(id, url, videoUrl) : standIns.delete(url)));
      }
      return url;
    })
    .finally(() => fetchingStreams.delete(id));
  fetchingStreams.set(id, task);
  return task;
}
/** A streamed video's picture is ready: the song switches from its audio to the video, carrying on from where it is. */
function showPicture(id: string, audioUrl: string, videoUrl: string) {
  standIns.delete(audioUrl);
  // Fetched again since, so this picture belongs to an earlier play.
  if (getState().tracks[id]?.mediaUrl !== audioUrl) return;
  const ready = streamUrls.get(id);
  streamUrls.set(id, { url: videoUrl, at: ready?.at ?? Date.now(), usable: ready?.usable ?? true });
  setState((s) => (s.tracks[id] ? { tracks: { ...s.tracks, [id]: { ...s.tracks[id], mediaUrl: videoUrl } } } : {}));
  protectStreams();
  if (engine.loadedTrackId === id && engine.loadedUrl === audioUrl) engine.swap(engineTrack(id));
}

/** Gets the next song's audio ready while this one plays, so a streamed song starts without a wait. */
function prefetchNext() {
  radioHooks?.refill();
  protectStreams();
  const n = peekNext(getState());
  if (n && getState().tracks[n.id]?.stream && !streamReady(n.id)) void fetchStream(n.id).catch(() => undefined);
}
/** The streamed song waiting for its audio, if any. */
let pendingStream: string | null = null;

/* ───────────────────────── recommendations ───────────────────────── */

/** Plays a song, then songs like it. */
export function startRadio(id: string) {
  const s = getState();
  const t = s.tracks[id];
  if (!isPlayable(t, s)) return;
  if (radioHooks) return radioHooks.start([id], t.title);
  const list = recommendations(s, { mode: "radio", seedId: id, limit: 30 });
  playList([id, ...list.map((r) => r.id)], id, { label: `${t.title} Radio`, picks: picksOf(list) });
}

/** Radio with new songs from the web, provided by recommend/radio (which needs this module, so it plugs itself in). */
interface RadioHooks {
  /** Plays a radio built from these songs, named after `name`. */
  start(ids: string[], name: string): void;
  /** Tops up the playing radio if its queue is running low. */
  refill(): void;
  /** Tops up the playing radio now, as its last song ends. */
  finish(): Promise<void>;
}
let radioHooks: RadioHooks | null = null;
export function connectRadio(hooks: RadioHooks) {
  radioHooks = hooks;
}
/** Album, artist and playlist radio. */
export function startCollectionRadio(ids: string[], name: string) {
  radioHooks?.start(ids, name);
}

/** Undo for a hide: puts back that one entry and takes back its one rejection, keeping anything changed since. */
function undoHide(field: "hidden" | "hiddenDiscoveries", key: string, kind: ReasonKind | undefined) {
  const before = getState().taste;
  return () => setState((s) => {
    const entries = { ...s.taste[field] };
    if (before[field][key]) entries[key] = before[field][key];
    else delete entries[key];
    const reasons = { ...s.taste.reasons };
    const counts = kind ? reasons[kind] : undefined;
    if (kind && counts) reasons[kind] = [counts[0], Math.max(0, counts[1] - 1)];
    const taste = { ...s.taste, rev: s.taste.rev + 1, reasons };
    taste[field] = entries;
    return { taste };
  });
}

/** Keeps a song out of recommendations (it still plays everywhere else). `kind` is why it was suggested. */
export function hideRecommendation(id: string, kind?: ReasonKind) {
  const undo = undoHide("hidden", id, kind);
  setState((s) => ({ taste: countReason({ ...s.taste, rev: s.taste.rev + 1, hidden: { ...s.taste.hidden, [id]: Date.now() } }, kind, false) }));
  toast("Hidden from recommendations", { action: { label: "Undo", run: undo } });
}

export function unhideRecommendation(id: string) {
  setState((s) => {
    const hidden = { ...s.taste.hidden };
    delete hidden[id];
    return { taste: { ...s.taste, rev: s.taste.rev + 1, hidden } };
  });
  toast("Back in recommendations");
}

/** Brings back every hidden song and dismissed discovery. */
export function showHiddenRecommendations() {
  setState((s) => ({ taste: { ...s.taste, rev: s.taste.rev + 1, hidden: {}, hiddenDiscoveries: {} } }));
  toast("Hidden suggestions can appear again");
}

/** Dismisses an outside-library suggestion (`key` from songKey). */
export function hideDiscovery(key: string, kind: ReasonKind) {
  const undo = undoHide("hiddenDiscoveries", key, kind);
  setState((s) => ({ taste: countReason({ ...s.taste, rev: s.taste.rev + 1, hiddenDiscoveries: { ...s.taste.hiddenDiscoveries, [key]: Date.now() } }, kind, false) }));
  toast("Suggestion dismissed", { action: { label: "Undo", run: undo } });
}

/** An outside-library suggestion was added: that kind of discovery worked. */
export function keepDiscovery(kind: ReasonKind) {
  setState((s) => ({ taste: countReason(s.taste, kind, true) }));
}

export function rememberSongLinks(links: SongLink[]) {
  if (links.length) setState((s) => ({ taste: setLinks(s.taste, links) }));
}

/** Forgets listening, likes and saves as signals, hidden songs and what was learned. Library and playlists stay. */
export function resetRecommendations() {
  forgetTaste();
  toast("Recommendations reset", { detail: "Your library and playlists are unchanged." });
}

function forgetTaste() {
  collector.clear();
  setState((s) => ({ taste: { ...emptyTaste(s.taste.rev + 1), resetAt: Date.now() }, context: s.context ? { ...s.context, picks: undefined } : null }));
  const current = getState().currentId;
  if (current && getState().isPlaying) startListening(current);
  flushPersist();
}

/**
 * Clears playlists, likes, recently played, settings and recommendations. It's
 * an ordinary change, saved with what was last synced, so it reaches the music
 * server and the account like any other (dropping this window's saved copy
 * instead would just bring it all back). Then the app reloads, so nothing kept
 * in memory (recommended songs, mixes) survives. Songs stay.
 */
export function resetAppData() {
  setState({
    playlists: [likedPlaylist()],
    settings: { ...defaultSettings },
    listens: [],
    upNext: [],
    history: [],
  });
  adoptMixes([]);
  forgetTaste();
  // Recommended songs (recommend/useDiscovery.ts) are kept only on this device.
  localStorage.removeItem("slopify.discovery.v1");
  location.reload();
}

/* ───────────────────────── navigation ───────────────────────── */

const sameRoute = (a: Route, b: Route) => JSON.stringify(a) === JSON.stringify(b);

/** Below 1240px the side panel floats over the page (full screen on phones), so going somewhere closes it. */
const closeFloatingPanel = (): Partial<AppState> => (window.matchMedia("(max-width: 1240px)").matches ? { panel: null } : {});

/*
 * How far down each page in the back and forward history was scrolled, so Back
 * and Forward return there. Kept beside `back` and `forward`, newest last and
 * first; this session only.
 */
let readScroll: () => number = () => 0;
const backScroll: number[] = [];
let forwardScroll: number[] = [];
let scrollToRestore: number | null = null;
/** The page's scroll position, read when you leave it (App.tsx). */
export function trackScroll(read: () => number) {
  readScroll = read;
}
/** Where the page just opened should be scrolled to, if it's one you came back to. Read once. */
export function takeScrollRestore() {
  const top = scrollToRestore;
  scrollToRestore = null;
  return top;
}

export function navigate(route: Route) {
  const s = getState();
  if (sameRoute(s.route, route)) return;
  // Typing in search replaces the current search entry instead of stacking history.
  if (route.name === "search" && s.route.name === "search") {
    setState({ route });
    return;
  }
  backScroll.push(readScroll());
  if (backScroll.length > 50) backScroll.shift();
  forwardScroll = [];
  scrollToRestore = null;
  setState({ route, back: [...s.back, s.route].slice(-50), forward: [], selection: [], menu: null, ...closeFloatingPanel() });
}

export function goBack() {
  const s = getState();
  const prev = s.back[s.back.length - 1];
  if (!prev) return;
  forwardScroll.unshift(readScroll());
  scrollToRestore = backScroll.pop() ?? null;
  setState({ route: prev, back: s.back.slice(0, -1), forward: [s.route, ...s.forward], selection: [], ...closeFloatingPanel() });
}

export function goForward() {
  const s = getState();
  const next = s.forward[0];
  if (!next) return;
  backScroll.push(readScroll());
  scrollToRestore = forwardScroll.shift() ?? null;
  setState({ route: next, forward: s.forward.slice(1), back: [...s.back, s.route], selection: [], ...closeFloatingPanel() });
}

/* ───────────────────────── toasts / menus / modals ───────────────────────── */

let toastSeq = 1;
const toastTimers = new Map<number, number>();

export function toast(message: string, opts: Omit<Toast, "id" | "message"> & { duration?: number } = {}) {
  const id = toastSeq++;
  const { duration = 4200, ...rest } = opts;
  setState((s) => ({ toasts: [...s.toasts.slice(-3), { id, message, ...rest }] }));
  if (!rest.sticky) toastTimers.set(id, window.setTimeout(() => dismissToast(id), duration));
  return id;
}

export function updateToast(id: number, patch: Partial<Toast>, dismissAfter?: number) {
  setState((s) => ({ toasts: s.toasts.map((t) => (t.id === id ? { ...t, ...patch } : t)) }));
  if (dismissAfter) {
    clearTimeout(toastTimers.get(id));
    toastTimers.set(id, window.setTimeout(() => dismissToast(id), dismissAfter));
  }
}

export function dismissToast(id: number) {
  clearTimeout(toastTimers.get(id));
  toastTimers.delete(id);
  setState((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }));
}

let menuOpener: HTMLElement | null = null;

/** Opens a menu, remembering the element that had focus so it can get it back on close. */
export function openMenu(menu: MenuState) {
  if (!getState().menu) menuOpener = document.activeElement as HTMLElement | null;
  setState({ menu });
}

export function takeMenuOpener() {
  const el = menuOpener;
  menuOpener = null;
  return el;
}
export const closeMenu = () => setState({ menu: null });

/** Finding new music happens in Search (songs, artists and pasted links), so this opens it with the search box focused. */
export function findMusic() {
  navigate({ name: "search", q: "" });
  setState((s) => ({ menu: null, searchFocusNonce: s.searchFocusNonce + 1 }));
}

let modalOpener: HTMLElement | null = null;

/**
 * Opens a dialog. The opener is recorded now because the dialog mounts a frame
 * later, after the background has been made inert (which drops focus to BODY).
 * When opened from a menu item, the menu's own opener is used instead.
 */
export function openModal(modal: Modal) {
  if (!getState().modal) {
    const active = document.activeElement as HTMLElement | null;
    modalOpener = active?.closest(".menu-layer") ? menuOpener : active;
  }
  setState({ modal, menu: null });
}

/** Read (not consumed) so React StrictMode's double-run of effects sees the same opener. */
export function modalOpenerElement() {
  return modalOpener;
}
export function closeModal() {
  const s = getState();
  setState({ modal: null, clipDraft: null });
  if (s.clipDraft && s.currentId === s.clipDraft.trackId) syncEngineEnd();
  // A clip preview still playing when the editor closes becomes ordinary listening from here.
  if (previewing && s.modal?.type === "clipEditor") {
    previewing = false;
    if (s.isPlaying && s.currentId) startListening(s.currentId);
  }
}

export function updateSettings(patch: Partial<Settings>) {
  setState((s) => ({ settings: { ...s.settings, ...patch } }));
  applyEngineSettings();
}

/* ───────────────────────── playback ───────────────────────── */

function shuffled(ids: string[], first?: string) {
  const rest = ids.filter((id) => id !== first);
  for (let i = rest.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [rest[i], rest[j]] = [rest[j], rest[i]];
  }
  return first ? [first, ...rest] : rest;
}

/** Where a song's file can be read from now (this session's file, this device's copy, or the music server), if anywhere. */
export function mediaUrlOf(id: string) {
  const t = getState().tracks[id];
  return t ? (t.fileUrl ?? deviceUrl(id) ?? t.mediaUrl) : undefined;
}

function engineTrack(id: string) {
  const s = getState();
  const t = s.tracks[id];
  // This session's file, else this device's kept copy, else the music server.
  const fileUrl = t.fileUrl ?? deviceUrl(id) ?? t.mediaUrl;
  return { id, fileUrl, video: Boolean(fileUrl) && t.kind === "video" && !standIns.has(fileUrl!) };
}

/* Listening credit: what was actually heard of each playback, for recommendations. */
const collector = new ListeningCollector();
/** A clip preview is not a listen; nothing is recorded until normal playback resumes. */
let previewing = false;
/** The server song whose playback failed and was tried again; a second failure moves on. */
let retriedError: string | null = null;
/** Songs that failed one after another, with nothing played in between; coming back round to one stops playback. */
const failedInRow = new Set<string>();
let lastListenSave = 0;

function saveListening(end: Listen["end"] = "playing") {
  const listen = collector.listen;
  if (!listen || listen.heard <= 0) return;
  setState((s) => ({ taste: recordListen(s.taste, { ...listen, end }) }));
  lastListenSave = performance.now();
}

function finishListening(end: Listen["end"]) {
  saveListening(end);
  collector.clear();
}

function startListening(id: string) {
  const s = getState();
  if (previewing || s.clipDraft || s.listen.mode === "guest") return;
  const range = effectiveRange(id, s);
  const via = s.context?.picks?.[id];
  collector.start({
    id: `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`,
    trackId: id,
    at: Date.now(),
    heard: 0,
    covered: 0,
    span: Math.max(1, range.end - range.start),
    end: "playing",
    ...(via ? { via } : {}),
  });
  lastListenSave = performance.now();
}

/* Slip-ins (slipins.ts): marked songs played now and then between the songs you play. */
interface SlipInHooks {
  /** A slip-in to play before `nextId`, or null. */
  pick(s: AppState, nextId: string): string | null;
  /** How a slipped-in song's playback ended. */
  ended(id: string, end: Listen["end"], listen: Listen | null): void;
  playing(id: string, slipped: boolean): void;
  forget(ids: string[]): void;
}
let slipHooks: SlipInHooks | null = null;
export function connectSlipIns(hooks: SlipInHooks) {
  slipHooks = hooks;
}
/** The song playing now was slipped in. */
let slippedIn: string | null = null;

/** `end` says how the previous song's playback ended. */
function load(id: string, { autoplay = true, crossfade = 0, remember = true, end = "changed" as Listen["end"], preview = false, slip = false } = {}) {
  const s = getState();
  const t = s.tracks[id];
  if (!t) return;
  if (end !== "error") failedInRow.clear();
  pendingStream = null;
  if (s.buffering) setState({ buffering: null });
  engine.captureProgress();
  // Any new start ends a slipped-in playback, including choosing that same song yourself.
  if (slippedIn && s.currentId === slippedIn) slipHooks?.ended(slippedIn, end, collector.listen);
  finishListening(end);
  if (t.stream && !streamReady(id)) {
    // The song shows as current (buffering) while its audio is fetched, then plays from the start.
    engine.unload();
    pendingStream = id;
    setState((st) => ({
      currentId: id,
      isPlaying: autoplay,
      buffering: id,
      history: remember && st.currentId && st.currentId !== id ? [st.currentId, ...st.history].slice(0, 50) : st.history,
    }));
    updateMediaSession();
    fetchStream(id).then(
      () => {
        if (pendingStream !== id) return;
        pendingStream = null;
        setState({ buffering: null });
        load(id, { autoplay, remember: false, preview, slip });
      },
      (error: { message?: string } | null) => {
        if (pendingStream !== id) return;
        pendingStream = null;
        setState({ buffering: null, isPlaying: false });
        toast(`Couldn't play “${t.title}”`, { tone: "error", detail: error?.message || "Its source isn't available right now." });
        advance({ auto: true, end: "error" });
      },
    );
    return;
  }
  previewing = preview;
  if (slip) {
    slippedIn = id;
    slipHooks?.playing(id, true);
  } else if (slippedIn) {
    slippedIn = null;
    slipHooks?.playing(id, false);
  }
  // Consume a prefetched URL once. Replaying asks the server to verify its cached file again.
  const readyStream = streamUrls.get(id);
  if (t.stream && readyStream) readyStream.usable = false;
  const range = effectiveRange(id, s);
  engine.load(engineTrack(id), { start: range.start, end: range.end || t.duration || 1e9, autoplay, crossfade });
  if (cued?.id === id) engine.seek(cued.position);
  cued = null;
  startListening(id);
  const prev = s.currentId;
  setState((st) => ({
    currentId: id,
    isPlaying: autoplay,
    // Every occurrence is kept so Previous can walk back through repeats.
    history: remember && prev && prev !== id ? [prev, ...st.history].slice(0, 50) : st.history,
    tracks: { ...st.tracks, [id]: { ...t, plays: t.plays + 1 } },
    listens: [{ id, at: Date.now() }, ...st.listens].slice(0, 300),
  }));
  updateMediaSession();
  prefetchNext();
}

/** Starts playing `ids` from `startId`, remembering where playback came from. */
export function playList(ids: string[], startId?: string, ctx?: { label: string; route?: Route; picks?: Record<string, ReasonKind>; radioKey?: string }) {
  const s = getState();
  if (listenLocked()) return;
  const playable = ids.filter((id) => isPlayable(s.tracks[id], s));
  if (!playable.length) {
    toast("Nothing playable here", { detail: s.server.status !== "connected" ? "Connect to your music server to stream these songs." : undefined });
    return;
  }
  // Snoozed songs only start when chosen; the list skips them as it plays.
  const awake = playable.filter((id) => !snoozedUntil(s, id));
  if (!awake.length && !(startId && playable.includes(startId))) {
    toast(playable.length === 1 ? "This song is snoozed" : "Every song here is snoozed", { detail: "Play one yourself, or stop snoozing them from its menu." });
    return;
  }
  const first = startId && playable.includes(startId) ? startId : s.shuffle ? awake[Math.floor(Math.random() * awake.length)] : awake[0];
  const order = s.shuffle ? shuffled(playable, first) : playable;
  setState({
    context: { label: ctx?.label ?? "Library", route: ctx?.route, ids: playable, picks: ctx?.picks, radioKey: ctx?.radioKey },
    order,
    index: order.indexOf(first),
  });
  load(first);
}

/** A song shown paused where it was left (on this device or another), started from there when played. */
let cued: { id: string; position: number } | null = null;

/**
 * Puts a song where it was left, paused, with the list it was playing from, so
 * Play carries on from there. Nothing is loaded (or counted as a play) until then.
 */
export function cueSong(id: string, position: number, ctx?: { label: string; route?: Route; ids: string[] }) {
  const s = getState();
  if (s.isPlaying || listenLocked() || !isPlayable(s.tracks[id], s)) return false;
  if (s.currentId && s.currentId !== id) finishListening("changed");
  const listed = (ctx?.ids ?? []).filter((x) => isPlayable(s.tracks[x], s));
  const ids = listed.includes(id) ? listed : [id];
  const order = s.shuffle ? shuffled(ids, id) : ids;
  cued = { id, position: Math.max(0, position) };
  setState({ currentId: id, isPlaying: false, context: { label: ctx?.label ?? "Library", route: ctx?.route, ids }, order, index: order.indexOf(id) });
  updateMediaSession();
  return true;
}

/** Where a song is: the playing position, or where a cued song will start. */
export const positionOf = (id: string) => (cued?.id === id ? cued.position : engine.loadedTrackId === id ? engine.position : 0);

/**
 * Brings the queue up to date when a list still filling in (a release finding its
 * songs) is the one playing: the new songs join in list order, and the current
 * song carries on uninterrupted.
 */
export function extendContext(route: Route, ids: string[]) {
  const s = getState();
  if (!s.context || !s.currentId || JSON.stringify(s.context.route) !== JSON.stringify(route)) return;
  const playable = ids.filter((id) => isPlayable(s.tracks[id], s));
  const added = playable.filter((id) => !s.context!.ids.includes(id));
  if (!added.length || !playable.includes(s.currentId)) return;
  const order = s.shuffle ? [...s.order, ...added] : playable;
  setState({ context: { ...s.context, ids: playable }, order, index: order.indexOf(s.currentId) });
}

export function playTrackNow(id: string) {
  if (listenLocked()) return;
  const s = getState();
  if (!isPlayable(s.tracks[id], s)) return;
  setState({ upNext: [id, ...s.upNext] });
  advance();
}

export function togglePlay() {
  const s = getState();
  if (listenLocked()) return;
  if (pendingStream && pendingStream === s.currentId) {
    // Paused before its audio arrived: stop waiting. Play fetches it again (quickly, from the server's copy).
    pendingStream = null;
    setState({ isPlaying: false, buffering: null });
    updateMediaSession();
    return;
  }
  if (!s.currentId) {
    const liked = likedIds(s);
    playList(liked.length ? liked : libraryIds(s), undefined, { label: "Liked Songs", route: { name: "playlist", id: "liked" } });
    return;
  }
  if (!s.isPlaying && !isPlayable(s.tracks[s.currentId], s)) {
    toast("This song isn't available right now", { detail: "Connect to your music server to stream it." });
    return;
  }
  if (engine.loadedTrackId !== s.currentId) {
    load(s.currentId);
    return;
  }
  if (s.isPlaying) {
    engine.pause();
    saveListening();
  } else {
    // Cued from where it was left (possibly elsewhere) while already loaded here: carry on from there.
    if (cued?.id === s.currentId) {
      engine.seek(cued.position);
      cued = null;
    }
    // Playing on after a clip preview counts again, from here.
    if (previewing && !s.clipDraft) {
      previewing = false;
      startListening(s.currentId);
    }
    engine.play();
    if (!collector.listen) startListening(s.currentId);
  }
  setState({ isPlaying: !s.isPlaying });
  updateMediaSession();
}

/**
 * Finds the next playable song: manual queue first, then the collection order.
 * Songs that became unavailable (e.g. server went offline) are skipped, and so
 * are snoozed songs in the collection (queued ones were chosen, so they play).
 */
function peekNext(s: AppState) {
  for (let i = 0; i < s.upNext.length; i++) {
    if (isPlayable(s.tracks[s.upNext[i]], s)) return { id: s.upNext[i], upNextSkip: i + 1, index: s.index };
  }
  const n = s.order.length;
  const now = Date.now();
  for (let step = 1; step <= n; step++) {
    const raw = s.index + step;
    if (raw >= n && s.repeat !== "all") break;
    const index = raw % n;
    if (isPlayable(s.tracks[s.order[index]], s) && !snoozedUntil(s, s.order[index], now)) return { id: s.order[index], upNextSkip: s.upNext.length, index };
  }
  return null;
}

export function nextTrackId() {
  return peekNext(getState())?.id ?? null;
}

function stopAtEnd(s: AppState) {
  engine.pause();
  engine.seek(effectiveRange(s.currentId ?? "", s).start);
  setState({ isPlaying: false });
  updateMediaSession();
}

function advance({ crossfade = 0, auto = false, end = "changed" as Listen["end"] } = {}) {
  const s = getState();
  const n = peekNext(s);
  if (!n) {
    // A radio's last song: top it up and carry on, or stop if nothing more was found.
    if (auto && s.context?.radioKey && radioHooks && s.isPlaying) {
      const key = s.context.radioKey;
      const id = s.currentId;
      void radioHooks.finish().then(() => {
        const st = getState();
        if (st.context?.radioKey !== key || st.currentId !== id || !st.isPlaying) return;
        if (peekNext(st)) return advance({ crossfade, auto, end });
        finishListening(end);
        stopAtEnd(st);
      });
      return;
    }
    if (auto && s.settings.autoplay && s.currentId && s.listen.mode !== "guest") {
      // Songs like the one that just ended, skipping what was just played or is still queued.
      const seed = s.tracks[s.currentId];
      const snoozed = Object.keys(s.settings.snoozed ?? {}).filter((id) => snoozedUntil(s, id));
      const list = recommendations(s, { mode: "autoplay", seedId: s.currentId, exclude: [...s.upNext, ...s.history.slice(0, 20), ...snoozed], limit: 30 });
      if (list.length) {
        const ids = list.map((r) => r.id);
        toast("Autoplay is on", { detail: `Playing songs like “${seed.title}”.` });
        setState({ context: { label: `Autoplay · ${seed.title}`, ids, picks: picksOf(list) }, order: ids, index: 0, upNext: [] });
        load(ids[0], { crossfade, end });
        return;
      }
    }
    if (auto) {
      finishListening(end);
      stopAtEnd(s);
    }
    else if (s.currentId) toast("End of queue", { detail: "Turn on repeat or add more songs." });
    return;
  }
  // Queued songs are dropped up to (and including) the one we play; unplayable ones are discarded too.
  const fromUpNext = n.upNextSkip > 0 && s.upNext[n.upNextSkip - 1] === n.id;
  // A slip-in plays before the list's next song, which then follows it: the list's place doesn't move.
  // Songs you queued yourself are never held up for one.
  const slip = !fromUpNext && !previewing && !s.clipDraft ? slipHooks?.pick(s, n.id) : null;
  if (slip) {
    setState({ upNext: [] });
    load(slip, { crossfade, end, slip: true });
    return;
  }
  setState({ upNext: fromUpNext ? s.upNext.slice(n.upNextSkip) : [], index: n.index });
  load(n.id, { crossfade, end });
}

export function next() {
  if (listenLocked()) return;
  advance({ end: "skipped" });
}

/** Goes back to the song that actually played before this one (not just the previous index). */
export function previous() {
  if (listenLocked()) return;
  const s = getState();
  if (!s.currentId) return;
  const start = effectiveRange(s.currentId, s).start;
  if (engine.position - start > 3) {
    seek(start);
    return;
  }
  const prevIdx = s.history.findIndex((id) => isPlayable(s.tracks[id], s));
  if (prevIdx >= 0) {
    const id = s.history[prevIdx];
    // Keep the collection cursor in sync when the song belongs to it.
    let index = s.index;
    for (let d = 0; d < s.order.length; d++) {
      if (s.order[s.index - d] === id) { index = s.index - d; break; }
      if (s.order[s.index + d] === id) { index = s.index + d; break; }
    }
    setState({ history: s.history.slice(prevIdx + 1), index });
    load(id, { remember: false });
    return;
  }
  seek(start);
}

export function seek(seconds: number) {
  if (listenLocked()) return;
  const s = getState();
  if (cued && cued.id === s.currentId) {
    cued = { ...cued, position: Math.max(0, seconds) };
    // Nothing of it is loaded yet (another song may be): it starts from here when played.
    if (engine.loadedTrackId !== cued.id) return wakeLive();
    cued = null;
  }
  engine.seek(seconds);
  updatePositionState();
}

export function jumpToOrderIndex(index: number) {
  if (listenLocked()) return;
  const s = getState();
  const id = s.order[index];
  if (!id) return;
  if (!isPlayable(s.tracks[id], s)) {
    toast("That song isn't available right now", { detail: "Connect to your music server to stream it." });
    return;
  }
  setState({ index });
  load(id);
}

export function jumpToUpNext(index: number) {
  if (listenLocked()) return;
  const s = getState();
  const id = s.upNext[index];
  if (!id) return;
  if (!isPlayable(s.tracks[id], s)) {
    toast("That song isn't available right now", { detail: "Connect to your music server to stream it." });
    return;
  }
  setState({ upNext: s.upNext.slice(index + 1) });
  load(id);
}

export function removeFromUpNext(index: number) {
  setState((s) => ({ upNext: s.upNext.filter((_, i) => i !== index) }));
}

export function clearUpNext() {
  setState({ upNext: [] });
}

export function addToQueue(ids: string[]) {
  const s = getState();
  const ok = ids.filter((id) => isPlayable(s.tracks[id], s));
  if (!ok.length) return;
  setState({ upNext: [...s.upNext, ...ok] });
  toast(ok.length === 1 ? "Added to queue" : `${ok.length} songs added to queue`, { tone: "success" });
}

export function playNext(ids: string[]) {
  const s = getState();
  const ok = ids.filter((id) => isPlayable(s.tracks[id], s));
  if (!ok.length) return;
  setState({ upNext: [...ok, ...s.upNext] });
  toast(ok.length === 1 ? "Playing next" : `${ok.length} songs playing next`, { tone: "success" });
}

export function toggleShuffle() {
  const s = getState();
  const on = !s.shuffle;
  if (s.context && s.currentId) {
    const ids = s.context.ids;
    const inCollection = ids.includes(s.currentId);
    const order = on ? shuffled(ids, inCollection ? s.currentId : undefined) : ids;
    // A queued song from outside the collection leaves the cursor on the collection song it interrupted
    // (-1 = before the first song, so Next plays order[0]).
    const index = inCollection ? order.indexOf(s.currentId) : on ? -1 : order.indexOf(s.order[s.index]);
    setState({ shuffle: on, order, index });
  } else setState({ shuffle: on });
}

let repeatToast = -1;

/** Off → loop this song → repeat the whole collection → off. Looping the song comes first: it is what a loop button usually means. */
export function cycleRepeat() {
  setState((s) => ({ repeat: s.repeat === "off" ? "one" : s.repeat === "one" ? "all" : "off" }));
  applyEngineSettings();
  const s = getState();
  const title = s.currentId ? s.tracks[s.currentId]?.title : undefined;
  const label = s.context?.label;
  const [message, detail] =
    s.repeat === "one" ? [title ? `Looping “${title}”` : "Looping this song", `Press again to repeat ${label ?? "the whole queue"}.`]
    : s.repeat === "all" ? [`Repeating ${label ?? "the queue"}`, "Press again to turn repeat off."]
    : ["Repeat off", undefined];
  // Rapid presses update one toast instead of stacking three.
  if (getState().toasts.some((t) => t.id === repeatToast)) updateToast(repeatToast, { message, detail }, 2600);
  else repeatToast = toast(message, { detail, duration: 2600 });
}

export function setVolume(volume: number) {
  const v = Math.max(0, Math.min(1, volume));
  setState({ volume: v, muted: v === 0 });
  engine.setVolume(v, v === 0);
}

export function toggleMute() {
  const s = getState();
  const muted = !s.muted;
  const volume = !muted && s.volume === 0 ? 0.5 : s.volume;
  setState({ muted, volume });
  engine.setVolume(volume, muted);
}

export function setSpeed(speed: number) {
  setState({ speed });
  engine.setRate(speed);
  updatePositionState();
}

export function syncEngineEnd() {
  const s = getState();
  if (!s.currentId) return;
  const t = s.tracks[s.currentId];
  const r = effectiveRange(s.currentId, s);
  engine.setRange(r.start, r.end || t.duration || 1e9);
}

export function applyEngineSettings() {
  const s = getState();
  engine.lead = s.settings.crossfade && s.repeat !== "one" ? s.settings.crossfadeSeconds : 0;
  engine.setNormalize(s.settings.normalize);
  engine.setTone({ ...defaultSettings.tone, ...s.settings.tone });
}

/* ───────────────────────── library mutations ───────────────────────── */

function updatePlaylist(id: string, fn: (p: Playlist) => Playlist) {
  setState((s) => ({ playlists: s.playlists.map((p) => (p.id === id ? fn(p) : p)) }));
}

/* Likes and saves made here are taste signals; each counts only while the song stays liked or saved. */
const noteLiked = (ids: string[]) => setState((s) => ({ taste: noteLikes(s.taste, ids) }));
const noteSaved = (playlistId: string, ids: string[]) => setState((s) => ({ taste: noteSaves(s.taste, playlistId, ids) }));

export function toggleLike(id: string) {
  const saved = savedStreams.get(id);
  if (saved) return toggleLike(saved);
  if (isStream(id)) {
    addStreamsLater("liked", [id]);
    return;
  }
  const liked = isLiked(id);
  updatePlaylist("liked", (p) => ({ ...p, trackIds: liked ? p.trackIds.filter((t) => t !== id) : [id, ...p.trackIds] }));
  if (!liked) noteLiked([id]);
  toast(liked ? "Removed from Liked Songs" : "Added to Liked Songs", {
    tone: liked ? "default" : "success",
    action: { label: "Undo", run: () => toggleLike(id) },
  });
}

export function likeMany(ids: string[]) {
  // Streamed songs join the library first, then get liked.
  const streamed = ids.filter((id) => isStream(id) && !savedStreams.has(id));
  addStreamsLater("liked", streamed);
  ids = ids.filter((id) => !streamed.includes(id)).map((id) => savedStreams.get(id) ?? id);
  if (!ids.length) return;
  const set = new Set(likedIds(getState()));
  const fresh = ids.filter((id) => !set.has(id));
  updatePlaylist("liked", (p) => ({ ...p, trackIds: [...fresh, ...p.trackIds] }));
  noteLiked(fresh);
  toast(`${fresh.length} songs added to Liked Songs`, { tone: "success" });
}

export function createPlaylist(name: string, ids: string[] = [], description = "") {
  const id = `p${Date.now().toString(36)}`;
  const streamed = ids.filter(isStream);
  const playlist: Playlist = {
    id,
    name: name.trim() || "My Playlist",
    description,
    trackIds: [...new Set(ids.filter((t) => !isStream(t)))],
    createdAt: Date.now(),
    palette: paletteFromSeed(hashString(id + name)),
  };
  setState((s) => ({ playlists: [...s.playlists, playlist] }));
  noteSaved(id, playlist.trackIds);
  addStreamsLater(id, streamed);
  return id;
}

export function editPlaylist(id: string, patch: Pick<Playlist, "name" | "description">) {
  updatePlaylist(id, (p) => ({ ...p, ...patch }));
}

export function deletePlaylist(id: string) {
  const s = getState();
  const index = s.playlists.findIndex((p) => p.id === id);
  const playlist = s.playlists[index];
  if (!playlist || playlist.system) return;
  setState({ playlists: s.playlists.filter((p) => p.id !== id) });
  if (s.route.name === "playlist" && s.route.id === id) navigate({ name: "playlists" });
  toast(`Deleted “${playlist.name}”`, {
    action: {
      label: "Undo",
      run: () => setState((st) => {
        const list = [...st.playlists];
        list.splice(Math.min(index, list.length), 0, playlist);
        return { playlists: list };
      }),
    },
  });
}

export function addToPlaylist(playlistId: string, ids: string[], { silent = false } = {}) {
  const s = getState();
  const p = s.playlists.find((pl) => pl.id === playlistId);
  if (!p) return;
  const streamed = ids.filter(isStream);
  if (streamed.length) {
    addStreamsLater(playlistId, streamed);
    ids = ids.filter((id) => !isStream(id));
    if (!ids.length) {
      if (!silent) toast(streamed.length === 1 ? "Adding it to your library first" : `Adding ${streamed.length} songs to your library first`, { detail: `Then they join “${p.name}”.` });
      return;
    }
  }
  const existing = new Set(p.trackIds);
  const fresh = ids.filter((id) => !existing.has(id));
  updatePlaylist(playlistId, (pl) => ({ ...pl, trackIds: [...pl.trackIds, ...fresh] }));
  if (playlistId === "liked") noteLiked(fresh);
  else noteSaved(playlistId, fresh);
  if (silent) return;
  if (!fresh.length) toast(`Already in “${p.name}”`);
  else toast(fresh.length === 1 ? `Added to “${p.name}”` : `${fresh.length} songs added to “${p.name}”`, { tone: "success" });
}

/** Puts ids back at their old positions without discarding edits made since. */
function reinsert(list: string[], removed: Array<{ id: string; index: number }>) {
  const out = [...list];
  for (const { id, index } of [...removed].sort((a, b) => a.index - b.index)) {
    if (!out.includes(id)) out.splice(Math.min(index, out.length), 0, id);
  }
  return out;
}

export function removeFromPlaylist(playlistId: string, ids: string[]) {
  const s = getState();
  const p = s.playlists.find((pl) => pl.id === playlistId);
  if (!p) return;
  const drop = new Set(ids);
  const removed = p.trackIds.map((id, index) => ({ id, index })).filter((x) => drop.has(x.id));
  updatePlaylist(playlistId, (pl) => ({ ...pl, trackIds: pl.trackIds.filter((id) => !drop.has(id)) }));
  setState({ selection: [] });
  toast(ids.length === 1 ? `Removed from “${p.name}”` : `${ids.length} songs removed`, {
    action: { label: "Undo", run: () => updatePlaylist(playlistId, (pl) => ({ ...pl, trackIds: reinsert(pl.trackIds, removed) })) },
  });
}

/** Moves `id` so it sits just before `beforeId` (or at the end when null). */
export function moveInPlaylist(playlistId: string, id: string, beforeId: string | null) {
  if (id === beforeId) return;
  updatePlaylist(playlistId, (p) => {
    const ids = p.trackIds.filter((x) => x !== id);
    const at = beforeId ? ids.indexOf(beforeId) : ids.length;
    if (at < 0) return p;
    ids.splice(at, 0, id);
    return { ...p, trackIds: ids };
  });
}

const pendingRevokes = new Map<string, number>();
/** Imported songs whose server copy is deleted once the undo window closes, keyed by server id. */
const pendingServerDeletes = new Map<string, number>();

/** Server deletes not yet confirmed, kept across reloads so a failed one is retried instead of the song coming back. */
const UNCONFIRMED_DELETES_KEY = "slopify.unconfirmedServerDeletes";
function unconfirmedDeletes(): string[] {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(UNCONFIRMED_DELETES_KEY) ?? "[]");
    return Array.isArray(value) ? value.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}
function setUnconfirmedDeletes(ids: string[]) {
  try {
    if (ids.length) localStorage.setItem(UNCONFIRMED_DELETES_KEY, JSON.stringify(ids));
    else localStorage.removeItem(UNCONFIRMED_DELETES_KEY);
  } catch {
    // Storage blocked: the delete is still attempted, just not retried.
  }
}

function deleteOnServer(serverId: string) {
  clearTimeout(pendingServerDeletes.get(serverId));
  pendingServerDeletes.delete(serverId);
  // Recorded first: on page exit the response may never be seen.
  setUnconfirmedDeletes([...new Set([...unconfirmedDeletes(), serverId])]);
  void deleteSong(serverId, { keepalive: true })
    .then(() => setUnconfirmedDeletes(unconfirmedDeletes().filter((id) => id !== serverId)))
    .catch(() => undefined);
}

/** Retries server deletes that never got confirmed (run once the import API answers at startup). */
export function retryServerDeletes() {
  for (const serverId of unconfirmedDeletes()) deleteOnServer(serverId);
}

export function isServerDeletePending(serverId: string) {
  return pendingServerDeletes.has(serverId) || unconfirmedDeletes().includes(serverId);
}

/** A re-import of a song that is waiting to be deleted keeps the server copy. */
export function cancelServerDelete(serverId: string) {
  clearTimeout(pendingServerDeletes.get(serverId));
  pendingServerDeletes.delete(serverId);
  const unconfirmed = unconfirmedDeletes();
  if (unconfirmed.includes(serverId)) setUnconfirmedDeletes(unconfirmed.filter((id) => id !== serverId));
}

/**
 * Removes songs from this device. Songs added from this computer disappear
 * entirely; songs saved on the music server keep streaming from it. Undo
 * restores them.
 */
export function deleteFromDevice(ids: string[]) {
  const s = getState();
  const affected = ids.map((id) => s.tracks[id]).filter((t) => t && (t.storage === "files" || t.storage === "downloads"));
  removeSongs(affected.filter((t) => t.storage === "files"), affected.filter((t) => t.storage === "downloads").map((t) => t.id), {
    one: (t) => `Removed “${t.title}” from this device`,
    many: (n) => `${n} songs removed from this device`,
  });
}

/** Deletes songs from the library: from the music server too, after the undo window. */
export function deleteFromLibrary(ids: string[]) {
  const s = getState();
  removeSongs(ids.map((id) => s.tracks[id]).filter((t) => t && !t.stream), [], {
    one: (t) => `Deleted “${t.title}”`,
    many: (n) => `${n} songs deleted`,
  });
}

/**
 * `affected` leave the library (server songs are deleted from the server once
 * the undo window passes); `demoted` only lose this device's copy and stream again.
 */
function removeSongs(affected: Track[], demoted: string[], text: { one: (t: Track) => string; many: (n: number) => string }) {
  const s = getState();
  if (!affected.length && !demoted.length) return;
  const removed = new Set(affected.map((t) => t.id));
  const keep = (id: string) => !removed.has(id);

  const record = {
    tracks: affected,
    trackIndex: s.trackIds.map((id, index) => ({ id, index })).filter((x) => removed.has(x.id)),
    playlists: Object.fromEntries(s.playlists.map((p) => [p.id, p.trackIds.map((id, index) => ({ id, index })).filter((x) => removed.has(x.id))])),
    demoted,
  };

  const tracks = { ...s.tracks };
  for (const id of removed) delete tracks[id];
  for (const id of demoted) tracks[id] = { ...tracks[id], storage: "server", onlyStream: true };

  const wasCurrent = Boolean(s.currentId && removed.has(s.currentId));
  if (wasCurrent) engine.unload();
  const order = s.order.filter(keep);
  // Cursor = last surviving entry at or before the old cursor (-1 if none), so Next plays the following survivor.
  const index = s.order.slice(0, s.index + 1).filter(keep).length - 1;
  setState({
    tracks,
    trackIds: s.trackIds.filter(keep),
    playlists: s.playlists.map((p) => ({ ...p, trackIds: p.trackIds.filter(keep) })),
    selection: [],
    upNext: s.upNext.filter(keep),
    history: s.history.filter(keep),
    order,
    index,
    context: s.context ? { ...s.context, ids: s.context.ids.filter(keep) } : null,
    ...(wasCurrent ? { currentId: null, isPlaying: false } : {}),
  });
  if (wasCurrent && "mediaSession" in navigator) {
    navigator.mediaSession.metadata = null;
    navigator.mediaSession.playbackState = "none";
  }

  // Once the undo window has passed: free this session's file blobs, forget device copies, delete server songs.
  const later = (id: string, run: () => void) => pendingRevokes.set(id, window.setTimeout(() => {
    run();
    pendingRevokes.delete(id);
  }, 15_000));
  for (const t of record.tracks) {
    later(t.id, () => {
      if (t.fileUrl) URL.revokeObjectURL(t.fileUrl);
      if (t.storage === "downloads") void dropFromDevice(t.id);
    });
    if (!t.serverId) continue;
    const serverId = t.serverId;
    clearTimeout(pendingServerDeletes.get(serverId));
    pendingServerDeletes.set(serverId, window.setTimeout(() => deleteOnServer(serverId), 15_000));
  }
  for (const id of demoted) later(id, () => void dropFromDevice(id));

  const undo = () => {
    for (const id of [...removed, ...demoted]) {
      clearTimeout(pendingRevokes.get(id));
      pendingRevokes.delete(id);
    }
    for (const t of record.tracks) if (t.serverId) cancelServerDelete(t.serverId);
    setState((st) => {
      const tr = { ...st.tracks };
      for (const t of record.tracks) tr[t.id] = t;
      for (const id of record.demoted) {
        if (tr[id]?.storage !== "server") continue;
        const { onlyStream: _onlyStream, ...rest } = tr[id];
        tr[id] = { ...rest, storage: "downloads" };
      }
      return {
        tracks: tr,
        trackIds: reinsert(st.trackIds, record.trackIndex),
        playlists: st.playlists.map((p) => (record.playlists[p.id]?.length ? { ...p, trackIds: reinsert(p.trackIds, record.playlists[p.id]) } : p)),
      };
    });
  };

  const all = [...affected, ...demoted.map((id) => s.tracks[id])];
  toast(all.length === 1 ? text.one(all[0]) : text.many(all.length), {
    detail: demoted.length ? "They stay on the music server to stream." : undefined,
    action: { label: "Undo", run: undo },
    duration: 8000,
  });
}

/* ───────────────────────── imports ───────────────────────── */

export function importFiles(files: FileList | File[]) {
  const list = [...files].filter((f) => f.type.startsWith("audio/") || f.type.startsWith("video/") || /\.(mp3|m4a|flac|wav|ogg|opus|aac|mp4|webm)$/i.test(f.name));
  if (!list.length) {
    toast("No audio files found", { tone: "error", detail: "Choose MP3, M4A, FLAC, WAV, OGG, or video files." });
    return [];
  }
  const s = getState();
  const artists = { ...s.artists };
  const albums = { ...s.albums };
  const tracks = { ...s.tracks };
  const ids: string[] = [];
  const localArtist = { id: "ar_local", name: "Local Files", genre: "indie" as Genre, palette: paletteFromSeed(99), listeners: 0 };
  artists[localArtist.id] = artists[localArtist.id] ?? localArtist;
  for (const file of list) {
    const base = file.name.replace(/\.[^.]+$/, "");
    // "Artist - Title - Remix" keeps everything after the first separator as the title.
    const dash = base.indexOf(" - ");
    const [maybeArtist, maybeTitle] = dash > 0 ? [base.slice(0, dash), base.slice(dash + 3)] : [null, base];
    // Some systems report no MIME type; fall back to the extension.
    const video = file.type ? file.type.startsWith("video/") : /\.(mp4|webm)$/i.test(file.name);
    let artistId = localArtist.id;
    if (maybeArtist) {
      artistId = `ar_${hashString(maybeArtist)}`;
      artists[artistId] = artists[artistId] ?? { id: artistId, name: maybeArtist.trim(), genre: "indie", palette: paletteFromSeed(hashString(maybeArtist)), listeners: 0 };
    }
    const seed = hashString(file.name + file.size);
    const albumId = `al_file_${seed}`;
    albums[albumId] = { id: albumId, title: maybeTitle.trim(), artistId, palette: paletteFromSeed(seed), glyph: seed % 6 };
    const id = `file_${seed}_${Date.now().toString(36)}`;
    const url = URL.createObjectURL(file);
    tracks[id] = { id, title: maybeTitle.trim(), artistId, albumId, duration: 0, addedAt: Date.now(), kind: video ? "video" : "audio", storage: "files", size: file.size, plays: 0, seed, fileUrl: url };
    ids.push(id);
    const probe = new Audio();
    probe.preload = "metadata";
    probe.onloadedmetadata = () => {
      if (Number.isFinite(probe.duration)) setTrackDuration(id, probe.duration);
      probe.removeAttribute("src");
    };
    probe.src = url;
  }
  setState({ artists, albums, tracks, trackIds: [...ids, ...s.trackIds] });
  toast(ids.length === 1 ? `Imported “${tracks[ids[0]].title}”` : `Imported ${ids.length} files`, {
    tone: "success",
    detail: "Files stay for this session; re-import them after a reload.",
    action: { label: "Play", run: () => playList(ids, ids[0], { label: "Imported files", route: { name: "library" } }) },
  });
  return ids;
}

export function setTrackDuration(id: string, duration: number) {
  const s = getState();
  const t = s.tracks[id];
  if (!t || Math.abs(t.duration - duration) < 0.5) return;
  setState({ tracks: { ...s.tracks, [id]: { ...t, duration } } });
  if (s.currentId === id) syncEngineEnd();
}

/* ───────────────────────── clips ───────────────────────── */

export function setClipDraft(trackId: string, range: ClipRange | null) {
  // Editing a clip is not listening: the current listen ends here.
  if (range && collector.listen?.trackId === trackId) {
    engine.captureProgress();
    finishListening("changed");
  }
  setState({ clipDraft: range ? { trackId, ...range } : null });
  if (getState().currentId === trackId) syncEngineEnd();
}

export function saveClip(trackId: string, range: ClipRange | null) {
  setState((s) => {
    const clips = { ...s.clips };
    if (range) clips[trackId] = range;
    else delete clips[trackId];
    return { clips };
  });
  if (getState().currentId === trackId) syncEngineEnd();
  // A server song's clip is part of its record on the music server.
  const serverId = getState().tracks[trackId]?.serverId;
  if (serverId) void saveSongChanges(serverId, { clip: range }).catch(() => toast("Clip saved on this device", { detail: "It will sync when the music server is available." }));
}

export function previewClip(trackId: string) {
  const s = getState();
  if (listenLocked()) return;
  engine.captureProgress();
  finishListening("changed");
  previewing = true;
  // A clip preview plays from the clip's start, not from where the song was left.
  cued = null;
  if (s.currentId === trackId && engine.loadedTrackId === trackId) {
    syncEngineEnd();
    engine.seek(effectiveRange(trackId).start);
    if (!s.isPlaying) togglePlay();
    return;
  }
  // Played on its own, without moving the queue; it stops at the clip's end.
  if (isPlayable(s.tracks[trackId], s)) load(trackId, { preview: true });
}

/* ───────────────────────── listen along ───────────────────────── */

/* The room itself is src/state/listen.ts; these are the player's side of it. */

export function listenLocked() {
  const s = getState();
  if (s.listen.mode !== "guest") return false;
  toast(`${s.listen.host} is in control`, { detail: "Leave the room to control playback yourself." });
  return true;
}

/**
 * A guest's player follows the host: plays `id` (or stops, for null) at
 * `position`, playing or paused. Small drifts are left alone; the room calls
 * this again whenever the host's playback changes and every few seconds.
 */
export function followHost(id: string | null, position: number, playing: boolean, label: string, rate = 1) {
  // The host decides where playback is now.
  cued = null;
  if (getState().speed !== rate) setSpeed(rate);
  const s = getState();
  if (!id) {
    if (s.isPlaying) {
      engine.pause();
      setState({ isPlaying: false });
      updateMediaSession();
    }
    return;
  }
  if (s.currentId !== id) {
    setState({ context: { label, ids: [id] }, order: [id], index: 0, upNext: [] });
    load(id, { autoplay: playing, remember: false });
    return;
  }
  // Still fetching this song's audio: it plays when it arrives (or stays paused).
  if (pendingStream === id) {
    if (s.isPlaying !== playing) setState({ isPlaying: playing });
    return;
  }
  if (engine.loadedTrackId !== id) {
    load(id, { autoplay: playing, remember: false });
    return;
  }
  if (Math.abs(engine.position - position) > 2) engine.seek(position);
  if (playing !== s.isPlaying) {
    if (playing) engine.play();
    else engine.pause();
    setState({ isPlaying: playing });
    updateMediaSession();
  }
}

/* ───────────────────────── media session & engine wiring ───────────────────────── */

function updateMediaSession() {
  if (!("mediaSession" in navigator)) return;
  const s = getState();
  const t = s.currentId ? s.tracks[s.currentId] : null;
  if (!t) return;
  navigator.mediaSession.metadata = new MediaMetadata({
    title: t.title,
    artist: s.artists[t.artistId]?.name,
    album: s.albums[t.albumId]?.title,
  });
  navigator.mediaSession.playbackState = s.isPlaying ? "playing" : "paused";
  updatePositionState();
}

function updatePositionState() {
  const s = getState();
  const t = s.currentId ? s.tracks[s.currentId] : null;
  if (!t || !t.duration || !("mediaSession" in navigator)) return;
  try {
    navigator.mediaSession.setPositionState({ duration: t.duration, playbackRate: s.speed, position: Math.min(engine.position, t.duration) });
  } catch {
    // Some browsers reject position state for streams; it is only a nicety.
  }
}

let wired = false;
export function wireEngine() {
  if (wired) return;
  wired = true;
  const s = getState();
  engine.setVolume(s.volume, s.muted);
  engine.setRate(s.speed);
  applyEngineSettings();
  engine.onProgress = (position, clock, rate, audible) => {
    const st = getState();
    if (st.listen.mode === "guest" || st.clipDraft || previewing) {
      collector.resetAnchor();
      return;
    }
    // The clip can change while a song plays.
    if (collector.listen && st.currentId === collector.listen.trackId) {
      const range = effectiveRange(st.currentId, st);
      collector.listen.span = Math.max(1, range.end - range.start);
    }
    collector.sample(position, clock, rate, audible);
    if (clock - lastListenSave >= 10_000) saveListening();
  };
  engine.onDiscontinuity = () => collector.resetAnchor();
  engine.onEnded = () => {
    const st = getState();
    if (previewing) {
      // A clip preview stops at its end instead of moving on through the queue.
      stopAtEnd(st);
      return;
    }
    if (st.repeat === "one" && st.currentId) {
      finishListening("finished");
      engine.seek(effectiveRange(st.currentId).start);
      engine.play();
      startListening(st.currentId);
      return;
    }
    advance({ auto: true, end: "finished" });
  };
  engine.onNearEnd = () => {
    const st = getState();
    if (previewing || st.repeat === "one" || !peekNext(st)) return;
    advance({ crossfade: engine.crossfadeSeconds, auto: true, end: "finished" });
  };
  engine.onDuration = (id, d) => {
    if (retriedError === id) retriedError = null;
    setTrackDuration(id, d);
  };
  engine.onBlocked = (id) => {
    const st = getState();
    if (st.currentId !== id || !st.isPlaying) return;
    // Keep the play button honest: the song is not actually playing.
    engine.pause();
    saveListening();
    setState({ isPlaying: false });
    updateMediaSession();
    toast("Playback didn't start", { detail: "Press play to try again." });
  };
  engine.onError = (id) => {
    const st = getState();
    const t = st.tracks[id];
    // A song streamed from the music server is fetched from its source first, which
    // occasionally fails once; try it again before moving on.
    if (!previewing && t?.storage === "server" && retriedError !== id) {
      retriedError = id;
      load(id, { autoplay: st.isPlaying, remember: false, end: "error" });
      return;
    }
    retriedError = null;
    toast(`Couldn't play “${t?.title ?? "file"}”`, { tone: "error", detail: "The file may be unsupported by this browser." });
    failedInRow.add(id);
    const n = peekNext(st);
    // Paused, or every song left to try has already failed (one broken song on Repeat, say): stop here.
    if (previewing || !st.isPlaying || (n && failedInRow.has(n.id))) {
      finishListening("error");
      stopAtEnd(st);
    } else advance({ auto: true, end: "error" });
  };

  if ("mediaSession" in navigator) {
    const handlers: Array<[MediaSessionAction, MediaSessionActionHandler]> = [
      ["play", () => !getState().isPlaying && togglePlay()],
      ["pause", () => getState().isPlaying && togglePlay()],
      ["nexttrack", () => next()],
      ["previoustrack", () => previous()],
      ["seekto", (d) => d.seekTime !== undefined && seek(d.seekTime)],
    ];
    for (const [action, handler] of handlers) {
      try {
        navigator.mediaSession.setActionHandler(action, handler);
      } catch {
        // Unsupported action in this browser.
      }
    }
  }

  // Leaving the page ends the undo window, so finish pending deletes now.
  window.addEventListener("pagehide", () => {
    // Keep what was heard of the current song, and save without waiting for the usual delay.
    engine.captureProgress();
    saveListening();
    flushPersist();
    for (const serverId of [...pendingServerDeletes.keys()]) deleteOnServer(serverId);
  });

  // Listening minutes for the history view.
  window.setInterval(() => { if (getState().currentId) protectStreams(); }, 60_000);
  window.setInterval(() => {
    const st = getState();
    if (!st.isPlaying || !engine.playing) return;
    const key = todayKey();
    setState({ listenLog: { ...st.listenLog, [key]: (st.listenLog[key] ?? 0) + 5 * st.speed } });
  }, 5000);
}

// Live audio and app state cannot be swapped in place: when this module (or anything it imports) changes, reload the page.
if (import.meta.hot) import.meta.hot.accept(() => location.reload());
