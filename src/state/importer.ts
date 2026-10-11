import { useSyncExternalStore } from "react";
import { engine } from "../audio/engine";
import { hashString, paletteFromSeed } from "../data/library";
import type { Album, Artist, Genre, Track } from "../data/types";
import type { ReasonKind } from "../recommend/taste";
import {
  addToPlaylist, cancelServerDelete, closeModal, connectStreams, createPlaylist, hideDiscovery, isServerDeletePending, keepDiscovery, linkSavedStream, navigate,
  playList, retryServerDeletes, toast, togglePlay, updateToast,
} from "./actions";
import { getState, setState, subscribe as subscribeApp } from "./store";

/*
 * "Import from Web", ported from Resonance's local import flow: paste a Spotify,
 * SoundCloud, or YouTube link (resolved automatically) or search all three, pick a
 * source (or playlist songs), preview 30 seconds, then download in the background
 * while a transfer toast tracks progress. The work runs in the import API
 * (server/api.mjs), which reuses Resonance's provider modules.
 */

export type MediaKind = "audio" | "video";
export type Provider = "youtube" | "spotify" | "soundcloud";

export const PROVIDERS: Array<[Provider, string]> = [
  ["youtube", "YouTube"],
  ["spotify", "Spotify"],
  ["soundcloud", "SoundCloud"],
];

export interface SourceTrack {
  provider?: string | null;
  type?: string;
  trackID?: string | null;
  title?: string;
  artist?: string | null;
  album?: string | null;
  trackNumber?: number | null;
  durationSeconds?: number | null;
  artworkURL?: string | null;
  creatorAvatarURL?: string | null;
  sourceURL?: string | null;
  sourcePageURL?: string | null;
}

export interface Candidate {
  title?: string;
  artist?: string | null;
  album?: string | null;
  durationSeconds?: number | null;
  thumbnailURL?: string | null;
  videoThumbnailURL?: string | null;
  creatorAvatarURL?: string | null;
  sourceProvider?: string;
  searchProvider?: Provider;
  sourceURL: string;
  sourcePageURL?: string | null;
  mediaSourceURL?: string | null;
  videoID?: string;
  providerID?: string;
  candidateID?: string;
  trackID?: string;
  quality?: string | null;
  qualityLabel?: string | null;
  confidence?: string | null;
  score?: number | null;
  width?: number | null;
  height?: number | null;
  fps?: number | null;
  playlistIndex?: number | null;
  importMetadata?: SourceTrack;
  fallbackCandidates?: Candidate[];
  match?: Record<string, number | null>;
  requiresReview?: boolean;
  autoSelectable?: boolean;
  actionable?: boolean;
  sourceKind?: string | null;
}

export interface Resolution {
  kind: "search_results" | "youtube" | "spotify" | "soundcloud" | "youtube_playlist" | "spotify_playlist" | "soundcloud_playlist";
  mediaKind: MediaKind;
  track: SourceTrack;
  candidates: Candidate[];
  playlist?: { title?: string; unavailableCount?: number; truncated?: boolean };
  unavailableProviders?: string[];
}

export interface ImportFailure {
  stage: string;
  code?: string;
  message: string;
}

export type Stage =
  | "idle" | "resolving_metadata" | "searching_candidates" | "awaiting_selection" | "inspecting_source" | "downloading"
  | "processing" | "saving_local" | "local_complete" | "complete" | "failed" | "cancelled";

/** A song in the import API's library (see `publicTrack` in server/api.mjs). */
export interface ServerTrack {
  id: string;
  title: string;
  artist: string | null;
  album: string | null;
  durationSeconds: number | null;
  mediaKind: MediaKind;
  size: number;
  addedAt: number;
  sourceURL: string | null;
  mediaUrl: string;
  artworkUrl: string | null;
}

export interface ImportState {
  /** Whether the import API answered; null until checked. */
  available: boolean | null;
  source: string;
  mediaKind: MediaKind;
  stage: Stage;
  /** Extra progress for the current stage, e.g. playlist matching or bytes downloaded. */
  progress: { completed: number; total: number } | null;
  resolution: Resolution | null;
  resolvedKey: string | null;
  selected: number[];
  error: ImportFailure | null;
  busy: "resolve" | "import" | null;
  upload: boolean;
  providerFocus: Provider;
  /** "2 of 14 • Song" while a playlist downloads, otherwise the song title. */
  transferName: string;
  preview: { index: number; status: "loading" | "playing" | "paused" } | null;
}

const AUTO_RESOLVE_DELAY = 450;

const blank = (): Omit<ImportState, "available"> => ({
  source: "",
  mediaKind: "audio",
  stage: "idle",
  progress: null,
  resolution: null,
  resolvedKey: null,
  selected: [],
  error: null,
  busy: null,
  upload: false,
  providerFocus: "youtube",
  transferName: "",
  preview: null,
});

let state: ImportState = { available: null, ...blank() };
const listeners = new Set<() => void>();

function set(patch: Partial<ImportState>) {
  state = { ...state, ...patch };
  listeners.forEach((l) => l());
}

export function getImport() {
  return state;
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useImport<T>(selector: (s: ImportState) => T): T {
  return useSyncExternalStore(subscribe, () => selector(state));
}

/* ───────────────────────── source helpers (from Resonance) ───────────────────────── */

/** A complete Spotify, SoundCloud, or YouTube URL that can be resolved without pressing Search. */
export function sourceIsReady(value: string) {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    return false;
  }
  if (url.protocol !== "https:" || url.username || url.password) return false;
  const host = url.hostname.toLowerCase();
  const segments = url.pathname.split("/").filter(Boolean);
  if (["open.spotify.com", "www.open.spotify.com"].includes(host)) {
    if (segments[0]?.startsWith("intl-")) segments.shift();
    return ["track", "playlist"].includes(segments[0]) && /^[a-zA-Z0-9]{22}$/.test(segments[1] || "");
  }
  if (["spotify.link", "www.spotify.link"].includes(host)) return segments.length > 0;
  if (["soundcloud.com", "www.soundcloud.com", "m.soundcloud.com"].includes(host)) return segments.length >= 2;
  if (host === "on.soundcloud.com") return segments.length > 0;
  const youtube = ["youtube.com", "www.youtube.com", "m.youtube.com", "music.youtube.com"];
  if ([...youtube, "youtu.be", "www.youtu.be"].includes(host)) {
    const list = url.searchParams.get("list");
    if (list && /^[a-zA-Z0-9_-]{10,150}$/.test(list)) return true;
  }
  if (["youtu.be", "www.youtu.be"].includes(host)) return /^[a-zA-Z0-9_-]{11}$/.test(segments[0] || "");
  if (youtube.includes(host)) {
    if (url.pathname === "/watch") return /^[a-zA-Z0-9_-]{11}$/.test(url.searchParams.get("v") || "");
    return ["embed", "live", "shorts"].includes(segments[0] || "") && /^[a-zA-Z0-9_-]{11}$/.test(segments[1] || "");
  }
  return false;
}

