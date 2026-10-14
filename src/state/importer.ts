import { useSyncExternalStore } from "react";
import { engine } from "../audio/engine";
import { hashString, paletteFromSeed } from "../data/library";
import { isUploadLink, splitArtists, uploadCredit, uploadTitle } from "../lib/credits";
import type { Album, Artist, ClipRange, Genre, Track } from "../data/types";
import { meaningfulArtist, type ReasonKind } from "../recommend/taste";
import {
  addToPlaylist, cancelServerDelete, connectStreams, createPlaylist, hideDiscovery, isServerDeletePending, keepDiscovery, linkSavedStream, navigate,
  playList, retryServerDeletes, toast, togglePlay, updateToast, type StreamMedia,
} from "./actions";
import { dropFromDevice } from "./device";
import { downloadTracks, keepLibraryOnDevice } from "./server";
import { listSongs, pendingSongChanges, updateSong, type ServerSong } from "./song-api";
import { getState, setState, subscribe as subscribeApp, type AppState } from "./store";

/*
 * Saving music from the web, ported from Resonance's local import flow: search
 * Spotify, SoundCloud and YouTube or paste a link, pick a source (or playlist
 * songs), then save in the background while a transfer toast tracks progress.
 * The music server (server/api.mjs, reusing Resonance's provider modules)
 * records each song as its source link with metadata; this device then keeps
 * the song's file (server.ts, device.ts).
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
  /** A search's next page of results, for searchMore; absent when there are no more. */
  more?: string | null;
}

export interface ImportFailure {
  stage: string;
  code?: string;
  message: string;
}

export type Stage =
  | "idle" | "resolving_metadata" | "searching_candidates" | "awaiting_selection" | "inspecting_source" | "downloading"
  | "processing" | "saving_local" | "local_complete" | "complete" | "failed" | "cancelled";

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

/** The next page of a search's results (Resolution.more). */
export async function searchMore(more: string, mediaKind: MediaKind, signal: AbortSignal): Promise<Resolution> {
  const result = await streamCall<Resolution>("/api/import/resolve", { more, mediaKind }, signal, () => undefined, "searching_candidates");
  if (!result.ok) throw result.error;
  return result.result;
}

/** How an added suggestion carries on once it is in the library: played straight away (the default), and/or handed to `done`. */
interface DiscoveryOptions { play?: boolean; done?: (libraryId: string) => void; /** Save it as a video (a YouTube video played as one). */ video?: boolean }

/** The suggestion being reviewed or added, and why it was suggested. */
let discovery: ({ candidate: Candidate; kind: ReasonKind } & DiscoveryOptions) | null = null;

function importBusy() {
  if (state.busy !== "import") return false;
  toast("A song is already importing", { detail: "Wait for it to finish before adding another." });
  return true;
}

/** Shows just this suggestion in Search, to listen to it or check its source before saving. */
export function reviewDiscoveredSong(candidate: Candidate, kind: ReasonKind, options: DiscoveryOptions = {}) {
  if (!isDownloadable(candidate) || importBusy()) return;
  discovery = { candidate, kind, ...options };
  prepareImportDialog();
  navigate({ name: "search", q: state.source });
}

