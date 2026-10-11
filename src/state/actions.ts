import { engine } from "../audio/engine";
import { hashString, paletteFromSeed, rng } from "../data/library";
import type { ClipRange, Genre, Playlist, Track } from "../data/types";
import { todayKey } from "../lib/format";
import { getState, setState, type AppState, type MenuState, type Modal, type Route, type Settings, type Toast } from "./store";

/* ───────────────────────── selectors ───────────────────────── */

export const isOnServer = (t: Track) => t.storage !== "files" || Boolean(t.uploaded);

export function isPlayable(t: Track | undefined, s: AppState = getState()) {
  if (!t) return false;
  if (t.storage === "server") return s.server.status === "connected";
  return true;
}

/** Songs that appear in the Library: everything stored on this device. */
export function libraryIds(s: AppState) {
  return s.trackIds.filter((id) => s.tracks[id] && s.tracks[id].storage !== "server");
}

export function genreOf(t: Track, s: AppState = getState()): Genre {
  return s.artists[t.artistId]?.genre ?? "indie";
}

export function effectiveRange(id: string, s: AppState = getState()): ClipRange {
  const t = s.tracks[id];
  const duration = t?.duration || 0;
  const r = s.clipDraft?.trackId === id ? s.clipDraft : s.clips[id];
  if (!r) return { start: 0, end: duration };
  return { start: Math.max(0, Math.min(r.start, duration)), end: Math.min(duration, Math.max(r.end, r.start + 1)) };
}

export function likedIds(s: AppState) {
  return s.playlists.find((p) => p.id === "liked")?.trackIds ?? [];
}

export function isLiked(id: string, s: AppState = getState()) {
  return likedIds(s).includes(id);
}

export function mixIds(s: AppState, genre: Genre) {
  const ids = s.trackIds.filter((id) => s.tracks[id] && s.artists[s.tracks[id].artistId]?.genre === genre && isPlayable(s.tracks[id], s));
  const r = rng(hashString(genre + todayKey()));
  return [...ids].sort(() => r() - 0.5).slice(0, 20);
}

export const mixNames: Record<Genre, string> = {
  synthwave: "Neon Mix",
  lofi: "Chill Mix",
  house: "Dance Mix",
  ambient: "Calm Mix",
  indie: "Indie Mix",
};

/* ───────────────────────── navigation ───────────────────────── */

const sameRoute = (a: Route, b: Route) => JSON.stringify(a) === JSON.stringify(b);

export function navigate(route: Route) {
  const s = getState();
  if (sameRoute(s.route, route)) return;
  // Typing in search replaces the current search entry instead of stacking history.
  if (route.name === "search" && s.route.name === "search") {
    setState({ route });
    return;
  }
  setState({ route, back: [...s.back, s.route].slice(-50), forward: [], selection: [], menu: null });
}

export function goBack() {
  const s = getState();
  const prev = s.back[s.back.length - 1];
  if (!prev) return;
  setState({ route: prev, back: s.back.slice(0, -1), forward: [s.route, ...s.forward], selection: [] });
}