export function inputIsLink(value: string) {
  const input = value.trim();
  if (!input || /\s/.test(input)) return /^[a-z][a-z0-9+.-]*:\/\//i.test(input);
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(input) || /^www\./i.test(input) || /^[^/?#]+\.[a-z]{2,}(?:[/?#:]|$)/i.test(input);
}

export function providerForSource(value: string): Provider | null {
  const source = value.toLowerCase();
  if (source.includes("spotify.com") || source.includes("spotify.link")) return "spotify";
  if (source.includes("soundcloud.com")) return "soundcloud";
  if (source.includes("youtube.com") || source.includes("youtu.be")) return "youtube";
  return null;
}

/** Spotify and SoundCloud links can only be imported as audio. */
export function isAudioOnlySource(value: string) {
  try {
    const host = new URL(value.trim()).hostname.toLowerCase();
    return ["open.spotify.com", "www.open.spotify.com", "spotify.link", "www.spotify.link", "soundcloud.com", "www.soundcloud.com", "m.soundcloud.com", "on.soundcloud.com"].includes(host);
  } catch {
    return false;
  }
}

export const isPlaylist = (r: Resolution | null) => Boolean(r?.kind.endsWith("_playlist"));

/**
 * Whether a row can be downloaded. Spotify songs are matched to YouTube uploads by
 * metadata, so the providers flag them "requires review"; choosing one in this
 * dialog is that review, so they are selectable (and preselected) like the rest.
 */
export function isDownloadable(c: Candidate | undefined) {
  return typeof c?.sourceURL === "string" && c.sourceURL.length > 0;
}

export function canPreview(r: Resolution | null, c: Candidate | undefined) {
  return r?.mediaKind === "audio" && ["soundcloud", "youtube", "youtube_music"].includes(c?.sourceProvider ?? "") && typeof c?.sourceURL === "string";
}

export function providerLabel(c: Candidate) {
  if (c.searchProvider === "spotify") return "Spotify";
  if (c.searchProvider === "soundcloud") return "SoundCloud";
  if (c.searchProvider === "youtube") return "YouTube";
  if (c.sourceProvider === "soundcloud") return "SoundCloud";
  if (c.sourceProvider === "youtube_music") return "YouTube Music";
  return "YouTube";
}

const STAGE_LABELS: Partial<Record<Stage, string>> = {
  resolving_metadata: "Reading link",
  searching_candidates: "Searching for sources",
  inspecting_source: "Preparing download",
  downloading: "Downloading",
  processing: "Processing download",
  saving_local: "Saving download",
  local_complete: "Download complete",
  complete: "Import complete",
  cancelled: "Cancelled",
};

export function stageLabel(stage: Stage) {
  return STAGE_LABELS[stage] ?? "";
}

export function failureText(f: ImportFailure) {
  return `${f.message} (${f.stage.replaceAll("_", " ")})`;
}

/* ───────────────────────── API client ───────────────────────── */

type ApiResult<T> = { ok: true; result: T } | { ok: false; error: ImportFailure };

function asFailure(error: unknown, stage: string): ImportFailure {
  if (error instanceof DOMException && error.name === "AbortError") return { stage, code: "CANCELLED", message: "Import cancelled." };
  if (error instanceof TypeError) return { stage, code: "SERVICE_UNAVAILABLE", message: "Slopify couldn't reach its import service. Make sure the app is running with npm run dev." };
  const e = error as Partial<ImportFailure> | null;
  if (e && typeof e.message === "string" && e.message) return { stage: typeof e.stage === "string" ? e.stage : stage, code: e.code, message: e.message };
  return { stage, code: "IMPORT_FAILED", message: "Slopify could not complete the import." };
}

/** POSTs to an NDJSON endpoint, reporting progress lines until the final result line. */
async function streamCall<T>(path: string, body: unknown, signal: AbortSignal, onProgress: (p: { stage: Stage; completed?: number; total?: number }) => void, stage: string): Promise<ApiResult<T>> {
  const res = await fetch(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal });
  if (!res.ok || !res.body) {
    // Prefer the server's own explanation (e.g. a damaged library file).
    const detail = (await res.json().catch(() => null)) as { error?: { message?: string } } | null;
    throw { stage, code: "SERVICE_UNAVAILABLE", message: detail?.error?.message ?? `The import service answered HTTP ${res.status}.` };
  }
  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = "";
  let final = null as ApiResult<T> | null;
  const take = (line: string) => {
    if (!line.trim()) return;
    const msg = JSON.parse(line) as { type: string } & Record<string, unknown>;
    if (msg.type === "progress") onProgress(msg as never);
    else if (msg.type === "result") final = msg as unknown as ApiResult<T>;
  };
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += value;
    let at: number;
    while ((at = buffer.indexOf("\n")) >= 0) {
      take(buffer.slice(0, at));
      buffer = buffer.slice(at + 1);
    }
  }
  take(buffer);
  if (!final) throw { stage, code: "CONNECTION_LOST", message: "The import service closed the connection early." };
  return final;
}

/* ───────────────────────── discovery (Home → Discover new music) ───────────────────────── */

/** A provider search for discovery. It has its own request, so an open import dialog is left alone. */
export async function searchDiscovery(query: string, signal: AbortSignal, mediaKind: MediaKind = "audio"): Promise<Resolution> {
  const result = await streamCall<Resolution>("/api/import/resolve", { source: query, mediaKind }, signal, () => undefined, "searching_candidates");
  // Nothing found is an answer, not a failure.
  if (!result.ok && result.error.code === "NO_SEARCH_RESULTS") return { kind: "search_results", mediaKind: "audio", track: {}, candidates: [] };
  if (!result.ok) throw result.error;
  return result.result;
}

/** How an added suggestion carries on once it is in the library: played straight away (the default), and/or handed to `done`. */
interface DiscoveryOptions { play?: boolean; done?: (libraryId: string) => void }

/** The suggestion being reviewed or added, and why it was suggested. */
let discovery: ({ candidate: Candidate; kind: ReasonKind } & DiscoveryOptions) | null = null;

function importBusy() {
  if (state.busy !== "import") return false;
  toast("A song is already importing", { detail: "Wait for it to finish before adding another." });
  return true;
}