/** Saves the chosen search results through the same download pipeline as the import dialog. */
export async function saveSearchResults(source: string, resolution: Resolution, selected: number[]) {
  if (importBusy()) return;
  resolveController?.abort();
  clearAuto();
  stopPreview({ resume: true });
  // A suggestion under review keeps its playlist/like follow-ups only if it is what's being saved.
  if (discovery?.candidate !== resolution.candidates[selected[0]]) discovery = null;
  set({
    source,
    resolution,
    selected: selected.filter((i) => isDownloadable(resolution.candidates[i])),
    mediaKind: resolution.mediaKind,
    busy: null,
    error: null,
  });
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
export interface StreamSong {
  key: string; candidate: Candidate; title: string; artist: string; artwork?: string; kind: ReasonKind;
  /**
   * true: a video that's also saved as one (found under Videos, or a host's video
   * in Listen Along). false: audio only. Unset: a YouTube video streams as video
   * and is saved as audio, like any song.
   */
  video?: boolean;
  /** The release it's from, when known (a catalog album's tracks). */
  album?: string; released?: string;
}

const streamSources = new Map<string, { candidate: Candidate; kind: ReasonKind; key: string; video: boolean; saveVideo: boolean }>();

/**
 * A result that is a YouTube video (not a YouTube Music track, and not a match
 * found for a Spotify or SoundCloud song), so it has a picture worth streaming.
 */
const isYouTubeVideo = (c: Candidate) =>
  c.sourceProvider === "youtube" && (!c.searchProvider || c.searchProvider === "youtube") && c.importMetadata?.provider !== "spotify" && c.importMetadata?.provider !== "soundcloud";

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
    const youtube = song.candidate.sourceProvider !== "soundcloud";
    const video = youtube && (song.video ?? isYouTubeVideo(song.candidate));
    streamSources.set(id, { candidate: song.candidate, kind: song.kind, key: song.key, video, saveVideo: youtube && song.video === true });
    if (tracks[id]) continue;
    if (tracks === s.tracks) [tracks, artists, albums] = [{ ...tracks }, { ...artists }, { ...albums }];
    const credit = song.candidate.importMetadata?.provider !== "spotify" && isUploadLink(song.candidate.sourceURL) ? uploadCredit(song.artist, song.title) : { artist: song.artist, title: song.title };
    const { artist, featuring } = creditedArtists(credit.artist, artists);
    const seed = hashString(song.key);
    const albumId = `al_stream_${seed}`;
    const meta = song.candidate.importMetadata;
    albums[albumId] = {
      id: albumId,
      title: song.album || meta?.album?.trim() || song.title,
      artistId: artist.id,
      ...(song.released ? { year: Number(song.released.slice(0, 4)), released: song.released } : {}),
      palette: paletteFromSeed(seed),
      glyph: seed % 6,
      ...(song.artwork ? { artworkUrl: song.artwork } : {}),
    };
    const duration = meta?.durationSeconds ?? song.candidate.durationSeconds ?? 0;
    tracks[id] = { id, title: credit.title, artistId: artist.id, ...featuring, albumId, duration, addedAt: Date.now(), kind: video ? "video" : "audio", storage: "files", size: 0, plays: 0, seed, stream: true };
  }
  if (tracks !== s.tracks) setState({ tracks, artists, albums });
}

/** The platform a song was found on (YouTube, Spotify or SoundCloud), from its source link or the search that found it. */
export function trackPlatform(t: Track): Provider | null {
  const found = streamSources.get(t.id)?.candidate;
  if (found?.searchProvider) return found.searchProvider;
  const url = found?.sourceURL ?? t.sourceUrl ?? t.playableUrl;
  if (!url) return null;
  try {
    const host = new URL(url).hostname.replace(/^(www|m|music)\./, "");
    if (host === "youtube.com" || host === "youtu.be") return "youtube";
    if (host === "open.spotify.com" || host === "spotify.com") return "spotify";
    if (host === "soundcloud.com" || host === "on.soundcloud.com") return "soundcloud";
  } catch {
    // Not a link.
  }
  return null;
}

/** Where a streamed song's audio comes from, for sharing it (Listen Along). */
export const streamLink = (id: string) => streamSources.get(id)?.candidate.sourceURL ?? null;

/** Videos being prepared for streamed songs, so playing one again meanwhile doesn't prepare it twice. */
const pictures = new Map<string, Promise<string | null>>();

async function streamSource(id: string): Promise<StreamMedia> {
  const source = streamSources.get(id);
  if (!source) throw new Error("This suggestion is no longer available.");
  const fetchPreview = async (mediaKind: MediaKind) => {
    const res = await fetch("/api/import/preview", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ sourceURL: source.candidate.sourceURL, mediaKind }) });
    const body = (await res.json().catch(() => null)) as ApiResult<{ url: string }> | null;
    if (!body || !body.ok) throw new Error(body && !body.ok ? body.error.message : "Its source isn't available right now.");
    return body.result.url;
  };
  if (!source.video) return { url: await fetchPreview("audio") };
  /*
   * A video takes a while to prepare (its picture and sound are fetched separately
   * and joined), so the song starts on its audio, which comes much sooner, and the
   * picture joins once it's ready. A video prepared already starts as one.
   */
  let picture = pictures.get(id);
  if (!picture) {
    picture = fetchPreview("video").then(
      (url) => url,
      () => {
        // A video YouTube won't hand over as one MP4 plays on as audio.
        source.video = false;
        setState((s) => (s.tracks[id] ? { tracks: { ...s.tracks, [id]: { ...s.tracks[id], kind: "audio" } } } : {}));
        return null;
      },
    );
    pictures.set(id, picture);
    void picture.finally(() => pictures.delete(id));
  }
  type First = { url: string } | { error: unknown } | { video: string };
  const audio: Promise<First> = fetchPreview("audio").then((url) => ({ url }), (error: unknown) => ({ error }));
  const first = await Promise.race([audio, picture.then((url): First | Promise<First> => (url ? { video: url } : audio))]);
  if ("video" in first) return { url: first.video };
  if ("error" in first) {
    const url = await picture;
    if (url) return { url };
    throw first.error;
  }
  return { url: first.url, picture };
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