export function goForward() {
  const s = getState();
  const next = s.forward[0];
  if (!next) return;
  setState({ route: next, forward: s.forward.slice(1), back: [...s.back, s.route], selection: [] });
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

function engineTrack(id: string) {
  const s = getState();
  const t = s.tracks[id];
  const fileUrl = t.fileUrl ?? t.mediaUrl;
  return { id, seed: t.seed, genre: genreOf(t, s), fileUrl, video: Boolean(fileUrl) && t.kind === "video" };
}

function load(id: string, { autoplay = true, crossfade = 0, remember = true } = {}) {
  const s = getState();
  const t = s.tracks[id];
  if (!t) return;
  const range = effectiveRange(id, s);
  engine.load(engineTrack(id), { start: range.start, end: range.end || t.duration || 1e9, autoplay, crossfade });
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
}

/** Starts playing `ids` from `startId`, remembering where playback came from. */
export function playList(ids: string[], startId?: string, ctx?: { label: string; route?: Route }) {
  const s = getState();
  if (listenLocked()) return;
  const playable = ids.filter((id) => isPlayable(s.tracks[id], s));
  if (!playable.length) {
    toast("Nothing playable here", { detail: s.server.status !== "connected" ? "Connect to your music server to stream these songs." : undefined });
    return;
  }
  const first = startId && playable.includes(startId) ? startId : s.shuffle ? playable[Math.floor(Math.random() * playable.length)] : playable[0];
  const order = s.shuffle ? shuffled(playable, first) : playable;
  setState({
    context: { label: ctx?.label ?? "Library", route: ctx?.route, ids: playable },
    order,
    index: order.indexOf(first),
  });
  load(first);
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
  if (s.isPlaying) engine.pause();
  else engine.play();
  setState({ isPlaying: !s.isPlaying });
  updateMediaSession();
}

/**
 * Finds the next playable song: manual queue first, then the collection order.
 * Songs that became unavailable (e.g. server went offline) are skipped.
 */
function peekNext(s: AppState) {
  for (let i = 0; i < s.upNext.length; i++) {
    if (isPlayable(s.tracks[s.upNext[i]], s)) return { id: s.upNext[i], upNextSkip: i + 1, index: s.index };
  }
  const n = s.order.length;
  for (let step = 1; step <= n; step++) {
    const raw = s.index + step;
    if (raw >= n && s.repeat !== "all") break;
    const index = raw % n;
    if (isPlayable(s.tracks[s.order[index]], s)) return { id: s.order[index], upNextSkip: s.upNext.length, index };
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

function advance({ crossfade = 0, auto = false } = {}) {
  const s = getState();
  const n = peekNext(s);
  if (!n) {
    if (auto && s.settings.autoplay && s.currentId && s.listen.mode !== "guest") {
      const genre = genreOf(s.tracks[s.currentId], s);
      const pool = mixIds(s, genre).filter((id) => id !== s.currentId);
      if (pool.length) {
        toast("Autoplay is on", { detail: `Keeping the ${mixNames[genre]} going.` });
        playList(pool, pool[0], { label: mixNames[genre], route: { name: "mix", genre } });
        return;
      }
    }
    if (auto) stopAtEnd(s);
    else if (s.currentId) toast("End of queue", { detail: "Turn on repeat or add more songs." });
    return;
  }
  // Queued songs are dropped up to (and including) the one we play; unplayable ones are discarded too.
  const fromUpNext = n.upNextSkip > 0 && s.upNext[n.upNextSkip - 1] === n.id;
  setState({ upNext: fromUpNext ? s.upNext.slice(n.upNextSkip) : [], index: n.index });
  load(n.id, { crossfade });
}

export function next() {
  if (listenLocked()) return;
  advance();
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
    const order = on ? shuffled(s.context.ids, s.currentId) : s.context.ids;
    const index = Math.max(0, order.indexOf(s.currentId));
    setState({ shuffle: on, order, index });
  } else setState({ shuffle: on });
}

export function cycleRepeat() {
  setState((s) => ({ repeat: s.repeat === "off" ? "all" : s.repeat === "all" ? "one" : "off" }));
  applyEngineSettings();
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

function applyEngineSettings() {
  const s = getState();
  engine.lead = s.settings.crossfade && s.repeat !== "one" ? s.settings.crossfadeSeconds : 0;
  engine.setNormalize(s.settings.normalize);
}

/* ───────────────────────── library mutations ───────────────────────── */

function updatePlaylist(id: string, fn: (p: Playlist) => Playlist) {
  setState((s) => ({ playlists: s.playlists.map((p) => (p.id === id ? fn(p) : p)) }));
}

export function toggleLike(id: string) {
  const liked = isLiked(id);
  updatePlaylist("liked", (p) => ({ ...p, trackIds: liked ? p.trackIds.filter((t) => t !== id) : [id, ...p.trackIds] }));
  toast(liked ? "Removed from Liked Songs" : "Added to Liked Songs", {
    tone: liked ? "default" : "success",
    action: { label: "Undo", run: () => toggleLike(id) },
  });
}

export function likeMany(ids: string[]) {
  const set = new Set(likedIds(getState()));
  const fresh = ids.filter((id) => !set.has(id));
  updatePlaylist("liked", (p) => ({ ...p, trackIds: [...fresh, ...p.trackIds] }));
  toast(`${fresh.length} songs added to Liked Songs`, { tone: "success" });
}

export function createPlaylist(name: string, ids: string[] = [], description = "") {
  const id = `p${Date.now().toString(36)}`;
  const playlist: Playlist = {
    id,
    name: name.trim() || "My Playlist",
    description,
    trackIds: [...new Set(ids)],
    createdAt: Date.now(),
    palette: paletteFromSeed(hashString(id + name)),
  };
  setState((s) => ({ playlists: [...s.playlists, playlist] }));
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
  const existing = new Set(p.trackIds);
  const fresh = ids.filter((id) => !existing.has(id));
  updatePlaylist(playlistId, (pl) => ({ ...pl, trackIds: [...pl.trackIds, ...fresh] }));
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

function deleteOnServer(serverId: string) {
  clearTimeout(pendingServerDeletes.get(serverId));
  pendingServerDeletes.delete(serverId);
  void fetch(`/api/library/${encodeURIComponent(serverId)}`, { method: "DELETE", keepalive: true }).catch(() => undefined);
}

export function isServerDeletePending(serverId: string) {
  return pendingServerDeletes.has(serverId);
}

/** A re-import of a song that is waiting to be deleted keeps the server copy. */
export function cancelServerDelete(serverId: string) {
  clearTimeout(pendingServerDeletes.get(serverId));
  pendingServerDeletes.delete(serverId);
}

/**
 * Removes songs from this device. Imported files disappear entirely; server
 * downloads revert to stream-only. Undo restores just those songs.
 */
export function deleteFromDevice(ids: string[]) {
  const s = getState();
  const affected = ids.map((id) => s.tracks[id]).filter((t) => t && t.storage !== "server");
  if (!affected.length) return;
  const removed = new Set(affected.filter((t) => t.storage !== "downloads").map((t) => t.id));
  const demoted = affected.filter((t) => t.storage === "downloads").map((t) => t.id);
  const keep = (id: string) => !removed.has(id);

  const record = {
    tracks: affected.filter((t) => removed.has(t.id)),
    trackIndex: s.trackIds.map((id, index) => ({ id, index })).filter((x) => removed.has(x.id)),
    playlists: Object.fromEntries(s.playlists.map((p) => [p.id, p.trackIds.map((id, index) => ({ id, index })).filter((x) => removed.has(x.id))])),
    demoted,
  };

  const tracks = { ...s.tracks };
  for (const id of removed) delete tracks[id];
  for (const id of demoted) tracks[id] = { ...tracks[id], storage: "server" };

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

  // Free session-only file blobs once the undo window has passed.
  for (const t of record.tracks) {
    if (!t.fileUrl) continue;
    const url = t.fileUrl;
    pendingRevokes.set(t.id, window.setTimeout(() => {
      URL.revokeObjectURL(url);
      pendingRevokes.delete(t.id);
    }, 15_000));
  }
  // Web imports live in the import API's library; delete those files after the same window.
  for (const t of record.tracks) {
    if (!t.serverId) continue;
    const serverId = t.serverId;
    clearTimeout(pendingServerDeletes.get(serverId));
    pendingServerDeletes.set(serverId, window.setTimeout(() => deleteOnServer(serverId), 15_000));
  }

  const undo = () => {
    for (const t of record.tracks) {
      clearTimeout(pendingRevokes.get(t.id));
      pendingRevokes.delete(t.id);
      if (t.serverId) cancelServerDelete(t.serverId);
    }
    setState((st) => {
      const tr = { ...st.tracks };
      for (const t of record.tracks) tr[t.id] = t;
      for (const id of record.demoted) if (tr[id]?.storage === "server") tr[id] = { ...tr[id], storage: "downloads" };
      return {
        tracks: tr,
        trackIds: reinsert(st.trackIds, record.trackIndex),
        playlists: st.playlists.map((p) => (record.playlists[p.id]?.length ? { ...p, trackIds: reinsert(p.trackIds, record.playlists[p.id]) } : p)),
      };
    });
  };

  toast(affected.length === 1 ? `Removed “${affected[0].title}” from this device` : `${affected.length} songs removed from this device`, {
    detail: demoted.length ? "Server copies stay available to stream." : undefined,
    action: { label: "Undo", run: undo },
    duration: 8000,
  });
}

/* ───────────────────────── server transfers ───────────────────────── */

let transferToast = 0;
function refreshTransferToast() {
  const d = getState().server.downloads;
  const ids = Object.keys(d);
  if (!ids.length) {
    if (transferToast) updateToast(transferToast, { message: "Downloads complete", detail: "Songs are saved on this device.", progress: undefined, tone: "success", sticky: false }, 2600);
    transferToast = 0;
    return;
  }
  const avg = ids.reduce((sum, id) => sum + d[id], 0) / ids.length;
  const detail = `${ids.length} remaining · ${Math.round(avg * 100)}%`;
  if (!transferToast) transferToast = toast("Downloading from server", { detail, progress: avg, sticky: true });
  else updateToast(transferToast, { detail, progress: avg });
}

export function downloadTracks(ids: string[]) {
  const s = getState();
  if (s.server.status !== "connected") {
    toast("Server offline", { tone: "error", detail: "Reconnect in Settings → Server." });
    return;
  }
  const targets = ids.filter((id) => s.tracks[id]?.storage === "server" && s.server.downloads[id] === undefined);
  if (!targets.length) return;
  setState((st) => ({ server: { ...st.server, downloads: { ...st.server.downloads, ...Object.fromEntries(targets.map((id) => [id, 0])) } } }));
  refreshTransferToast();
  targets.forEach((id, i) => {
    const speed = 0.06 + Math.random() * 0.08;
    const timer = window.setInterval(() => {
      const st = getState();
      const p = st.server.downloads[id];
      if (p === undefined) return clearInterval(timer);
      const np = Math.min(1, p + speed * (i < 3 ? 1 : 0.6));
      if (np >= 1) {
        clearInterval(timer);
        const t = st.tracks[id];
        const downloads = { ...st.server.downloads };
        delete downloads[id];
        setState({
          server: { ...st.server, downloads },
          tracks: { ...st.tracks, [id]: { ...t, storage: "downloads", size: Math.round(t.duration * 44_000), addedAt: Date.now() } },
        });
      } else {
        setState({ server: { ...st.server, downloads: { ...st.server.downloads, [id]: np } } });
      }
      refreshTransferToast();
    }, 160 + i * 20);
  });
}

export function cancelDownloads() {
  setState((s) => ({ server: { ...s.server, downloads: {} } }));
  if (transferToast) dismissToast(transferToast);
  transferToast = 0;
  toast("Downloads cancelled");
}

export function uploadMissing() {
  const s = getState();
  const missing = s.trackIds.filter((id) => s.tracks[id]?.storage === "files" && !isOnServer(s.tracks[id]));
  if (!missing.length) {
    toast("Everything is already on the server", { tone: "success" });
    return;
  }
  const id = toast("Uploading to server", { detail: `0 of ${missing.length}`, progress: 0, sticky: true });
  let done = 0;
  const timer = window.setInterval(() => {
    done++;
    const st = getState();
    const tid = missing[done - 1];
    // Skip songs removed from the device while the upload was running.
    if (st.tracks[tid]) setState({ tracks: { ...st.tracks, [tid]: { ...st.tracks[tid], uploaded: true } } });
    updateToast(id, { detail: `${done} of ${missing.length}`, progress: done / missing.length });
    if (done >= missing.length) {
      clearInterval(timer);
      updateToast(id, { message: "Upload complete", detail: `${missing.length} songs added to the server`, tone: "success", progress: undefined, sticky: false }, 2600);
    }
  }, 180);
}

export function syncPlaylists() {
  const id = toast("Syncing playlists…", { sticky: true, progress: 0.15 });
  setTimeout(() => updateToast(id, { progress: 0.7 }), 400);
  setTimeout(() => updateToast(id, { message: "Playlists synced", detail: "Up to date across your devices.", tone: "success", progress: undefined, sticky: false }, 2400), 900);
}

let connectAttempt = 0;
export function setServerStatus(status: "connected" | "offline") {
  const attempt = ++connectAttempt;
  if (status === "offline") {
    setState((s) => ({ server: { ...s.server, status: "offline" } }));
    toast("Disconnected from server");
    return;
  }
  setState((s) => ({ server: { ...s.server, status: "connecting" } }));
  setTimeout(() => {
    // A newer connect/disconnect request wins.
    if (attempt !== connectAttempt) return;
    setState((s) => ({ server: { ...s.server, status: "connected" } }));
    toast("Connected to server", { tone: "success", detail: getState().settings.serverUrl });
  }, 1100);
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
    const [maybeArtist, maybeTitle] = base.includes(" - ") ? base.split(" - ", 2) : [null, base];
    let artistId = localArtist.id;
    if (maybeArtist) {
      artistId = `ar_${hashString(maybeArtist)}`;
      artists[artistId] = artists[artistId] ?? { id: artistId, name: maybeArtist.trim(), genre: "indie", palette: paletteFromSeed(hashString(maybeArtist)), listeners: 0 };
    }
    const seed = hashString(file.name + file.size);
    const albumId = `al_file_${seed}`;
    albums[albumId] = { id: albumId, title: "Imported", artistId, year: new Date().getFullYear(), palette: paletteFromSeed(seed), glyph: seed % 6 };
    const id = `file_${seed}_${Date.now().toString(36)}`;
    const url = URL.createObjectURL(file);
    tracks[id] = { id, title: maybeTitle.trim(), artistId, albumId, duration: 0, addedAt: Date.now(), kind: file.type.startsWith("video/") ? "video" : "audio", storage: "files", size: file.size, plays: 0, seed, fileUrl: url };
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
}

export function previewClip(trackId: string) {
  const s = getState();
  if (listenLocked()) return;
  if (s.currentId === trackId && engine.loadedTrackId === trackId) {
    syncEngineEnd();
    engine.seek(effectiveRange(trackId).start);
    if (!s.isPlaying) togglePlay();
    return;
  }
  playTrackNow(trackId);
}

/* ───────────────────────── listen along ───────────────────────── */

let listenTimers: number[] = [];
const code = () => {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const part = () => Array.from({ length: 4 }, () => chars[Math.floor(Math.random() * chars.length)]).join("");
  return `${part()}-${part()}`;
};

export function listenLocked() {
  const s = getState();
  if (s.listen.mode !== "guest") return false;
  toast(`${s.listen.host} is in control`, { detail: "Leave the room to control playback yourself." });
  return true;
}

export function startRoom() {
  listenTimers.forEach(clearTimeout);
  setState({ listen: { mode: "host", code: code(), people: [] } });
  const join = (name: string, delay: number) =>
    listenTimers.push(window.setTimeout(() => {
      setState((s) => (s.listen.mode === "host" ? { listen: { ...s.listen, people: [...s.listen.people, name] } } : {}));
      if (getState().listen.mode === "host") toast(`${name} joined your room`);
    }, delay));
  join("Maya", 2600);
  join("Theo", 6200);
}

export function joinRoom(roomCode: string) {
  listenTimers.forEach(clearTimeout);
  setState({ listen: { mode: "connecting", code: roomCode.toUpperCase(), people: [] } });
  listenTimers.push(window.setTimeout(() => {
    if (getState().listen.mode !== "connecting") return;
    const s = getState();
    const ids = mixIds(s, "lofi");
    setState({ listen: { mode: "idle", code: "", people: [] } });
    playList(ids, ids[0], { label: "Rowan's room" });
    setState({ listen: { mode: "guest", code: roomCode.toUpperCase(), people: ["Rowan", "Maya"], host: "Rowan" } });
    toast("Joined Rowan's room", { tone: "success", detail: "Rowan controls playback. Your volume is yours." });
  }, 1300));
}

export function leaveRoom() {
  listenTimers.forEach(clearTimeout);
  listenTimers = [];
  const was = getState().listen.mode;
  setState({ listen: { mode: "idle", code: "", people: [] } });
  if (was !== "idle") toast(was === "host" ? "Room closed" : "Left the room");
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
  engine.onEnded = () => {
    const st = getState();
    if (st.repeat === "one" && st.currentId) {
      engine.seek(effectiveRange(st.currentId).start);
      engine.play();
      return;
    }
    advance({ auto: true });
  };
  engine.onNearEnd = () => {
    const st = getState();
    if (st.repeat === "one" || !peekNext(st)) return;
    advance({ crossfade: engine.crossfadeSeconds, auto: true });
  };
  engine.onDuration = (id, d) => setTrackDuration(id, d);
  engine.onBlocked = (id) => {
    const st = getState();
    if (st.currentId !== id || !st.isPlaying) return;
    // Keep the play button honest: the song is not actually playing.
    engine.pause();
    setState({ isPlaying: false });
    updateMediaSession();
    toast("Playback didn't start", { detail: "Press play to try again." });
  };
  engine.onError = (id) => {
    const t = getState().tracks[id];
    toast(`Couldn't play “${t?.title ?? "file"}”`, { tone: "error", detail: "The file may be unsupported by this browser." });
    advance({ auto: true });
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
    for (const serverId of [...pendingServerDeletes.keys()]) deleteOnServer(serverId);
  });

  // Listening minutes for the history view.
  window.setInterval(() => {
    const st = getState();
    if (!st.isPlaying || !engine.playing) return;
    const key = todayKey();
    setState({ listenLog: { ...st.listenLog, [key]: (st.listenLog[key] ?? 0) + 5 * st.speed } });
  }, 5000);
}

// Live audio and app state cannot be swapped in place: when this module (or anything it imports) changes, reload the page.
if (import.meta.hot) import.meta.hot.accept(() => location.reload());