/** Opens the import dialog on just this suggestion, to preview it or check its source first. */
export function reviewDiscoveredSong(candidate: Candidate, kind: ReasonKind, options: DiscoveryOptions = {}) {
  if (!isDownloadable(candidate) || importBusy()) return;
  discovery = { candidate, kind, ...options };
  prepareImportDialog();
  navigate({ name: "search", q: state.source });
}

/** Saves explicitly chosen search results using the durable download pipeline. */
export async function saveSearchResults(source: string, resolution: Resolution, selected: number[]) {
  if (importBusy()) return;
  resolveController?.abort();
  clearAuto();
  stopPreview({ resume: true });
  if (discovery?.candidate !== resolution.candidates[selected[0]]) discovery = null;
  set({ source, resolution, selected: selected.filter((i) => isDownloadable(resolution.candidates[i])), mediaKind: resolution.mediaKind, busy: null, error: null, upload: canUploadToServer() });
  await confirmImport();
}

/** Downloads a suggestion into the library and plays it. Matches that need a source check go through review instead. */
export async function addDiscoveredSong(candidate: Candidate, kind: ReasonKind, options: DiscoveryOptions = {}) {
  if (!isDownloadable(candidate)) return;
  if (candidate.requiresReview) return reviewDiscoveredSong(candidate, kind, options);
  if (importBusy()) return;
  discovery = { candidate, kind, ...options };
  prepareImportDialog();
  await confirmImport();
}

/* ───────────────────────── recommended songs, streamed in full ───────────────────────── */

/*
 * A suggestion becomes a song the player knows (`stream: true`): same cards,
 * queue and controls as library songs, but it is not in the library and is never
 * saved. Its audio is the whole song, downloaded once by the import API's
 * preview service and served from there with seeking.
 */
export interface StreamSong { key: string; candidate: Candidate; title: string; artist: string; artwork?: string; kind: ReasonKind }

const streamSources = new Map<string, { candidate: Candidate; kind: ReasonKind; key: string }>();

export const streamTrackId = (key: string) => `stream_${hashString(key).toString(36)}`;

/** Sources the preview service can fetch (YouTube and SoundCloud). Others can still be added to the library. */
export const canStream = (c: Candidate) => isDownloadable(c) && ["soundcloud", "youtube", "youtube_music"].includes(c.sourceProvider ?? "");

/** Makes suggestions playable songs (artist and album included) without adding them to the library. */
export function registerStreams(songs: StreamSong[]) {
  const s = getState();
  let tracks = s.tracks;
  let artists = s.artists;
  let albums = s.albums;
  for (const song of songs) {
    if (!canStream(song.candidate)) continue;
    const id = streamTrackId(song.key);
    streamSources.set(id, { candidate: song.candidate, kind: song.kind, key: song.key });
    if (tracks[id]) continue;
    if (tracks === s.tracks) [tracks, artists, albums] = [{ ...tracks }, { ...artists }, { ...albums }];
    const name = song.artist.trim() || "Unknown artist";
    let artist = Object.values(artists).find((a) => a.name.toLowerCase() === name.toLowerCase());
    if (!artist) {
      const h = hashString(name);
      artist = { id: `ar_${h}`, name, genre: GENRES[h % GENRES.length], palette: paletteFromSeed(h), listeners: 0 };
      artists[artist.id] = artist;
    }
    const seed = hashString(song.key);
    const albumId = `al_stream_${seed}`;
    const meta = song.candidate.importMetadata;
    albums[albumId] = {
      id: albumId,
      title: meta?.album?.trim() || song.title,
      artistId: artist.id,
      year: new Date().getFullYear(),
      palette: paletteFromSeed(seed),
      glyph: seed % 6,
      ...(song.artwork ? { artworkUrl: song.artwork } : {}),
    };
    const duration = meta?.durationSeconds ?? song.candidate.durationSeconds ?? 0;
    tracks[id] = { id, title: song.title, artistId: artist.id, albumId, duration, addedAt: Date.now(), kind: "audio", storage: "files", size: 0, plays: 0, seed, stream: true };
  }
  if (tracks !== s.tracks) setState({ tracks, artists, albums });
}

async function streamSource(id: string) {
  const source = streamSources.get(id);
  if (!source) throw new Error("This suggestion is no longer available.");
  const res = await fetch("/api/import/preview", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ sourceURL: source.candidate.sourceURL }) });
  const body = (await res.json().catch(() => null)) as ApiResult<{ url: string }> | null;
  if (!body || !body.ok) throw new Error(body && !body.ok ? body.error.message : "Its source isn't available right now.");
  return body.result.url;
}

/** Resolves once no import is running (the importer handles one at a time). */
function whenImportIdle() {
  return new Promise<void>((resolve) => {
    if (state.busy !== "import") return resolve();
    const stop = subscribe(() => {
      if (state.busy === "import") return;
      stop();
      resolve();
    });
  });
}

/** A queued save stays pending while the user reviews its source in Search. */
function whenReviewFinished(candidate: Candidate) {
  return new Promise<void>((resolve) => {
    const check = () => {
      const route = getState().route;
      if (discovery?.candidate === candidate && (route.name !== "search" || route.q !== state.source)) discovery = null;
      if (discovery?.candidate === candidate || state.busy === "import") return;
      stopApp(); stopImport(); resolve();
    };
    const stopApp = subscribeApp(check);
    const stopImport = subscribe(check);
    check();
  });
}

/** Saves of streamed songs, run one after another so none is turned away while another imports. */
let saving: Promise<void> = Promise.resolve();
/** Songs waiting to be saved, each with everything to do once it is in the library (join a playlist, get liked…). */
const queuedSaves = new Map<string, Array<(libraryId: string) => void>>();

/** Adds a streamed song to the library without restarting playback, then hands `then` its library id. */
function saveStreamToLibrary(id: string, then?: (libraryId: string) => void) {
  const source = streamSources.get(id);
  if (!source) return;
  // Already queued: this request waits for the same import instead of starting another.
  const waiting = queuedSaves.get(id);
  if (waiting) {
    if (then) waiting.push(then);
    return;
  }
  if (state.busy === "import" || queuedSaves.size) toast(`“${source.candidate.importMetadata?.title || source.candidate.title || "This song"}” will be added next`);
  queuedSaves.set(id, then ? [then] : []);
  const done = (libraryId: string) => {
    linkSavedStream(id, libraryId);
    for (const next of queuedSaves.get(id) ?? []) next(libraryId);
  };
  saving = saving
    .then(whenImportIdle)
    .then(async () => {
      if (source.candidate.requiresReview) {
        reviewDiscoveredSong(source.candidate, source.kind, { play: false, done });
        await whenReviewFinished(source.candidate);
        await whenImportIdle();
      } else await addDiscoveredSong(source.candidate, source.kind, { play: false, done });
    })
    .catch(() => undefined)
    .finally(() => queuedSaves.delete(id));
}