/**
 * Resolves once the user has finished reviewing `candidate` in Search: they saved
 * it (and the save finished), or left that search, which abandons the review.
 */
function whenReviewFinished(candidate: Candidate) {
  return new Promise<void>((resolve) => {
    const check = () => {
      const route = getState().route;
      const reviewing = discovery?.candidate === candidate;
      if (reviewing && (route.name !== "search" || route.q !== state.source)) discovery = null;
      if (discovery?.candidate === candidate || state.busy === "import") return;
      stopApp();
      stopImport();
      resolve();
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
        reviewDiscoveredSong(source.candidate, source.kind, { play: false, done, video: source.saveVideo });
        await whenReviewFinished(source.candidate);
        await whenImportIdle();
      } else await addDiscoveredSong(source.candidate, source.kind, { play: false, done, video: source.saveVideo });
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

/** When the song came out, as the server looked it up (see backfillReleases in server/api.mjs). */
function releaseOf(p: ServerSong): { year?: number; released?: string } {
  const released = p.extra?.["release.date"];
  return typeof released === "string" && /^\d{4}-\d{2}-\d{2}$/.test(released) ? { year: Number(released.slice(0, 4)), released } : {};
}

/** A song with no album (the server drops old "Imported" placeholders) is shown as its own single. */
const serverAlbumTitle = (p: ServerSong) => p.album?.trim() || songTitle(p);
/** Uploads keep their video titles on the server; shown as the song's name here. */
const songTitle = (p: ServerSong) => (isUploadLink(p.sourceURL) ? uploadTitle(p.artist ?? "", p.title) : p.title);
/**
 * Whether a track's artists are the server credit's, one by one. (Compared as
 * one string, an artist saved as "Lady Gaga, Bruno Mars" would pass for two.)
 */
const sameCredit = (t: Track, artists: Record<string, Artist>, credit: string) =>
  JSON.stringify([t.artistId, ...(t.featuring ?? [])].map((id) => artists[id]?.name.toLowerCase())) === JSON.stringify(splitArtists(credit.trim() || "Unknown artist").map((name) => name.toLowerCase()));

/** The artist of this name, added to `artists` if it's new. */
function artistNamed(name: string, artists: Record<string, Artist>) {
  let artist = Object.values(artists).find((a) => a.name.toLowerCase() === name.toLowerCase());
  if (!artist) {
    const h = hashString(name);
    artist = { id: `ar_${h}`, name, genre: GENRES[h % GENRES.length], palette: paletteFromSeed(h), listeners: 0 };
    artists[artist.id] = artist;
  }
  return artist;
}

/** Each credited artist gets their own page; the first is the song's main artist. */
function creditedArtists(credit: string, artists: Record<string, Artist>) {
  const [main, ...others] = splitArtists(credit.trim() || "Unknown artist").map((name) => artistNamed(name, artists));
  // Always set, so a refreshed song that lost its other artists doesn't keep the old ones.
  return { artist: main, featuring: { featuring: others.length ? others.map((a) => a.id) : undefined } };
}

function placeServerTrack(p: ServerSong, artists: Record<string, Artist>, albums: Record<string, Album>): Track {
  const { artist, featuring } = creditedArtists(p.artist ?? "", artists);
  const title = songTitle(p);
  const seed = hashString(p.id);
  const albumId = `al_srv_${p.id}`;
  albums[albumId] = {
    id: albumId,
    title: serverAlbumTitle(p),
    artistId: artist.id,
    ...releaseOf(p),
    palette: paletteFromSeed(seed),
    glyph: seed % 6,
    ...(p.artworkUrl ? { artworkUrl: p.artworkUrl } : {}),
  };
  return {
    id: `srv_${p.id}`,
    title,
    artistId: artist.id,
    ...featuring,
    albumId,
    duration: p.durationSeconds || 0,
    addedAt: p.addedAt || Date.now(),
    kind: p.savedAs === "video" ? "video" : "audio",
    // Streams through the server until this device keeps its copy (see server.ts).
    storage: "server",
    size: 0,
    plays: 0,
    seed,
    mediaUrl: p.fileUrl,
    serverId: p.id,
    sourceUrl: p.sourceURL ?? undefined,
    ...(p.playableURL ? { playableUrl: p.playableURL } : {}),
  };
}

/** Adds (or finds) a saved song in the app library, starts keeping its file on this device, and returns its track id. */
export function addServerTrack(p: ServerSong) {
  cancelServerDelete(p.id);
  const s = getState();
  const id = `srv_${p.id}`;
  if (!s.tracks[id]) {
    const artists = { ...s.artists };
    const albums = { ...s.albums };
    const track = placeServerTrack(p, artists, albums);
    setState({ artists, albums, tracks: { ...s.tracks, [id]: track }, trackIds: [id, ...s.trackIds], ...clipChange(s.clips, id, p) });
  }
  // The server still has the file it just fetched, so this is quick.
  downloadTracks([id], { quiet: true });
  return id;
}

/** A server song's clip is part of its record, so the server's version replaces this device's. */
function clipChange(clips: Record<string, ClipRange>, id: string, p: ServerSong): { clips?: Record<string, ClipRange> } {
  if (pendingSongChanges(p.id)?.clip !== undefined) return {};
  const current = clips[id];
  if (p.clip ? current?.start === p.clip.start && current?.end === p.clip.end : !current) return {};
  const next = { ...clips };
  if (p.clip) next[id] = p.clip;
  else delete next[id];
  return { clips: next };
}

/**
 * Brings the app library in line with the music server: adds songs this browser
 * has not seen, drops ones deleted elsewhere, and refreshes what the server knows
 * better. Saved state keeps plays, playlists, and ordering between reloads.
 * Songs the server still holds old stored audio for are fetched onto this device,
 * after which the server deletes its copy.
 */
export async function syncServerLibrary() {
  let list: ServerSong[];
  try {
    list = await listSongs();
    set({ available: true });
  } catch {
    // Without the server (e.g. a static build) saved songs stay listed; ones kept on this device still play.
    set({ available: false });
    return;
  }
  retryServerDeletes();
  const s = getState();
  const live = new Set(list.map((t) => `srv_${t.id}`));
  const gone = new Set(Object.values(s.tracks).filter((t) => t.serverId && !live.has(t.id)).map((t) => t.id));
  const artists = { ...s.artists };
  const albums = { ...s.albums };
  const tracks = { ...s.tracks };
  let clips = s.clips;
  for (const id of gone) delete tracks[id];
  const fresh: string[] = [];
  let refreshed = false;
  for (const p of list) {
    if (isServerDeletePending(p.id)) continue;
    const id = `srv_${p.id}`;
    const clip = clipChange(clips, id, p);
    if (clip.clips) {
      clips = clip.clips;
      refreshed = true;
    }
    const known = tracks[id];
    if (known) {
      if (known.title !== songTitle(p) || !sameCredit(known, artists, p.artist ?? "") || known.mediaUrl !== p.fileUrl || known.sourceUrl !== (p.sourceURL ?? undefined) || known.playableUrl !== (p.playableURL ?? undefined)) {
        const updated = placeServerTrack(p, artists, albums);
        tracks[id] = { ...known, ...updated, storage: known.storage, size: known.size, plays: known.plays };
        refreshed = true;
      }
      // Refresh what the server knows better (duration probe, artwork, saved as video or audio).
      const kind = p.savedAs === "video" ? "video" : "audio";
      if ((p.durationSeconds && Math.abs(known.duration - p.durationSeconds) > 0.5) || known.kind !== kind) {
        tracks[id] = { ...tracks[id], duration: p.durationSeconds || known.duration, kind };
        if (known.kind !== kind && known.storage === "downloads") {
          tracks[id] = { ...tracks[id], storage: "server", size: 0 };
          void dropFromDevice(id);
        }
        refreshed = true;
      }
      const album = albums[tracks[id].albumId];
      const release = releaseOf(p);
      if (album && ((p.artworkUrl ?? undefined) !== album.artworkUrl || album.title !== serverAlbumTitle(p) || album.released !== release.released || album.year !== release.year)) {
        const { year: _year, released: _released, ...rest } = album;
        albums[tracks[id].albumId] = { ...rest, ...release, title: serverAlbumTitle(p), artworkUrl: p.artworkUrl ?? undefined };
        refreshed = true;
      }
      continue;
    }
    tracks[id] = placeServerTrack(p, artists, albums);
    fresh.push(id);
  }
  if (gone.size || fresh.length || refreshed) applyServerLibrary(s, { artists, albums, tracks, clips, fresh, gone });
  void fixUploadCredits(list);
  void fillArtistPictures();
  // Old stored audio comes onto this device, so the server can let it go.
  const handOver = list.filter((p) => p.serverCopy).map((p) => `srv_${p.id}`);
  if (handOver.length) downloadTracks(handOver, { quiet: true });
  // Songs saved on your other devices (and any whose file this device lost) are kept here too.
  keepLibraryOnDevice();
}

/**
 * Songs saved from uploads before their artist was read from the title ("TV Girl
 * - Not Allowed" by the uploader "elka sarra") are corrected once. Each song is
 * marked as checked, so a name you choose later is never changed back.
 */
let fixingCredits = false;
async function fixUploadCredits(list: ServerSong[]) {
  if (fixingCredits) return;
  fixingCredits = true;
  let changed = false;
  try {
    for (const p of list) {
      if (p.extra?.["credit.checked"] || !isUploadLink(p.sourceURL)) continue;
      const credit = uploadCredit(p.artist || "Unknown artist", p.title || "Untitled");
      // Only a title that still names an artist ("TV Girl - Not Allowed" by its uploader) is rewritten.
      // A song already saved under the title's artist ("Artist" / "Song - Part II") stays as it is.
      const named = /\s[-–—]\s/u.test(p.title || "") && credit.artist.toLowerCase() !== (p.artist || "").toLowerCase();
      const rename = named && (credit.artist !== p.artist || credit.title !== p.title);
      try {
        await updateSong(p.id, { ...(rename ? credit : {}), extra: { "credit.checked": 1 } });
        changed ||= rename;
      } catch {
        // The server is busy or gone: try again on the next sync.
      }
    }
  } finally {
    fixingCredits = false;
  }
  // Shows the corrected names (every song is checked now, so this doesn't repeat).
  if (changed) void syncServerLibrary();
}

/* ───────────────────────── artist pictures ───────────────────────── */

// v2: every artist is asked about again once (v1 had marked artists without pictures for a week).
const PICTURES_TRIED = "slopify.artist-pictures.v2";
const PICTURE_RETRY = 86_400_000;
let fillingPictures = false;

/**
 * Pictures for the artists in your library (sidebar, search, Home, artist cards),
 * from the music catalog. An artist it doesn't know is asked about again the
 * next day; one with a picture keeps it.
 */
export async function fillArtistPictures() {
  if (fillingPictures) return;
  fillingPictures = true;
  try {
    let tried: Record<string, number> = {};
    try {
      localStorage.removeItem("slopify.artist-pictures.v1");
      tried = JSON.parse(localStorage.getItem(PICTURES_TRIED) || "{}") as Record<string, number>;
    } catch { /* Start afresh. */ }
    const s = getState();
    const used = new Set(Object.values(s.tracks).filter((t) => !t.stream).map((t) => t.artistId));
    const wanted = Object.values(s.artists).filter((a) =>
      used.has(a.id) && !a.image && meaningfulArtist(a.name) && !(Date.now() - (tried[a.name.toLowerCase()] ?? 0) < PICTURE_RETRY));
    for (let i = 0; i < wanted.length; i += 12) {
      const batch = wanted.slice(i, i + 12);
      const res = await fetch("/api/catalog/pictures", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ artists: batch.map((a) => a.name) }) });
      const body = (await res.json().catch(() => null)) as { ok?: boolean; result?: { pictures?: Record<string, string | null>; failed?: string[] } } | null;
      // The catalog is down: leave these for the next sync rather than marking them tried.
      if (!res.ok || !body?.ok || !body.result?.pictures) return;
      const pictures = body.result.pictures;
      const artists = { ...getState().artists };
      let changed = false;
      const failed = new Set(body.result.failed ?? []);
      for (const a of batch) {
        // A name the catalog couldn't look up (it was down) is asked about again next time.
        if (!failed.has(a.name)) tried[a.name.toLowerCase()] = Date.now();
        const image = pictures[a.name];
        if (image && artists[a.id] && !artists[a.id].image) {
          artists[a.id] = { ...artists[a.id], image };
          changed = true;
        }
      }
      if (changed) setState({ artists });
      try {
        localStorage.setItem(PICTURES_TRIED, JSON.stringify(tried));
      } catch { /* Storage full: ask again next time. */ }
    }
  } catch {
    // Offline or the server is unavailable: try at the next sync.
  } finally {
    fillingPictures = false;
  }
}