connectStreams({
  source: streamSource,
  save: saveStreamToLibrary,
  dismiss: (id) => {
    const source = streamSources.get(id);
    if (source) hideDiscovery(source.key, source.kind);
  },
});

export async function checkImportService() {
  try {
    const res = await fetch("/api/health", { cache: "no-store" });
    const body = (await res.json()) as { ok?: boolean; import?: boolean };
    set({ available: Boolean(res.ok && body?.ok && body.import) });
  } catch {
    set({ available: false });
  }
  return state.available;
}

/* ───────────────────────── server library → app catalog ───────────────────────── */

const GENRES: Genre[] = ["indie", "lofi", "synthwave", "house", "ambient"];

const serverAlbumTitle = (p: ServerTrack) => p.album?.trim() && !/^(import|imported)$/i.test(p.album.trim()) ? p.album.trim() : p.title;

function placeServerTrack(p: ServerTrack, artists: Record<string, Artist>, albums: Record<string, Album>): Track {
  const name = p.artist?.trim() || "Unknown artist";
  let artist = Object.values(artists).find((a) => a.name.toLowerCase() === name.toLowerCase());
  if (!artist) {
    const h = hashString(name);
    artist = { id: `ar_${h}`, name, genre: GENRES[h % GENRES.length], palette: paletteFromSeed(h), listeners: 0 };
    artists[artist.id] = artist;
  }
  const seed = hashString(p.id);
  const albumId = `al_srv_${p.id}`;
  albums[albumId] = {
    id: albumId,
    title: serverAlbumTitle(p),
    artistId: artist.id,
    year: new Date(p.addedAt || Date.now()).getFullYear(),
    palette: paletteFromSeed(seed),
    glyph: seed % 6,
    ...(p.artworkUrl ? { artworkUrl: p.artworkUrl } : {}),
  };
  return {
    id: `srv_${p.id}`,
    title: p.title,
    artistId: artist.id,
    albumId,
    duration: p.durationSeconds || 0,
    addedAt: p.addedAt || Date.now(),
    kind: p.mediaKind === "video" ? "video" : "audio",
    storage: "files",
    size: p.size || 0,
    plays: 0,
    seed,
    mediaUrl: p.mediaUrl,
    serverId: p.id,
    sourceUrl: p.sourceURL ?? undefined,
  };
}

/** Adds (or finds) an imported song in the app library and returns its track id. */
export function addServerTrack(p: ServerTrack, { uploaded = false } = {}) {
  cancelServerDelete(p.id);
  const s = getState();
  const id = `srv_${p.id}`;
  const existing = s.tracks[id];
  if (existing) {
    if (uploaded && !existing.uploaded) setState({ tracks: { ...s.tracks, [id]: { ...existing, uploaded: true } } });
    return id;
  }
  const artists = { ...s.artists };
  const albums = { ...s.albums };
  const track = { ...placeServerTrack(p, artists, albums), ...(uploaded ? { uploaded: true } : {}) };
  setState({ artists, albums, tracks: { ...s.tracks, [id]: track }, trackIds: [id, ...s.trackIds] });
  return id;
}

/**
 * Brings the app library in line with the import API's library: adds songs the
 * browser has not seen and drops ones whose files are gone. Saved state keeps
 * plays, playlists, and ordering between reloads.
 */
export async function syncServerLibrary() {
  let list: ServerTrack[];
  try {
    const res = await fetch("/api/library", { cache: "no-store" });
    const body = (await res.json()) as { ok?: boolean; tracks?: ServerTrack[] };
    if (!res.ok || !body?.ok || !Array.isArray(body.tracks)) throw new Error("library unavailable");
    list = body.tracks;
    set({ available: true });
  } catch {
    // Without the API (e.g. a static build) saved imports stay listed but cannot play.
    set({ available: false });
    return;
  }
  retryServerDeletes();
  const s = getState();
  const live = new Set(list.map((t) => `srv_${t.id}`));
  const gone = new Set(Object.values(s.tracks).filter((t) => t.serverId && !live.has(t.id)).map((t) => t.id));
  const keep = (id: string) => !gone.has(id);
  const artists = { ...s.artists };
  const albums = { ...s.albums };
  const tracks = { ...s.tracks };
  for (const id of gone) delete tracks[id];
  const fresh: string[] = [];
  let refreshed = false;
  for (const p of list) {
    if (isServerDeletePending(p.id)) continue;
    const id = `srv_${p.id}`;
    const known = tracks[id];
    if (known) {
      // Refresh what the server knows better (duration probe, artwork).
      if (p.durationSeconds && Math.abs(known.duration - p.durationSeconds) > 0.5) {
        tracks[id] = { ...known, duration: p.durationSeconds };
        refreshed = true;
      }
      const album = albums[known.albumId];
      if (album && ((p.artworkUrl ?? undefined) !== album.artworkUrl || album.title !== serverAlbumTitle(p))) {
        albums[known.albumId] = { ...album, title: serverAlbumTitle(p), artworkUrl: p.artworkUrl ?? undefined };
        refreshed = true;
      }
      continue;
    }
    tracks[id] = placeServerTrack(p, artists, albums);
    fresh.push(id);
  }
  if (!gone.size && !fresh.length && !refreshed) return;
  // The song playing may be one whose file is gone (e.g. started before this check finished).
  const wasCurrent = Boolean(s.currentId && gone.has(s.currentId));
  if (wasCurrent) engine.unload();
  setState({
    artists,
    albums,
    tracks,
    trackIds: [...fresh, ...s.trackIds.filter(keep)],
    playlists: s.playlists.map((p) => (p.trackIds.some((id) => gone.has(id)) ? { ...p, trackIds: p.trackIds.filter(keep) } : p)),
    listens: s.listens.filter((l) => keep(l.id)),
    history: s.history.filter(keep),
    upNext: s.upNext.filter(keep),
    order: s.order.filter(keep),
    // Cursor = last surviving entry at or before the old cursor, as in deleteFromDevice.
    index: s.order.slice(0, s.index + 1).filter(keep).length - 1,
    context: s.context ? { ...s.context, ids: s.context.ids.filter(keep) } : null,
    ...(wasCurrent ? { currentId: null, isPlaying: false } : {}),
  });
  if (wasCurrent && "mediaSession" in navigator) {
    navigator.mediaSession.metadata = null;
    navigator.mediaSession.playbackState = "none";
  }
}

/* ───────────────────────── dialog state ───────────────────────── */

let autoTimer = 0;
let resolveController: AbortController | null = null;
let importController: AbortController | null = null;

const sourceKey = (kind: MediaKind, source: string) => `${kind}:${source.trim()}`;

export function canUploadToServer() {
  const s = getState();
  return s.server.status === "connected" && s.settings.uploadMode !== "off";
}

function clearAuto() {
  clearTimeout(autoTimer);
  autoTimer = 0;
}

function scheduleResolve(immediate = false) {
  clearAuto();
  if (state.busy) return;
  const source = state.source.trim();
  if (!sourceIsReady(source)) return;
  if (state.resolution && state.resolvedKey === sourceKey(state.mediaKind, source)) return;
  autoTimer = window.setTimeout(() => {
    autoTimer = 0;
    void resolveImport();
  }, immediate ? 0 : AUTO_RESOLVE_DELAY);
}

/** Called when the dialog opens: a fresh form unless an import is still downloading. */
export function prepareImportDialog() {
  if (state.busy === "import") return;
  if (discovery) {
    // Opened from a discovery card: the dialog shows only that suggestion, already selected.
    const { candidate } = discovery;
    if (state.resolution?.candidates[0] === candidate) return;
    stopPreview({ resume: true });
    resolveController?.abort();
    resolveController = null;
    clearAuto();
    const source = candidate.importMetadata?.sourcePageURL || candidate.sourcePageURL || candidate.sourceURL;
    const resolution: Resolution = { kind: "search_results", mediaKind: "audio", track: candidate.importMetadata || candidate, candidates: [candidate] };
    set({ ...blank(), source, resolution, resolvedKey: sourceKey("audio", source), selected: [0], stage: "awaiting_selection", upload: canUploadToServer(), providerFocus: candidate.searchProvider ?? "youtube", available: true });
    return;
  }
  if (state.available !== true) void checkImportService();
  if (state.busy === "resolve" || state.source || state.resolution || state.error || state.stage !== "idle") {
    stopPreview({ resume: true });
    resolveController?.abort();
    resolveController = null;
    clearAuto();
    set(blank());
  }
}

function onDialogClosed() {
  if (state.busy !== "import") discovery = null;
  stopPreview({ resume: true });
  clearAuto();
  if (state.busy === "resolve") {
    resolveController?.abort();
    resolveController = null;
    set({ busy: null, stage: "idle" });
  }
}

/** Clears the resolved source, as editing the link or media kind did in Resonance. */
function invalidate(patch: Partial<ImportState>) {
  // Editing the link or kind means this is no longer the suggested song.
  discovery = null;
  if (state.busy === "resolve") {
    resolveController?.abort();
    resolveController = null;
  }
  stopPreview({ resume: true });
  set({ resolution: null, resolvedKey: null, selected: [], error: null, stage: "idle", progress: null, busy: state.busy === "import" ? "import" : null, ...patch });
}

export function setImportSource(value: string) {
  if (state.busy === "import") return;
  const provider = providerForSource(value);
  invalidate({
    source: value,
    mediaKind: isAudioOnlySource(value) ? "audio" : state.mediaKind,
    ...(provider ? { providerFocus: provider } : {}),
  });
  scheduleResolve();
}

export function setImportKind(kind: MediaKind) {
  if (state.busy === "import" || kind === state.mediaKind) return;
  if (kind === "video" && isAudioOnlySource(state.source)) return;
  invalidate({ mediaKind: kind });
  scheduleResolve(true);
}

export function setImportUpload(upload: boolean) {
  set({ upload });
}

/** Providers that returned search results, in tab order. */
export function resultProviders(r: Resolution | null) {
  if (r?.kind !== "search_results") return [];
  return PROVIDERS.map(([p]) => p).filter((p) => r.candidates.some((c) => c.searchProvider === p));
}

/** The tab to show: the preferred provider if it has results, else the first that does. */
export function activeProvider(r: Resolution | null, preferred: Provider) {
  const list = resultProviders(r);
  return list.includes(preferred) ? preferred : list[0] ?? preferred;
}

function firstPickIn(r: Resolution, provider: Provider) {
  return r.candidates.findIndex((c) => c.searchProvider === provider && isDownloadable(c));
}

/** Switches the search-results tab; the selection moves to that list so nothing hidden gets imported. */
export function setProviderFocus(providerFocus: Provider) {
  const r = state.resolution;
  if (state.busy === "import" || !r || r.kind !== "search_results") {
    set({ providerFocus });
    return;
  }
  // A preview from another tab would keep playing with no visible control, so stop it.
  if (state.preview && r.candidates[state.preview.index]?.searchProvider !== providerFocus) stopPreview({ resume: true });
  const selectedHere = state.selected.some((i) => r.candidates[i]?.searchProvider === providerFocus);
  const pick = firstPickIn(r, providerFocus);
  set({ providerFocus, ...(selectedHere ? {} : { selected: pick >= 0 ? [pick] : [] }) });
}

export function toggleCandidate(index: number) {
  if (state.busy || !state.resolution) return;
  if (isPlaylist(state.resolution)) {
    set({ selected: state.selected.includes(index) ? state.selected.filter((i) => i !== index) : [...state.selected, index].sort((a, b) => a - b) });
  } else set({ selected: [index] });
}

export function setAllCandidates(on: boolean) {
  if (state.busy || !state.resolution) return;
  set({ selected: on ? state.resolution.candidates.map((c, i) => (isDownloadable(c) ? i : -1)).filter((i) => i >= 0) : [] });
}

function fail(f: ImportFailure) {
  set({ error: f, stage: f.code === "CANCELLED" ? "cancelled" : "failed" });
  // The dialog may be closed while a download runs in the background.
  if (getState().modal?.type !== "import" && f.code !== "CANCELLED") toast(f.message, { tone: "error", detail: `Import stopped while ${f.stage.replaceAll("_", " ")}.`, duration: 7000 });
}