function applyServerLibrary(s: AppState, { artists, albums, tracks, clips, fresh, gone }: {
  artists: Record<string, Artist>; albums: Record<string, Album>; tracks: Record<string, Track>; clips: Record<string, ClipRange>; fresh: string[]; gone: Set<string>;
}) {
  const keep = (id: string) => !gone.has(id);
  for (const id of gone) if (s.tracks[id]?.storage === "downloads") void dropFromDevice(id);
  // The song playing may be one deleted elsewhere (e.g. started before this check finished).
  const wasCurrent = Boolean(s.currentId && gone.has(s.currentId));
  if (wasCurrent) engine.unload();
  setState({
    artists,
    albums,
    tracks,
    clips,
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
    const kind: MediaKind = discovery.video ? "video" : "audio";
    if (state.resolution?.candidates[0] === candidate) return;
    stopPreview({ resume: true });
    resolveController?.abort();
    resolveController = null;
    clearAuto();
    const source = candidate.importMetadata?.sourcePageURL || candidate.sourcePageURL || candidate.sourceURL;
    const resolution: Resolution = { kind: "search_results", mediaKind: kind, track: candidate.importMetadata || candidate, candidates: [candidate] };
    set({ ...blank(), source, mediaKind: kind, resolution, resolvedKey: sourceKey(kind, source), selected: [0], stage: "awaiting_selection", providerFocus: candidate.searchProvider ?? "youtube", available: true });
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
  if (f.code !== "CANCELLED") toast(f.message, { tone: "error", detail: `Import stopped while ${f.stage.replaceAll("_", " ")}.`, duration: 7000 });
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

/** The artist and title to save a result under: an upload's are read from its title ("Artist - Title"). */
function creditFor(c: Candidate, meta: SourceTrack) {
  const title = meta.title || c.title || "Untitled";
  const artist = meta.artist || c.artist || "Unknown artist";
  const upload = meta.provider !== "spotify" && isUploadLink(meta.sourceURL || c.sourceURL);
  return upload ? uploadCredit(artist, title) : { artist, title };
}

function importMetadata(c: Candidate, meta: SourceTrack) {
  return {
    provider: meta.provider || c.searchProvider || null,
    trackID: meta.trackID || null,
    ...creditFor(c, meta),
    album: meta.album || null,
    durationSeconds: meta.durationSeconds ?? c.durationSeconds ?? null,
    artworkURL: meta.artworkURL || c.thumbnailURL || null,
    sourceURL: meta.sourceURL || c.sourceURL,
    sourcePageURL: meta.sourcePageURL || meta.sourceURL || null,
  };
}

type StartResult = { kind: "created" | "duplicate"; track: ServerSong };

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
  // A discovery suggestion plays as soon as it is in the library.
  const discovered = discovery?.candidate === candidate ? discovery : null;
  discovery = null;
  const controller = begin(meta.title || candidate.title || (kind === "video" ? "Video import" : "Audio import"));
  try {
    const result = await startDownload(candidate, meta, kind, controller.signal);
    if (!result.ok) throw result.error;
    const id = addServerTrack(result.result.track);
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
        detail: getState().settings.downloadMode === "verified_file_cache" ? "Saved to your music server and kept on this device." : "Saved to your music server.",
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
      const id = addServerTrack(result.result.track);
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
        detail: duplicates ? `${duplicates} already in your library.` : "Saved to your music server and kept on this device.",
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

let lastPlaying = getState().isPlaying;
let lastVolume = `${getState().volume}|${getState().muted}`;
subscribeApp(() => {
  const s = getState();
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