/** Searches all providers for text, or inspects a pasted link. */
export async function resolveImport() {
  clearAuto();
  if (state.busy === "import") return;
  const source = state.source.trim();
  if (isAudioOnlySource(source) && state.mediaKind === "video") set({ mediaKind: "audio" });
  if (!source) {
    fail({ stage: "resolving_metadata", message: "Enter a song, artist, album, or supported Spotify, SoundCloud, or YouTube link first." });
    return;
  }
  resolveController?.abort();
  stopPreview({ resume: true });
  const controller = new AbortController();
  resolveController = controller;
  const kind = state.mediaKind;
  set({ busy: "resolve", resolution: null, resolvedKey: null, selected: [], error: null, progress: null, stage: inputIsLink(source) ? "resolving_metadata" : "searching_candidates" });
  try {
    const result = await streamCall<Resolution>("/api/import/resolve", { source, mediaKind: kind }, controller.signal, (p) => {
      if (resolveController !== controller) return;
      set({ stage: p.stage, progress: p.total ? { completed: p.completed ?? 0, total: p.total } : null });
    }, "resolving_metadata");
    if (resolveController !== controller) return;
    if (!result.ok) throw result.error;
    const resolution = result.result;
    const playlist = isPlaylist(resolution);
    const search = resolution.kind === "search_results";
    const providerFocus = search ? activeProvider(resolution, state.providerFocus) : state.providerFocus;
    const firstPick = search ? firstPickIn(resolution, providerFocus) : resolution.candidates.findIndex(isDownloadable);
    set({
      providerFocus,
      resolution,
      resolvedKey: sourceKey(resolution.mediaKind, source),
      mediaKind: resolution.mediaKind,
      stage: "awaiting_selection",
      progress: null,
      selected: playlist ? resolution.candidates.map((c, i) => (isDownloadable(c) ? i : -1)).filter((i) => i >= 0) : firstPick >= 0 ? [firstPick] : [],
      upload: canUploadToServer(),
      available: true,
    });
  } catch (error) {
    if (resolveController !== controller) return;
    const f = asFailure(error, "resolving_metadata");
    if (f.code === "CANCELLED") set({ stage: "idle" });
    else fail(f);
  } finally {
    if (resolveController === controller) {
      resolveController = null;
      set({ busy: null });
    }
  }
}

/* ───────────────────────── downloading ───────────────────────── */

let transferToast = 0;
let transferToastClosed = false;
let lastToastKey = "";

function transferToastAlive() {
  return transferToast !== 0 && getState().toasts.some((t) => t.id === transferToast);
}

function showTransfer() {
  const { stage, progress, transferName } = state;
  const ratio = stage === "downloading" && progress?.total ? progress.completed / progress.total : -1;
  const batch = batchProgress;
  const overall = batch ? (batch.index + Math.max(0, ratio)) / batch.total : ratio;
  const title = stageLabel(stage) || "Importing";
  const key = `${title}|${transferName}|${Math.round(overall * 100)}`;
  if (key === lastToastKey) return;
  lastToastKey = key;
  const progressValue = overall < 0 && !batch ? -1 : Math.max(0, overall);
  if (transferToastAlive()) updateToast(transferToast, { message: title, detail: transferName, progress: progressValue });
  else if (!transferToastClosed) {
    // Dismissing the toast hides progress for this import; the download keeps going.
    if (transferToast) transferToastClosed = true;
    else transferToast = toast(title, { detail: transferName, progress: progressValue, sticky: true, action: { label: "Cancel", run: cancelImport } });
  }
}

function finishTransfer(message: string, opts: Parameters<typeof toast>[1] = {}) {
  const { duration = 6000, ...rest } = opts;
  if (transferToastAlive()) updateToast(transferToast, { message, detail: undefined, progress: undefined, sticky: false, tone: "default", action: undefined, ...rest }, duration);
  else toast(message, { duration, ...rest });
  transferToast = 0;
  transferToastClosed = false;
  lastToastKey = "";
}

let batchProgress: { index: number; total: number } | null = null;

/** Mirrors Resonance's source identity so the API can recognise duplicates across providers. */
function sourceIdentity(c: Candidate, metadata: SourceTrack) {
  const match = c.match ?? {};
  const mediaProvider = c.sourceProvider || c.searchProvider || "unknown";
  const mediaProviderID = c.providerID || c.candidateID || c.videoID || c.trackID || null;
  const mediaPageURL = c.sourcePageURL || c.sourceURL || null;
  const metadataProvider = metadata.provider || (metadata.trackID ? c.searchProvider : null) || mediaProvider;
  const metadataProviderID = metadata.trackID || (metadataProvider === mediaProvider ? mediaProviderID : null);
  const metadataPageURL = metadata.sourcePageURL || metadata.sourceURL || (metadataProvider === mediaProvider ? mediaPageURL : null);
  const num = (v: unknown) => (Number.isFinite(Number(v)) && v !== null && v !== undefined ? Number(v) : null);
  const evidence = {
    evidenceStrength: null,
    requiresReview: c.requiresReview === true,
    actionable: c.actionable !== false,
    sourceKind: c.sourceKind || null,
    searchProvider: c.searchProvider || null,
    matchedMediaProvider: mediaProvider,
    matchedMediaProviderID: mediaProviderID,
    matchedMediaReference: c.mediaSourceURL || c.sourceURL || null,
    titleScore: num(match.title),
    artistScore: num(match.artist),
    albumScore: num(match.album),
    durationScore: num(match.duration),
    durationDeltaSeconds: num(match.durationDeltaSeconds),
  };
  const identity: Record<string, unknown> = {
    provider: metadataProvider,
    providerID: metadataProviderID,
    sourcePageURL: metadataPageURL,
    confidence: c.confidence || null,
    score: num(c.score),
    evidence,
  };
  const same = metadataProvider === mediaProvider && String(metadataProviderID || "") === String(mediaProviderID || "") && String(metadataPageURL || "") === String(mediaPageURL || "");
  if (same) {
    identity.mediaSourceURL = c.mediaSourceURL || c.sourceURL || null;
    return identity;
  }
  identity.aliases = [{
    provider: mediaProvider,
    providerID: mediaProviderID,
    sourcePageURL: mediaPageURL,
    mediaSourceURL: c.mediaSourceURL || c.sourceURL || null,
    confidence: c.confidence || null,
    score: num(c.score),
    evidence: { ...evidence, identityRole: "matched_media" },
  }];
  return identity;
}

function importMetadata(c: Candidate, meta: SourceTrack) {
  return {
    provider: meta.provider || c.searchProvider || null,
    trackID: meta.trackID || null,
    title: meta.title || c.title || "Untitled",
    artist: meta.artist || c.artist || "Unknown artist",
    album: meta.album || null,
    durationSeconds: meta.durationSeconds ?? c.durationSeconds ?? null,
    artworkURL: meta.artworkURL || c.thumbnailURL || null,
    sourceURL: meta.sourceURL || c.sourceURL,
    sourcePageURL: meta.sourcePageURL || meta.sourceURL || null,
  };
}

type StartResult = { kind: "created" | "duplicate"; track: ServerTrack };

function startDownload(c: Candidate, meta: SourceTrack, kind: MediaKind, signal: AbortSignal) {
  const metadata = importMetadata(c, meta);
  return streamCall<StartResult>("/api/import/start", {
    sourceURL: c.sourceURL,
    sourceIdentity: sourceIdentity(c, metadata),
    mediaKind: kind,
    metadata,
    durationSeconds: metadata.durationSeconds,
  }, signal, (p) => {
    if (importController?.signal !== signal) return;
    set({ stage: p.stage, progress: p.total ? { completed: p.completed ?? 0, total: p.total } : null });
    showTransfer();
  }, "inspecting_source");
}

function sleep(ms: number, signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    const timer = window.setTimeout(resolve, ms);
    signal.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(new DOMException("Import cancelled", "AbortError"));
    }, { once: true });
  });
}

/** Starts downloading the selected source (or playlist songs). The dialog closes; a toast tracks progress. */
export async function confirmImport() {
  const resolution = state.resolution;
  if (state.busy || !resolution) return;
  if (isPlaylist(resolution)) return confirmPlaylist(resolution);
  const kind = resolution.mediaKind;
  const candidate = resolution.candidates[state.selected[0]];
  if (!candidate) {
    fail({ stage: "awaiting_selection", message: `Choose one ${kind} source to import.` });
    return;
  }
  const meta = candidate.importMetadata || resolution.track;
  const upload = state.upload && canUploadToServer();
  // A discovery suggestion plays as soon as it is in the library.
  const discovered = discovery?.candidate === candidate ? discovery : null;
  discovery = null;
  const controller = begin(meta.title || candidate.title || (kind === "video" ? "Video import" : "Audio import"));
  try {
    const result = await startDownload(candidate, meta, kind, controller.signal);
    if (!result.ok) throw result.error;
    const id = addServerTrack(result.result.track, { uploaded: upload });
    if (discovered) {
      keepDiscovery(discovered.kind);
      if (discovered.play !== false) playList([id], id, { label: "Discovered for you", route: { name: "library" }, picks: { [id]: discovered.kind } });
      discovered.done?.(id);
    }
    const title = result.result.track.title;
    const play = { label: "Play", run: () => playList([id], id, { label: "Imported", route: { name: "library" } }) };
    if (result.result.kind === "duplicate") {
      finishTransfer(`“${title}” is already in your library`, { action: play });
    } else {
      finishTransfer(`${kind === "video" ? "Downloaded" : "Imported"} “${title}”`, {
        tone: "success",
        detail: upload ? "Saved on this device and uploaded to your server." : "Saved on this device.",
        action: play,
      });
    }
    set({ stage: "complete", progress: null });
  } catch (error) {
    const f = asFailure(error, state.stage === "idle" ? "inspecting_source" : state.stage);
    if (f.code === "CANCELLED") finishTransfer("Import cancelled");
    else {
      finishTransfer("Import failed", { tone: "error", detail: failureText(f), duration: 8000 });
      set({ error: f, stage: "failed" });
    }
    if (f.code === "CANCELLED") set({ stage: "cancelled" });
  } finally {
    end(controller);
  }
}

function begin(name: string) {
  stopPreview({ resume: true });
  clearAuto();
  importController?.abort();
  const controller = new AbortController();
  importController = controller;
  transferToast = 0;
  transferToastClosed = false;
  lastToastKey = "";
  set({ busy: "import", error: null, stage: "inspecting_source", progress: null, transferName: name });
  if (getState().modal?.type === "import") closeModal();
  showTransfer();
  return controller;
}

function end(controller: AbortController) {
  if (importController !== controller) return;
  importController = null;
  batchProgress = null;
  set({ busy: null, progress: null });
}

/** One transfer per provider track, even when a playlist repeats it. */
function transferKey(c: Candidate, kind: MediaKind) {
  const meta = c.importMetadata;
  const metaProvider = (meta?.provider || "").toLowerCase();
  if (metaProvider && !metaProvider.includes("youtube")) {
    const id = [meta?.trackID, meta?.sourcePageURL, meta?.sourceURL].find((v) => typeof v === "string" && v.trim());
    if (id) return `${kind}:${metaProvider}:${id}`;
  }
  const id = [c.videoID, c.providerID, c.candidateID, c.trackID].find((v) => typeof v === "string" && v.trim());
  if (id) return `${kind}:${c.sourceProvider || "source"}:${id}`;
  return c.sourceURL ? `${kind}:url:${c.sourceURL}` : null;
}

async function confirmPlaylist(resolution: Resolution) {
  const kind = resolution.mediaKind;
  const noun = kind === "video" ? "video" : "song";
  const chosen = state.selected.map((i) => resolution.candidates[i]).filter(Boolean);
  if (!chosen.length) {
    fail({ stage: "awaiting_selection", message: `Choose at least one playlist ${noun} to download.` });
    return;
  }
  const seen = new Set<string>();
  const queue = chosen.filter((c) => {
    const key = transferKey(c, kind);
    if (!key) return true;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  const upload = state.upload && canUploadToServer();
  const playlistTitle = resolution.playlist?.title || resolution.track.title || "Imported Playlist";
  const providerName = resolution.kind === "spotify_playlist" ? "Spotify" : resolution.kind === "soundcloud_playlist" ? "SoundCloud" : "YouTube";
  const first = queue[0].importMetadata?.title || queue[0].title || "Playlist item 1";
  batchProgress = { index: 0, total: queue.length };
  const controller = begin(`1 of ${queue.length} • ${first}`);
  const imported: string[] = [];
  const failures: string[] = [];
  let created = 0;
  let duplicates = 0;
  let cancelled = false;
  try {
    for (let index = 0; index < queue.length; index++) {
      if (controller.signal.aborted) {
        cancelled = true;
        break;
      }
      const candidate = queue[index];
      const meta = candidate.importMetadata || candidate;
      batchProgress = { index, total: queue.length };
      set({ transferName: `${index + 1} of ${queue.length} • ${meta.title || candidate.title || `Playlist item ${index + 1}`}`, stage: "inspecting_source", progress: null });
      showTransfer();
      const options = [candidate, ...(candidate.fallbackCandidates ?? []).filter(isDownloadable)];
      let result: ApiResult<StartResult> | null = null;
      // Each source gets three tries, then the next matched source is used.
      sources: for (const option of options) {
        for (let attempt = 0; attempt < 3; attempt++) {
          try {
            if (attempt) await sleep(attempt === 1 ? 400 : 1200, controller.signal);
            result = await startDownload(option, meta, kind, controller.signal);
          } catch (error) {
            if (asFailure(error, "inspecting_source").code === "CANCELLED") {
              cancelled = true;
              break sources;
            }
            result = null;
          }
          if (result?.ok || result?.error.code === "CANCELLED") break sources;
        }
      }
      if (cancelled || (result && !result.ok && result.error.code === "CANCELLED")) {
        cancelled = true;
        break;
      }
      if (!result?.ok) {
        failures.push(`${meta.title || "Untitled"}${meta.artist ? ` — ${meta.artist}` : ""}`);
        continue;
      }
      const id = addServerTrack(result.result.track, { uploaded: upload });
      if (!imported.includes(id)) imported.push(id);
      if (result.result.kind === "duplicate") duplicates++;
      else created++;
    }
  } finally {
    let playlistId: string | null = null;
    if (imported.length) {
      // Same name as the source playlist; importing it again tops it up.
      const existing = getState().playlists.find((p) => !p.system && p.name === playlistTitle);
      if (existing) {
        addToPlaylist(existing.id, imported, { silent: true });
        playlistId = existing.id;
      } else playlistId = createPlaylist(playlistTitle, imported, `Imported from ${providerName}.`);
    }
    const open = playlistId ? { label: "Open", run: () => navigate({ name: "playlist", id: playlistId! }) } : undefined;
    const kept = created + duplicates;
    const plural = (n: number) => `${n} ${noun}${n === 1 ? "" : "s"}`;
    if (cancelled) {
      finishTransfer("Playlist download cancelled", { detail: `Kept ${kept} of ${plural(queue.length)}.`, action: open });
      set({ stage: "cancelled" });
    } else if (failures.length) {
      finishTransfer(`Kept ${kept} of ${plural(queue.length)}`, { tone: "error", detail: `Failed after retrying: ${failures.slice(0, 3).join("; ")}${failures.length > 3 ? ` and ${failures.length - 3} more` : ""}.`, action: open, duration: 9000 });
      set({ stage: "failed", error: { stage: "downloading", message: `${failures.length} ${noun}${failures.length === 1 ? "" : "s"} could not be downloaded.` } });
    } else {
      finishTransfer(`Kept ${plural(kept)} from “${playlistTitle}”`, {
        tone: "success",
        detail: [duplicates ? `${duplicates} already in your library.` : null, upload ? "Uploaded to your server." : null].filter(Boolean).join(" ") || "Saved on this device.",
        action: open,
      });
      set({ stage: "complete" });
    }
    end(controller);
  }
}

export function cancelImport() {
  if (state.busy === "import") {
    importController?.abort();
    if (transferToastAlive()) updateToast(transferToast, { detail: "Cancelling transfer…" });
  } else if (state.busy === "resolve") {
    resolveController?.abort();
    resolveController = null;
    set({ busy: null, stage: "cancelled", progress: null });
  }
}

/* ───────────────────────── 30-second previews ───────────────────────── */

const previewAudio = typeof Audio === "undefined" ? null : new Audio();
let previewRequest = 0;
let previewController: AbortController | null = null;
let previewLimit = 30;
let interruptedMain = false;

function pauseMain() {
  const s = getState();
  if (!interruptedMain && s.isPlaying && s.listen.mode !== "guest") {
    interruptedMain = true;
    togglePlay();
  }
}

function resumeMain() {
  if (!interruptedMain) return;
  interruptedMain = false;
  const s = getState();
  if (!s.isPlaying && s.currentId) togglePlay();
}

function stopPreview({ resume }: { resume: boolean }) {
  previewRequest++;
  previewController?.abort();
  previewController = null;
  if (previewAudio) {
    previewAudio.pause();
    previewAudio.removeAttribute("src");
    previewAudio.load();
  }
  if (state.preview) set({ preview: null });
  if (resume) resumeMain();
}

if (previewAudio) {
  previewAudio.preload = "auto";
  const reachedLimit = () => {
    if (!previewAudio.paused) previewAudio.pause();
    previewAudio.currentTime = 0;
  };
  previewAudio.ontimeupdate = () => {
    if (previewAudio.currentTime >= previewLimit) reachedLimit();
  };
  previewAudio.onended = reachedLimit;
  previewAudio.onplay = () => {
    if (state.preview) set({ preview: { ...state.preview, status: "playing" } });
  };
  previewAudio.onpause = () => {
    if (state.preview?.status !== "playing") return;
    set({ preview: { ...state.preview, status: "paused" } });
    resumeMain();
  };
}

export async function togglePreview(index: number) {
  const resolution = state.resolution;
  const candidate = resolution?.candidates[index];
  if (!previewAudio || !candidate || !canPreview(resolution, candidate) || state.busy) return;
  const current = state.preview;
  if (current?.index === index && current.status === "loading") {
    stopPreview({ resume: true });
    return;
  }
  if (current?.index === index && previewAudio.getAttribute("src")) {
    if (previewAudio.paused) {
      pauseMain();
      if (previewAudio.currentTime >= previewLimit) previewAudio.currentTime = 0;
      await previewAudio.play().catch(() => undefined);
    } else previewAudio.pause();
    return;
  }
  if (current) stopPreview({ resume: false });
  pauseMain();
  const request = ++previewRequest;
  const controller = new AbortController();
  previewController = controller;
  set({ preview: { index, status: "loading" } });
  try {
    const res = await fetch("/api/import/preview", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ sourceURL: candidate.sourceURL }), signal: controller.signal });
    const body = (await res.json()) as ApiResult<{ url: string; durationSeconds: number }>;
    if (request !== previewRequest) return;
    if (!body?.ok) throw body?.error ?? { message: "This source could not be previewed." };
    previewLimit = Math.max(1, Number(body.result.durationSeconds) || 30);
    const s = getState();
    previewAudio.volume = s.muted ? 0 : s.volume;
    previewAudio.src = body.result.url;
    previewAudio.currentTime = 0;
    // Stays "loading" until playback starts, so the main player can still cancel it.
    await previewAudio.play();
  } catch (error) {
    if (request !== previewRequest) return;
    stopPreview({ resume: true });
    const f = asFailure(error, "previewing");
    if (f.code !== "CANCELLED") toast(f.message || "This source could not be previewed.", { tone: "error" });
  } finally {
    if (previewController === controller) previewController = null;
  }
}

/* ───────────────────────── app wiring ───────────────────────── */

let lastModal = getState().modal?.type;
let lastPlaying = getState().isPlaying;
let lastVolume = `${getState().volume}|${getState().muted}`;
subscribeApp(() => {
  const s = getState();
  const modal = s.modal?.type;
  if (lastModal === "import" && modal !== "import") onDialogClosed();
  lastModal = modal;
  // Starting the main player stops a preview (playing or still loading) without resuming anything later.
  if (s.isPlaying && !lastPlaying && previewAudio) {
    if (state.preview?.status === "loading") {
      interruptedMain = false;
      stopPreview({ resume: false });
    } else if (!previewAudio.paused) {
      interruptedMain = false;
      previewAudio.pause();
    }
  }
  lastPlaying = s.isPlaying;
  const volume = `${s.volume}|${s.muted}`;
  if (volume !== lastVolume && previewAudio) previewAudio.volume = s.muted ? 0 : s.volume;
  lastVolume = volume;
});

// Live audio and app state cannot be swapped in place: when this module (or anything it imports) changes, reload the page.
if (import.meta.hot) import.meta.hot.accept(() => location.reload());
