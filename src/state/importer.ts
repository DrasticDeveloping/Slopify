import { useSyncExternalStore } from "react";
import { engine } from "../audio/engine";
import { hashString, paletteFromSeed } from "../data/library";
import { isUploadLink, splitArtists, uploadCredit, uploadTitle } from "../lib/credits";
import type { Album, Artist, ClipRange, Genre, Track } from "../data/types";
import { candidateSources, ownedIndex } from "../recommend/owned";
import { meaningfulArtist, type ReasonKind } from "../recommend/taste";
import {
  addToPlaylist, ask, cancelServerDelete, closeModal, connectStreams, createPlaylist, dismissToast, hideDiscovery, isServerDeletePending, keepDiscovery, linkSavedStream, moveInPlaylist,
  navigate, openModal,
  playList, retryServerDeletes, toast, togglePlay, updateToast, type StreamMedia,
} from "./actions";
import { dropFromDevice } from "./device";
import { keepPicture, prunePictures } from "./pictures";
import { downloadTracks, keepLibraryOnDevice } from "./server";
import { listSongs, pendingSongChanges, updateSong, type ServerSong } from "./song-api";
import { getState, keepStreamsWith, savedPlaylistStreams, setState, subscribe as subscribeApp, type AppState, type ImportMissing } from "./store";

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
  /** A file of the user's own that they added to Spotify, pasted with its songs: known only by its tags. */
  localFile?: boolean;
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
  /**
   * How it matched: scores, `byArtistAndLength` (only its artist and length fit), and `listened` once its sound was
   * compared with Deezer's preview of the song ("same": kept as sure; "unsure": Deezer had no preview, or it was another mix).
   */
  match?: { [score: string]: number | null | undefined | { verdict: "same" | "unsure"; ber?: number; deezerID?: number | null } };
  requiresReview?: boolean;
  autoSelectable?: boolean;
  actionable?: boolean;
  sourceKind?: string | null;
  /** A playlist song already in the library (a music server song id): not searched for, and not offered for saving. */
  ownedSongId?: string;
  /** A playlist song not searched for yet (while the playlist's songs are still being matched). */
  pending?: boolean;
  /** A playlist song with no source: YouTube had no fitting upload, or kept turning the search away. */
  unmatched?: "not_found" | "search_failed" | "not_on_spotify" | "unread";
  /** A pasted Spotify song not read from Spotify yet (its title and artist come once it is). */
  reading?: boolean;
  /** A match made by artist and length alone, being compared with Deezer's preview of the song right now. */
  listening?: boolean;
}

export interface Resolution {
  kind: "search_results" | "youtube" | "spotify" | "soundcloud" | "youtube_playlist" | "spotify_playlist" | "soundcloud_playlist";
  mediaKind: MediaKind;
  track: SourceTrack;
  candidates: Candidate[];
  /** `spotifyLimit`: Spotify listed its 100 songs, all it shows other apps, so the playlist may have more. */
  /** `unreadCount`: pasted Spotify songs Spotify didn't answer for (asked again on Search again). */
  playlist?: { title?: string; unavailableCount?: number; unreadCount?: number; truncated?: boolean; spotifyLimit?: boolean };
  unavailableProviders?: string[];
  /** Providers that answered a search with nothing at all for its words (YouTube's "No results found"). */
  emptyProviders?: string[];
  /** A search's next page of results, for searchMore; absent when there are no more. */
  more?: string | null;
  /** A playlist whose songs are still being matched to uploads (searched for one at a time; see matchPlaylistRows). */
  matching?: {
    completed: number;
    total: number;
    /** Seconds YouTube asked to wait. */
    waitingSeconds?: number;
    /** Pasted songs read from Spotify so far, while they're still being read. */
    reading?: { completed: number; total: number };
    /** Seconds Spotify asked to wait before reading more. */
    spotifyWaitingSeconds?: number;
    /** Unsure matches compared with Deezer previews so far (see Candidate.listening). */
    listening?: { completed: number; total: number };
  };
}

/** A resolve progress line. A playlist sends all its rows first (`preview`), then each `row` as it is matched. */
type ResolveProgress = {
  stage: Stage;
  completed?: number;
  total?: number;
  reading?: { completed: number; total: number };
  spotifyWaitingSeconds?: number;
  listening?: { completed: number; total: number };
  preview?: Resolution;
  row?: { at: number; candidate: Candidate };
  waitingSeconds?: number;
};

/** Playlist rows without a source (pending, unmatched, already owned) come without a link; they get an empty one. */
const withSources = (r: Resolution): Resolution => ({ ...r, candidates: r.candidates.map((c) => (typeof c.sourceURL === "string" ? c : { ...c, sourceURL: "" })) });

export interface ImportFailure {
  stage: string;
  code?: string;
  message: string;
}

export type Stage =
  | "idle" | "resolving_metadata" | "searching_candidates" | "awaiting_selection" | "inspecting_source" | "checking_library" | "downloading"
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
  /**
   * A playlist's save under way: the song it's on, of those queued so far (`following`: more may be found;
   * `streaming`: put in the playlist as streams, not downloaded).
   */
  batch: { index: number; total: number; following: boolean; streaming?: boolean } | null;
  /** How the last playlist save ended, for its Search page to say so (and open the playlist). */
  saved: PlaylistSaved | null;
}

export interface PlaylistSaved {
  source: string;
  playlistTitle: string;
  playlistId: string | null;
  kept: number;
  total: number;
  failed: number;
  cancelled: boolean;
  /** The songs went in the playlist as streams, without downloading them. */
  streamed?: boolean;
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
  batch: null,
  saved: null,
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

/**
 * Spotify song links in pasted text, in order and each once. Spotify's app copies one link per song for a
 * selection, so a whole playlist can be pasted this way (a playlist link brings only its first 100 songs). Files of
 * the user's own added to Spotify copy as "open.spotify.com/local/…" links (their tags, URL-encoded), kept as they are.
 */
export function spotifySongLinks(text: string): string[] {
  const links = [...text.matchAll(/(?:open\.spotify\.com\/(?:intl-[a-z]{2}(?:-[a-z]{2})?\/)?track\/|spotify:track:)([A-Za-z0-9]{22})|open\.spotify\.com\/local\/[^/\s]*\/[^/\s]*\/[^/\s]*\/\d{1,6}|spotify:local:[^:\s]*:[^:\s]*:[^:\s]*:\d{1,6}/gi)]
    .map((m) => (m[1] ? `https://open.spotify.com/track/${m[1]}` : m[0].startsWith("spotify:") ? m[0] : `https://${m[0]}`));
  return [...new Set(links)];
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
  checking_library: "Checking your library",
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
async function streamCall<T>(path: string, body: unknown, signal: AbortSignal, onProgress: (p: ResolveProgress) => void, stage: string): Promise<ApiResult<T>> {
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

/**
 * A provider search for discovery. It has its own request, so an open import dialog is left alone.
 * `urgent`: someone clicked to play it, so the server asks providers it has paused and skips its cache.
 * `onPartial`: a playlist link's songs while they are still being matched, on every progress line (so also while
 * YouTube asks for a pause), each with `matching` set. `onReading`: songs pasted from Spotify, while their details
 * are read (before any `onPartial`).
 */
export async function searchDiscovery(
  query: string,
  signal: AbortSignal,
  mediaKind: MediaKind = "audio",
  urgent = false,
  { onPartial, onReading }: { onPartial?: (r: Resolution) => void; onReading?: (progress: { completed: number; total: number }) => void } = {},
): Promise<Resolution> {
  let partial: Resolution | null = null;
  const result = await streamCall<Resolution>("/api/import/resolve", { source: query, mediaKind, ...(urgent ? { urgent } : {}) }, signal, (p) => {
    if (!partial && !p.preview && p.stage === "resolving_metadata" && p.total) onReading?.({ completed: p.completed ?? 0, total: p.total });
    if (p.preview) partial = p.preview;
    else if (partial && p.row) {
      const candidates = partial.candidates.slice();
      candidates[p.row.at] = p.row.candidate;
      partial = { ...partial, candidates };
    }
    if (partial && onPartial) {
      onPartial(withSources({
        ...partial,
        matching: { completed: p.completed ?? 0, total: p.total ?? 0, waitingSeconds: p.waitingSeconds, reading: p.reading, spotifyWaitingSeconds: p.spotifyWaitingSeconds, listening: p.listening },
      }));
    }
  }, "searching_candidates");
  // Nothing found is an answer, not a failure.
  if (!result.ok && result.error.code === "NO_SEARCH_RESULTS") return { kind: "search_results", mediaKind: "audio", track: {}, candidates: [] };
  if (!result.ok) throw result.error;
  return withSources(result.result);
}

/**
 * The library song a playlist row already is, saved as `kind` (a song saved as audio doesn't stand in for its video):
 * the music server's match, else one recognised here by name or source.
 */
export function playlistOwnedTrack(c: Candidate, kind: MediaKind, s: Pick<AppState, "tracks" | "artists"> = getState()): string | undefined {
  const server = c.ownedSongId ? s.tracks[`srv_${c.ownedSongId}`] : undefined;
  if (server && server.kind === kind) return server.id;
  const meta = c.importMetadata;
  return ownedIndex(s).find({ artist: meta?.artist, title: meta?.title, sources: candidateSources(c) }).find((id) => s.tracks[id]?.kind === kind);
}

/** The next page of a search's results (Resolution.more). */
export async function searchMore(more: string, mediaKind: MediaKind, signal: AbortSignal): Promise<Resolution> {
  const result = await streamCall<Resolution>("/api/import/resolve", { more, mediaKind }, signal, () => undefined, "searching_candidates");
  if (!result.ok) throw result.error;
  return result.result;
}

/** How an added suggestion carries on once it is in the library: played straight away (the default), and/or handed to `done`. */
interface DiscoveryOptions {
  play?: boolean;
  done?: (libraryId: string) => void;
  /** Save it as a video (a YouTube video played as one). */
  video?: boolean;
  /** The streamed song it is, which the "Check this match" dialog's Listen plays. */
  streamId?: string;
}

/** The suggestion being reviewed or added, and why it was suggested. */
let discovery: ({ candidate: Candidate; kind: ReasonKind } & DiscoveryOptions) | null = null;

function importBusy() {
  if (state.busy !== "import") return false;
  toast("A song is already importing", { detail: "Wait for it to finish before adding another." });
  return true;
}

/** How long a closing dialog takes to leave (ModalHost keeps it 180 ms to animate out, then focus goes back). */
const MODAL_GONE_MS = 240;
/** Counts match checks, so each one's dialog is told apart from an older one's. */
let matchChecks = 0;
/** When the last dialog closed, so a match check opens only once it has gone (see confirmMatch). */
let modalClosedAt = 0;
let modalWasOpen = Boolean(getState().modal);
subscribeApp(() => {
  const open = Boolean(getState().modal);
  if (modalWasOpen && !open) modalClosedAt = Date.now();
  modalWasOpen = open;
});

/** The match the "Check this match" dialog is asking about, and how to answer it. */
let matchCheck: { candidate: Candidate; kind: ReasonKind; streamId?: string; answer: (save: boolean) => void } | null = null;

/**
 * Asks, over whatever is on screen, whether to save a song matched to its upload by name only (`requiresReview`):
 * the upload may be another recording. Answers true when the user chooses Save; closing the dialog answers false.
 * `streamId`: the streamed song this is, which Listen plays (else Listen streams the upload itself).
 */
function confirmMatch(candidate: Candidate, kind: ReasonKind, streamId?: string, video = false): Promise<boolean> {
  matchCheck?.answer(false);
  const meta = candidate.importMetadata;
  return new Promise<boolean>((resolve) => {
    let opened = false;
    const check = { candidate, kind, streamId, answer: (save: boolean) => {
      if (matchCheck !== check) return;
      matchCheck = null;
      stop();
      resolve(save);
    } };
    matchCheck = check;
    const token = ++matchChecks;
    const open = () => openModal({
      type: "checkMatch",
      check: token,
      song: meta?.title || candidate.title || "This song",
      artist: meta?.artist || "",
      upload: candidate.title || candidate.sourceURL || "",
      uploader: candidate.artist || "",
      duration: candidate.durationSeconds || meta?.durationSeconds || 0,
      provider: candidate.sourceProvider === "soundcloud" ? "SoundCloud" : "YouTube",
      url: candidate.sourcePageURL || candidate.sourceURL || "",
      canListen: canStream(candidate),
      video,
    });
    // It waits for any dialog already open (a queued save mustn't close one being used), and for that dialog to be
    // gone and have handed focus back, so closing this one returns focus to the page. Once it's shown, any other way
    // it goes (Cancel, Escape, a click outside, another dialog) saves nothing.
    let later = 0;
    const openWhenClear = () => {
      // Once scheduled, other changes in the app don't put it off again.
      if (later) return;
      later = window.setTimeout(() => {
        later = 0;
        if (!getState().modal && matchCheck === check && !opened) open();
      }, Math.max(0, modalClosedAt + MODAL_GONE_MS - Date.now()));
    };
    const stop = subscribeApp(() => {
      const modal = getState().modal;
      // (Its own dialog: not an older check's still on screen.)
      if (modal?.type === "checkMatch" && modal.check === token) opened = true;
      else if (opened) check.answer(false);
      else if (!modal && matchCheck === check) openWhenClear();
      // An older check's dialog still showing is replaced by this one.
      else if (modal?.type === "checkMatch" && matchCheck === check) open();
    });
    // An older check's dialog on screen is replaced straight away; otherwise it opens once the last dialog has gone.
    if (getState().modal?.type === "checkMatch") open();
    else if (!getState().modal) openWhenClear();
  });
}

/** The "Check this match" dialog's answer: closes it, and saves the song if `save`. */
export function answerMatchCheck(save: boolean) {
  const check = matchCheck;
  check?.answer(save);
  closeModal();
}

/** Plays (or pauses) the upload the "Check this match" dialog is asking about, as a streamed song. */
export function listenToMatch() {
  const check = matchCheck;
  if (!check || !canStream(check.candidate)) return;
  let id = check.streamId && getState().tracks[check.streamId] ? check.streamId : undefined;
  if (!id) {
    const meta = check.candidate.importMetadata;
    const key = `check:${check.candidate.sourceURL}`;
    registerStreams([{ key, candidate: check.candidate, title: meta?.title || check.candidate.title || "Untitled", artist: meta?.artist || check.candidate.artist || "Unknown artist", artwork: meta?.artworkURL || check.candidate.thumbnailURL || undefined, kind: check.kind, video: false }]);
    id = streamTrackId(key);
  }
  if (getState().currentId === id) return togglePlay();
  playList([id], id, { label: "Checking a match", route: getState().route });
}

/** The streamed song a "Check this match" dialog's Listen plays: whether it is playing now. */
export const matchCheckTrack = () => {
  const check = matchCheck;
  return check ? (check.streamId && getState().tracks[check.streamId] ? check.streamId : streamTrackId(`check:${check.candidate.sourceURL}`)) : null;
};

/**
 * A playlist still being matched, for a save that keeps going: `next` waits for more songs to save (matched and
 * wanted), each with its row; it answers null once matching has ended and none are left. `latest` is the playlist
 * as it stands, for putting the songs in order at the end.
 */
export interface PlaylistFollow {
  next(signal: AbortSignal): Promise<{ at: number; candidate: Candidate }[] | null>;
  latest(): Resolution;
}
/** The follow for the playlist save about to start (see saveSearchResults). */
let pendingFollow: PlaylistFollow | null = null;

/**
 * How a playlist's songs are saved (asked in the Save dialog): `playlistName` is the playlist they go in (made, or
 * topped up if one has that name), or null for none; `includeOwned` puts the list's songs already in the library in
 * that playlist too. `download: false` downloads nothing: the songs go in the playlist as streams (a playlist name
 * is then needed).
 */
export interface PlaylistSaveOptions {
  playlistName: string | null;
  includeOwned: boolean;
  download?: boolean;
}
let pendingSaveOptions: PlaylistSaveOptions | null = null;
/** What the Save dialog starts once answered (see askToSavePlaylist). */
let saveStarter: ((options: PlaylistSaveOptions) => void) | null = null;

/**
 * Asks how to save a playlist's songs (the Save dialog: whether to make a playlist, and its name), then `start`s the
 * save with the answer. Closing the dialog saves nothing.
 */
export function askToSavePlaylist(details: { count: number; owned: number; name: string; matching: boolean; video?: boolean }, start: (options: PlaylistSaveOptions) => void) {
  if (importBusy()) return;
  saveStarter = start;
  openModal({ type: "savePlaylist", ...details });
}

/** The Save dialog's answer: closes it and starts the save. */
export function startPlaylistSave(options: PlaylistSaveOptions) {
  const start = saveStarter;
  saveStarter = null;
  closeModal();
  start?.(options);
}

/**
 * Saves the chosen search results through the same download pipeline as the import dialog. `follow`: a playlist
 * still being matched, whose songs are saved as they're found too, in the same transfer.
 */
export async function saveSearchResults(source: string, resolution: Resolution, selected: number[], follow?: PlaylistFollow, options?: PlaylistSaveOptions) {
  if (importBusy()) return;
  pendingFollow = isPlaylist(resolution) ? follow ?? null : null;
  pendingSaveOptions = isPlaylist(resolution) ? options ?? null : null;
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

/**
 * Downloads a suggestion into the library and plays it. A match made by name only is checked first, in a dialog
 * over the current page; cancelling it saves nothing.
 */
export async function addDiscoveredSong(candidate: Candidate, kind: ReasonKind, options: DiscoveryOptions = {}) {
  if (!isDownloadable(candidate) || importBusy()) return;
  if (candidate.requiresReview) {
    if (!(await confirmMatch(candidate, kind, options.streamId, options.video))) return;
    // Another save may have started while the dialog was open: this one waits for it.
    await whenImportIdle();
  }
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

const streamSources = new Map<string, { candidate: Candidate; kind: ReasonKind; key: string; video: boolean; saveVideo: boolean; title: string; artist: string; videoChoice?: boolean; refused?: Set<string> }>();

/**
 * A result that is a YouTube video (not a YouTube Music track, and not a match
 * found for a Spotify or SoundCloud song), so it has a picture worth streaming.
 */
export const isYouTubeVideo = (c: Candidate) =>
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
    streamSources.set(id, { candidate: song.candidate, kind: song.kind, key: song.key, video, saveVideo: youtube && song.video === true, title: song.title, artist: song.artist, videoChoice: song.video });
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

/** What registered a streamed song, to register it again in a later session (slip-ins keep streamed songs). */
export function streamSong(id: string): StreamSong | null {
  const source = streamSources.get(id);
  const t = getState().tracks[id];
  if (!source || !t) return null;
  const s = getState();
  return {
    key: source.key,
    candidate: source.candidate,
    kind: source.kind,
    // As it was registered, not as shown: registering credits an upload's title ("Artist - Song" -> "Song"), and
    // crediting a shown title again would take more off it in another session or on another device.
    title: source.title || t.title,
    artist: source.artist || (s.artists[t.artistId]?.name ?? source.candidate.artist ?? "Unknown artist"),
    artwork: s.albums[t.albumId]?.artworkUrl,
    video: source.saveVideo ? true : source.video ? undefined : false,
  };
}

/** The playlist song a result stands for (a Spotify or SoundCloud track, or a file of the user's own by its tags), or null. */
function sourceSongKey(meta: SourceTrack | null | undefined) {
  if (!meta) return null;
  if (meta.provider && meta.trackID) return `${meta.provider}:${meta.trackID}`;
  return meta.localFile && meta.title ? `local:${meta.artist ?? ""}|${meta.title}|${meta.durationSeconds ?? ""}` : null;
}

/**
 * A found song's candidate as a mix edition keeps it (mixes.ts), which is stored and synced to the account: without
 * the copies search results keep of the same picture, which are read only where the other copy comes first (the
 * video thumbnail when it's the thumbnail, the uploader's avatar when the import has it too). Nothing shown or saved
 * changes; the import's own artwork stays even when it's the thumbnail, since a repaired stream keeps it. A fallback
 * keeps its avatar: repairing a stream gives it the first copy's import (replaceSource), so its own may be the only one.
 */
export function compactCandidate(c: Candidate, fallback = false): Candidate {
  const { videoThumbnailURL, creatorAvatarURL, fallbackCandidates, ...rest } = c;
  const out: Candidate = rest;
  if (videoThumbnailURL && videoThumbnailURL !== c.thumbnailURL) out.videoThumbnailURL = videoThumbnailURL;
  if (creatorAvatarURL && (fallback || creatorAvatarURL !== c.importMetadata?.creatorAvatarURL)) out.creatorAvatarURL = creatorAvatarURL;
  if (fallbackCandidates) out.fallbackCandidates = fallbackCandidates.map((f) => compactCandidate(f, true));
  return out;
}

/**
 * What a streamed song needs to stream again in a later session (kept with playlists made without downloading:
 * store.ts): the upload and its other matched copies by link, and the song's own details; not search scores,
 * thumbnails of every copy, or uploads only listened to.
 */
function keptStream(id: string): StreamSong | null {
  const song = streamSong(id);
  if (!song) return null;
  const slim = (c: Candidate): Candidate => ({
    sourceURL: c.sourceURL,
    sourceProvider: c.sourceProvider,
    searchProvider: c.searchProvider,
    videoID: c.videoID,
    providerID: c.providerID,
    title: c.title,
    artist: c.artist,
    durationSeconds: c.durationSeconds,
    thumbnailURL: c.thumbnailURL,
    // How sure the match is, so saving it later still asks for a look where it should (confirmMatch).
    score: c.score,
    confidence: c.confidence,
    requiresReview: c.requiresReview,
    ...(c.match ? { match: Object.fromEntries(Object.entries(c.match).filter(([key]) => ["title", "artist", "duration", "byArtistAndLength"].includes(key))) } : {}),
  });
  const meta = song.candidate.importMetadata;
  return {
    ...song,
    candidate: {
      ...slim(song.candidate),
      ...(meta ? { importMetadata: { provider: meta.provider, trackID: meta.trackID, title: meta.title, artist: meta.artist, album: meta.album, durationSeconds: meta.durationSeconds, artworkURL: meta.artworkURL, localFile: meta.localFile } } : {}),
      fallbackCandidates: (song.candidate.fallbackCandidates ?? []).filter(isDownloadable).slice(0, 2).map(slim),
    },
  };
}

/**
 * A playlist's streamed song as synced to your other devices and account (sync.ts): only what's needed to stream it
 * there and show it, since the account's copy of the whole library is limited in size (about 400 bytes a song).
 */
export function syncedStream(id: string): StreamSong | null {
  const song = keptStream(id);
  if (!song) return null;
  const c = song.candidate;
  const meta = c.importMetadata;
  return {
    key: song.key,
    kind: song.kind,
    title: song.title,
    artist: song.artist,
    ...(song.artwork ? { artwork: song.artwork } : {}),
    ...(song.video !== undefined ? { video: song.video } : {}),
    candidate: {
      sourceURL: c.sourceURL,
      sourceProvider: c.sourceProvider,
      ...(c.searchProvider ? { searchProvider: c.searchProvider } : {}),
      ...(c.videoID ? { videoID: c.videoID } : {}),
      durationSeconds: c.durationSeconds,
      ...(c.requiresReview ? { requiresReview: true } : {}),
      ...(meta ? { importMetadata: { provider: meta.provider, trackID: meta.trackID, durationSeconds: meta.durationSeconds, ...(meta.localFile ? { localFile: true, title: meta.title, artist: meta.artist } : {}) } } : {}),
      ...(c.fallbackCandidates?.length ? { fallbackCandidates: c.fallbackCandidates.map((f) => ({ sourceURL: f.sourceURL, sourceProvider: f.sourceProvider })) } : {}),
    },
  };
}

/**
 * A synced streamed song (see syncedStream) with the song's details back where saving it looks for them: the
 * upload's and the playlist song's title, artist and artwork, which the synced record keeps only once.
 */
export function fromSyncedStream(song: StreamSong): StreamSong {
  const c = song.candidate;
  const meta = c.importMetadata;
  return {
    ...song,
    candidate: {
      ...c,
      title: c.title ?? song.title,
      artist: c.artist ?? song.artist,
      ...(meta ? { importMetadata: { ...meta, title: meta.title ?? song.title, artist: meta.artist ?? song.artist, artworkURL: meta.artworkURL ?? song.artwork ?? null } } : {}),
    },
  };
}

/** The platform a result is listed under. */
export function resultPlatform(c: Candidate): Provider {
  if (c.searchProvider) return c.searchProvider;
  if (c.importMetadata?.provider === "spotify") return "spotify";
  if (c.importMetadata?.provider === "soundcloud" || c.sourceProvider === "soundcloud") return "soundcloud";
  return "youtube";
}
/** A stable song key for a result, so playing it again resumes the same streamed track. A video is its own track. */
export const resultStreamKey = (c: Candidate, kind: MediaKind = "audio") =>
  `search:${resultPlatform(c)}:${c.sourceProvider}:${c.videoID || c.providerID || c.sourceURL}${kind === "video" ? ":video" : ""}`;

/** Where a streamed song's audio comes from, for sharing it (Listen Along). */
export const streamLink = (id: string) => streamSources.get(id)?.candidate.sourceURL ?? null;

/** Videos being prepared for streamed songs, so playing one again meanwhile doesn't prepare it twice. */
const pictures = new Map<string, Promise<string | null>>();

/** Refusals that mean this copy of a song has gone (taken down, private, members only, blocked here), not that YouTube is being wary of this computer. */
const GONE = new Set(["YOUTUBE_UNAVAILABLE", "YOUTUBE_PRIVATE", "YOUTUBE_REGION_BLOCKED", "YOUTUBE_MEMBERS_ONLY", "SOUNDCLOUD_NOT_FOUND"]);

export interface StreamRepair {
  /** Another copy of this song, leaving out the ones that failed (`refused`), or null. */
  find: (song: { key: string; title: string; artist: string; duration: number }, refused: Set<string>) => Promise<Candidate | null>;
  /** This copy plays in place of the one that has gone. */
  replaced: (key: string, candidate: Candidate) => void;
}
let repair: StreamRepair | null = null;
/** Set by recommend/releases, which can search for songs (and needs this module, so it plugs itself in). */
export function setStreamRepair(hooks: StreamRepair) {
  repair = hooks;
}
const repairing = new Map<string, Promise<boolean>>();

/**
 * Swaps a streamed song's gone copy (`failed`, the one that was tried) for another: its other remembered copy,
 * else one found afresh. Shared per song. A failure that arrives after the song has already moved on to another
 * copy only rules out the copy it was for, and the song tries its current one.
 */
function replaceSource(id: string, failed: string): Promise<boolean> {
  const source = streamSources.get(id);
  if (!source) return Promise.resolve(false);
  // One list per song, so a copy ruled out by a late failure is left out by a repair already looking, too.
  const refused = (source.refused ??= new Set());
  if (failed) refused.add(failed);
  if (source.candidate.sourceURL !== failed) return repairing.get(id) ?? Promise.resolve(true);
  let task = repairing.get(id);
  if (task) return task;
  task = (async () => {
    const others = (source.candidate.fallbackCandidates ?? []).filter((c) => canStream(c) && !refused.has(c.sourceURL ?? ""));
    let next: Candidate | null = others.length
      ? { ...others[0], searchProvider: source.candidate.searchProvider, importMetadata: source.candidate.importMetadata, fallbackCandidates: others.slice(1) }
      : null;
    if (!next && repair) next = await repair.find({ key: source.key, title: source.title, artist: source.artist, duration: getState().tracks[id]?.duration ?? 0 }, refused).catch(() => null);
    if (!next || !canStream(next) || refused.has(next.sourceURL ?? "")) return false;
    source.candidate = next;
    // The copy that failed may have been turned into audio only (its picture failed too); the new one is judged afresh.
    const video = next.sourceProvider !== "soundcloud" && (source.videoChoice ?? isYouTubeVideo(next));
    if (video !== source.video) {
      source.video = video;
      setState((s) => (s.tracks[id] ? { tracks: { ...s.tracks, [id]: { ...s.tracks[id], kind: video ? "video" : "audio" } } } : {}));
    }
    repair?.replaced(source.key, next);
    return true;
  })().finally(() => repairing.delete(id));
  repairing.set(id, task);
  return task;
}

/**
 * A streamed song's audio (and picture). A copy that has gone is swapped for another and tried again, up to
 * twice (its other remembered copy, then one found afresh), so a removed video doesn't stop the song playing.
 */
async function streamSource(id: string, options: { background?: boolean } = {}): Promise<StreamMedia> {
  let swaps = 0;
  let staleRetried = false;
  for (;;) {
    const tried = streamSources.get(id)?.candidate.sourceURL ?? "";
    try {
      return await streamSourceOnce(id, options);
    } catch (error) {
      if (!GONE.has((error as { code?: string })?.code ?? "")) throw error;
      // The song had already moved on to another copy (a failure that arrived late): that one is tried, once.
      const stale = streamSources.get(id)?.candidate.sourceURL !== tried;
      if (stale ? staleRetried : swaps >= 2) throw error;
      if (!(await replaceSource(id, tried))) throw error;
      if (stale) staleRetried = true;
      else swaps++;
    }
  }
}

async function streamSourceOnce(id: string, { background = false } = {}): Promise<StreamMedia> {
  const source = streamSources.get(id);
  if (!source) throw new Error("This suggestion is no longer available.");
  const fetchPreview = async (mediaKind: MediaKind) => {
    const res = await fetch("/api/import/preview", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ sourceURL: source.candidate.sourceURL, mediaKind, background }) });
    const body = (await res.json().catch(() => null)) as ApiResult<{ url: string }> | null;
    if (!body || !body.ok) throw Object.assign(new Error(body && !body.ok ? body.error.message : "Its source isn't available right now."), { code: body && !body.ok ? body.error.code : undefined });
    return body.result.url;
  };
  if (!source.video) return { url: await fetchPreview("audio") };
  /*
   * A video takes a while to prepare (its picture and sound are fetched separately
   * and joined), so the song starts on its audio, which comes much sooner, and the
   * picture joins once it's ready. A video prepared already starts as one.
   */
  const fetchPicture = () => fetchPreview("video").then(
    (url) => url,
    (error: { code?: string }) => {
      // Put off (YouTube is cooling down), not refused: left for when the song plays.
      if (error?.code === "YOUTUBE_COOLING_DOWN") throw error;
      // A video YouTube won't hand over as one MP4 plays on as audio.
      source.video = false;
      setState((s) => (s.tracks[id] ? { tracks: { ...s.tracks, [id]: { ...s.tracks[id], kind: "audio" } } } : {}));
      return null;
    },
  );
  let pending = pictures.get(id);
  if (!pending) {
    pending = fetchPicture();
    pictures.set(id, pending);
    const done = () => pictures.delete(id);
    void pending.then(done, done);
  }
  if (background) {
    // Fetched ahead, the song waits for its picture: one put off fails this fetch, and playing the song asks again.
    const url = await pending;
    return { url: url ?? (await fetchPreview("audio")) };
  }
  // Played now: a picture a fetch-ahead was put off for is asked for again.
  const picture = pending.catch(() => fetchPicture());
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

/** Saves of streamed songs, run one after another so none is turned away while another imports. */
let saving: Promise<void> = Promise.resolve();
/** Songs waiting to be saved, each with everything to do once it is in the library (join a playlist, get liked…). */
const queuedSaves = new Map<string, Array<(libraryId: string) => void>>();

/** Whether a streamed song can be saved as a video too (a YouTube video, not a song matched to one): its menu offers both. */
function streamSavesVideo(id: string) {
  const source = streamSources.get(id);
  return Boolean(source && source.candidate.sourceProvider !== "soundcloud" && (source.saveVideo || isYouTubeVideo(source.candidate)));
}

/**
 * Adds a streamed song to the library without restarting playback, then hands `then` its library id. `video`
 * saves it as a video (or, false, as a song) whatever it was found as; left out, it's saved as it was found.
 */
function saveStreamToLibrary(id: string, then?: (libraryId: string) => void, { video }: { video?: boolean } = {}) {
  const source = streamSources.get(id);
  if (!source) return;
  const asVideo = video ?? source.saveVideo;
  // Already queued (as the same kind): this request waits for the same import instead of starting another.
  const queueKey = `${id}|${asVideo ? "video" : "audio"}`;
  const waiting = queuedSaves.get(queueKey);
  if (waiting) {
    if (then) waiting.push(then);
    return;
  }
  if (state.busy === "import" || queuedSaves.size) toast(`“${source.candidate.importMetadata?.title || source.candidate.title || "This song"}” will be added next`);
  queuedSaves.set(queueKey, then ? [then] : []);
  const done = (libraryId: string) => {
    linkSavedStream(id, libraryId);
    for (const next of queuedSaves.get(queueKey) ?? []) next(libraryId);
  };
  saving = saving
    .then(whenImportIdle)
    // A match made by name only is checked first, in a dialog over the current page (see addDiscoveredSong).
    .then(() => addDiscoveredSong(source.candidate, source.kind, { play: false, done, video: asVideo, streamId: id }))
    .catch(() => undefined)
    .finally(() => queuedSaves.delete(queueKey));
}

connectStreams({
  source: streamSource,
  save: saveStreamToLibrary,
  savesVideo: streamSavesVideo,
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

/**
 * When each server song was added here. A library sync whose song list was asked for before then can't know the
 * song yet, so it mustn't take it for one deleted elsewhere (which also takes it out of its playlists).
 */
const addedHere = new Map<string, number>();

/** Adds (or finds) a saved song in the app library, starts keeping its file on this device, and returns its track id. */
export function addServerTrack(p: ServerSong) {
  cancelServerDelete(p.id);
  const s = getState();
  const id = `srv_${p.id}`;
  addedHere.set(id, Date.now());
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
  // A music server from before fades sends the clip back without them: the same range is no change, so fades set
  // here aren't lost (they stay on this device until the server can keep them). Current servers always send them.
  if (p.clip && current && p.clip.start === current.start && p.clip.end === current.end && p.clip.fadeIn === undefined && p.clip.fadeOut === undefined) return {};
  if (p.clip ? current?.start === p.clip.start && current?.end === p.clip.end && (current.fadeIn ?? 0) === (p.clip.fadeIn ?? 0) && (current.fadeOut ?? 0) === (p.clip.fadeOut ?? 0) && (current.fadeShape ?? "smooth") === (p.clip.fadeShape ?? "smooth") : !current) return {};
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
  const asked = Date.now();
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
  // A song added since the list was asked for isn't in it yet; the next sync has it.
  const gone = new Set(Object.values(s.tracks).filter((t) => t.serverId && !live.has(t.id) && !((addedHere.get(t.id) ?? -1) >= asked)).map((t) => t.id));
  for (const [id, at] of addedHere) if (at < asked) addedHere.delete(id);
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
    // Artists credited alongside another are listed in the sidebar too.
    const used = libraryArtistIds(s);
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
    keepArtistPictures();
  }
}

const libraryArtistIds = (s: AppState) => new Set(Object.values(s.tracks).filter((t) => !t.stream).flatMap((t) => [t.artistId, ...(t.featuring ?? [])]));

/** The pictures of your library's artists. */
const libraryPictures = (s: AppState) => [...libraryArtistIds(s)].map((id) => s.artists[id]?.image).filter((url): url is string => Boolean(url));

/** Keeps your library artists' pictures on this device (for the sidebar), and lets go of the rest. */
function keepArtistPictures() {
  // One at a time, so a large library doesn't fetch them all at once.
  void libraryPictures(getState()).reduce<Promise<unknown>>((done, url) => done.then(() => keepPicture(url)), Promise.resolve())
    .then(() => prunePictures(libraryPictures(getState())));
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
    // Already set up for this song, saved this way (a song and its video are saved separately).
    if (state.resolution?.candidates[0] === candidate && state.resolution.mediaKind === kind && state.selected[0] === 0) return;
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
    const resolution = withSources(result.result);
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

/** The source whose page is on screen showing its own save progress (a playlist's Search page), if any. */
let inlineSource: string | null = null;
const shownInline = () => inlineSource !== null && inlineSource === state.source;

/**
 * A playlist's Search page, while open, shows its save's progress and outcome itself; the transfer toast is for when
 * it isn't on screen (so leaving the page brings the toast up, and coming back puts it away).
 */
export function showTransferInline(source: string | null) {
  if (inlineSource === source) return;
  inlineSource = source;
  lastToastKey = "";
  if (state.busy === "import") showTransfer();
}

function showTransfer() {
  if (shownInline()) {
    if (transferToastAlive()) dismissToast(transferToast);
    transferToast = 0;
    lastToastKey = "";
    return;
  }
  const { stage, progress, transferName } = state;
  const ratio = stage === "downloading" && progress?.total ? progress.completed / progress.total : -1;
  const batch = batchProgress;
  const overall = batch ? (batch.index + Math.max(0, ratio)) / batch.total : ratio;
  const title = state.batch?.streaming ? "Making playlist" : stageLabel(stage) || "Importing";
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

function finishTransfer(message: string, opts: Parameters<typeof toast>[1] = {}, { quietInline = false } = {}) {
  const { duration = 6000, ...rest } = opts;
  // (`quietInline`: the page on screen says how it ended itself.)
  if (quietInline && shownInline()) {
    if (transferToastAlive()) dismissToast(transferToast);
  } else if (transferToastAlive()) updateToast(transferToast, { message, detail: undefined, progress: undefined, sticky: false, tone: "default", action: undefined, ...rest }, duration);
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

/**
 * What saving a source came to. "duplicate": the library has it already (the same upload or the
 * same sound data), and `track` is that song. "similar": it sounds the same as `track` (an
 * acoustic match, maybe from another site), and nothing was saved: ask, then save it with
 * `allowSimilar` if wanted.
 */
type StartResult = { kind: "created" | "duplicate" | "similar"; track: ServerSong; similarity?: { ber: number; overlapSeconds: number } };

type SimilarPair = { saving: { title: string; artist: string }; match: ServerSong };

/** The question for songs that sound like ones already in the library. Its "no" (Skip, Escape) saves nothing. */
function similarQuestion(pairs: SimilarPair[], kind: MediaKind) {
  const noun = kind === "video" ? "video" : "song";
  const line = ({ saving, match }: SimilarPair) => `“${saving.title}” sounds the same as “${match.title}” by ${match.artist}`;
  const answers = { confirmLabel: "Save anyway", cancelLabel: "Skip", icon: "copy" };
  if (pairs.length === 1) return { title: "Already in your library?", body: `${line(pairs[0])}, which you already have.`, ...answers };
  const more = pairs.length > 3 ? `; and ${pairs.length - 3} more` : "";
  return {
    title: `${pairs.length} ${noun}s may already be in your library`,
    body: `${pairs.slice(0, 3).map(line).join("; ")}${more}. Skipping keeps the ones you have.`,
    ...answers,
  };
}

function startDownload(c: Candidate, meta: SourceTrack, kind: MediaKind, signal: AbortSignal, allowSimilar = false) {
  const metadata = importMetadata(c, meta);
  return streamCall<StartResult>("/api/import/start", {
    sourceURL: c.sourceURL,
    sourceIdentity: sourceIdentity(c, metadata),
    mediaKind: kind,
    metadata,
    durationSeconds: metadata.durationSeconds,
    ...(allowSimilar ? { allowSimilar: true } : {}),
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
    let result = await startDownload(candidate, meta, kind, controller.signal);
    if (!result.ok) throw result.error;
    let skippedFor: ServerSong | null = null;
    if (result.result.kind === "similar") {
      const match = result.result.track;
      const save = await ask(similarQuestion([{ saving: importMetadata(candidate, meta), match }], kind));
      if (controller.signal.aborted) throw new DOMException("Import cancelled", "AbortError");
      if (save) {
        set({ stage: "inspecting_source", progress: null });
        showTransfer();
        result = await startDownload(candidate, meta, kind, controller.signal, true);
        if (!result.ok) throw result.error;
      } else skippedFor = match;
    }
    const id = addServerTrack(result.result.track);
    if (discovered) {
      keepDiscovery(discovered.kind);
      if (discovered.play !== false) playList([id], id, { label: "Discovered for you", route: { name: "library" }, picks: { [id]: discovered.kind } });
      discovered.done?.(id);
    }
    const title = result.result.track.title;
    const play = { label: "Play", run: () => playList([id], id, { label: "Imported", route: { name: "library" } }) };
    if (skippedFor) {
      finishTransfer(`Skipped “${importMetadata(candidate, meta).title}”`, { detail: `You already have “${skippedFor.title}”.`, action: play });
    } else if (result.result.kind === "duplicate") {
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
  set({ busy: null, progress: null, batch: null });
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
  // A playlist still being matched: songs found while this runs are saved too.
  const follow = pendingFollow;
  pendingFollow = null;
  const sourceTitle = resolution.playlist?.title || resolution.track.title || "Imported Playlist";
  const options = pendingSaveOptions ?? { playlistName: sourceTitle, includeOwned: true };
  pendingSaveOptions = null;
  // Not downloading: the found songs go in the playlist as streams.
  const download = options.download !== false;
  const makePlaylist = options.playlistName !== null || !download;
  /**
   * Songs already in the library aren't saved again, but still take their place in the imported playlist (when
   * there is one, and they're wanted in it).
   */
  const ownedIn = (r: Resolution, queued: Set<number>) => r.candidates.flatMap((c, at) => {
    if (queued.has(at) || !makePlaylist || !options.includeOwned) return [];
    const id = playlistOwnedTrack(c, kind);
    return id ? [{ at, id }] : [];
  });
  const seen = new Set<string>();
  // Each song to save with its row in the playlist, once each (a playlist can list one twice).
  const queue: { at: number; candidate: Candidate }[] = [];
  const enqueue = (entries: { at: number; candidate: Candidate }[]) => {
    for (const entry of entries) {
      const key = transferKey(entry.candidate, kind);
      if (key && seen.has(key)) continue;
      if (key) seen.add(key);
      queue.push(entry);
    }
  };
  enqueue(state.selected.flatMap((at) => (resolution.candidates[at] ? [{ at, candidate: resolution.candidates[at] }] : [])));
  const owned = ownedIn(resolution, new Set(state.selected));
  if (!queue.length && !owned.length && !follow) {
    fail({ stage: "awaiting_selection", message: `Choose at least one playlist ${noun} to download.` });
    return;
  }
  const playlistTitle = options.playlistName?.trim() || sourceTitle;
  const providerName = resolution.kind === "spotify_playlist" ? "Spotify" : resolution.kind === "soundcloud_playlist" ? "SoundCloud" : "YouTube";
  // Each kept song by its place in the queue, so ones settled later (below) still land where they were.
  const slots: string[] = [];
  /**
   * Puts songs in the playlist named after the source, each at its place there (`at`, its row in the source).
   * Importing again tops it up: songs saved in a later batch (or a later import) go where the source has them, not at
   * the end, among the songs it has from this source. Songs added to it some other way stay where they are.
   */
  const place = (entries: { at: number; id: string }[], source: Resolution = resolution) => {
    if (!makePlaylist) return undefined;
    const sorted = [...entries].sort((a, b) => a.at - b.at);
    const ids = [...new Set(sorted.map((e) => e.id))];
    if (!ids.length) return undefined;
    // Where each of this source's songs belongs, including ones already in the playlist.
    const position = new Map<string, number>();
    source.candidates.forEach((c, at) => {
      const id = playlistOwnedTrack(c, kind);
      if (id && !position.has(id)) position.set(id, at);
    });
    for (const { at, id } of sorted) if (!position.has(id)) position.set(id, at);
    // Songs this save already put in (a streamed playlist is filled as songs are found).
    slots.forEach((id, index) => {
      if (id && !position.has(id)) position.set(id, queue[index].at);
    });
    let existing = getState().playlists.find((p) => !p.system && p.name === playlistTitle);
    let playlistId: string;
    if (existing) {
      // Songs it streams (made earlier without downloading) that are saved now, by this save or before: the saved
      // copy takes the stream's place rather than joining beside it.
      // Matched by the playlist song each stands for (listening may have settled on another upload since), or, for a
      // playlist whose songs are uploads themselves (a YouTube playlist), by the upload.
      const savedFor = new Map<string, string>();
      for (const { at, id } of sorted) {
        const c = source.candidates[at];
        if (!c || getState().tracks[id]?.stream) continue;
        const song = sourceSongKey(c.importMetadata);
        if (song) savedFor.set(song, id);
        if (canStream(c)) savedFor.set(streamTrackId(resultStreamKey(c, kind)), id);
      }
      const swap = new Map<string, string>();
      for (const id of existing.trackIds) {
        if (!getState().tracks[id]?.stream) continue;
        const song = sourceSongKey(streamSources.get(id)?.candidate.importMetadata);
        const saved = (song ? savedFor.get(song) : undefined) ?? savedFor.get(id);
        if (saved) swap.set(id, saved);
      }
      if (swap.size) {
        const swapped = existing.trackIds.map((id) => swap.get(id) ?? id);
        const trackIds = swapped.filter((id, i) => swapped.indexOf(id) === i);
        const target = existing.id;
        setState((s) => ({ playlists: s.playlists.map((p) => (p.id === target ? { ...p, trackIds } : p)) }));
        existing = getState().playlists.find((p) => p.id === target)!;
      }
      const had = new Set(existing.trackIds);
      addToPlaylist(existing.id, ids, { silent: true, keepStreams: !download });
      playlistId = existing.id;
      for (const id of ids) {
        if (had.has(id)) continue;
        const at = position.get(id)!;
        const current = getState().playlists.find((p) => p.id === playlistId)?.trackIds ?? [];
        const before = current.find((other) => other !== id && (position.get(other) ?? -1) > at) ?? null;
        if (before) moveInPlaylist(playlistId, id, before);
      }
    } else playlistId = createPlaylist(playlistTitle, ids, `Imported from ${providerName}.`, { keepStreams: !download });
    return { label: "Open", run: () => navigate({ name: "playlist", id: playlistId }), playlistId };
  };
  /** Records how the save ended, for the playlist's Search page (see ImportState.saved). */
  const settle = (outcome: Omit<PlaylistSaved, "source" | "playlistTitle">) =>
    set({ saved: { source: state.source, playlistTitle: makePlaylist ? playlistTitle : "", ...outcome, ...(download ? {} : { streamed: true }) } });
  if (!queue.length && !follow) {
    // Every song is already saved: only the playlist is made.
    const open = place(owned);
    settle({ playlistId: open?.playlistId ?? null, kept: 0, total: 0, failed: 0, cancelled: false });
    if (!shownInline()) toast(`Added ${owned.length} ${noun}${owned.length === 1 ? "" : "s"} to “${playlistTitle}”`, { tone: "success", detail: "All of them were already in your library.", action: open });
    set({ stage: "complete" });
    return;
  }
  const first = queue[0] ? queue[0].candidate.importMetadata?.title || queue[0].candidate.title || "Playlist item 1" : "Waiting for songs to be found…";
  batchProgress = { index: 0, total: Math.max(1, queue.length) };
  const streaming = download ? {} : { streaming: true };
  set({ saved: null, batch: { index: 0, total: queue.length, following: Boolean(follow), ...streaming } });
  const controller = begin(queue.length ? `1 of ${queue.length} • ${first}` : first);
  /** "3 of 12", or "3 of 12 so far" while more may still be found. */
  let following = Boolean(follow);
  const of = (index: number) => `${index + 1} of ${queue.length}${following ? " so far" : ""}`;
  /**
   * A found song as a stream in the playlist (nothing downloaded): its track id, or null for a source that can't be
   * streamed. Its other matched sources stay with it, to play from if this one goes.
   */
  const streamOf = (candidate: Candidate) => {
    if (!canStream(candidate)) return null;
    const meta = candidate.importMetadata || candidate;
    const key = resultStreamKey(candidate, kind);
    registerStreams([{
      key,
      candidate,
      title: meta.title || candidate.title || "Untitled",
      artist: meta.artist || candidate.artist || "Unknown artist",
      artwork: candidate.importMetadata?.artworkURL || candidate.thumbnailURL || undefined,
      kind: "discover-search",
      ...(kind === "video" ? { video: resultPlatform(candidate) === "youtube" } : {}),
    }]);
    return streamTrackId(key);
  };
  let streamedOpen: ReturnType<typeof place>;
  const failures: { line: string; title: string; artist: string }[] = [];
  const failed = (title: string, artist?: string | null) => failures.push({ line: `${title}${artist ? ` — ${artist}` : ""}`, title, artist: artist || "" });
  // Songs that sound like ones already saved: asked about together once the rest are in, then put in their place.
  const similar: (SimilarPair & { option: Candidate; meta: SourceTrack; at: number })[] = [];
  let created = 0;
  let duplicates = 0;
  let cancelled = false;
  try {
    for (let index = 0; ; index++) {
      if (controller.signal.aborted) {
        cancelled = true;
        break;
      }
      // Out of songs: while the playlist is still being matched, wait for the next ones found.
      while (index >= queue.length && follow && following) {
        set({ transferName: `Waiting for the next song to be found (${queue.length} ${download ? "saved or saving" : "in the playlist"})`, stage: "searching_candidates", progress: null, batch: { index, total: queue.length, following: true, ...streaming } });
        showTransfer();
        let more: { at: number; candidate: Candidate }[] | null = null;
        try {
          more = await follow.next(controller.signal);
        } catch {
          // Cancelled while waiting (checked below).
        }
        if (controller.signal.aborted) break;
        if (more) enqueue(more);
        else following = false;
      }
      if (controller.signal.aborted) {
        cancelled = true;
        break;
      }
      if (index >= queue.length) break;
      const candidate = queue[index].candidate;
      const meta = candidate.importMetadata || candidate;
      batchProgress = { index, total: queue.length };
      set({ transferName: `${of(index)} • ${meta.title || candidate.title || `Playlist item ${index + 1}`}`, stage: "inspecting_source", progress: null, batch: { index, total: queue.length, following, ...streaming } });
      showTransfer();
      if (!download) {
        const id = streamOf(candidate);
        if (!id) {
          failed(meta.title || "Untitled", meta.artist);
          continue;
        }
        slots[index] = id;
        created++;
        // Into the playlist at once, so it plays while the rest are found (the songs already saved join with the first).
        streamedOpen = place([{ at: queue[index].at, id }, ...(streamedOpen ? [] : owned)], follow?.latest() ?? resolution) ?? streamedOpen;
        continue;
      }
      const options = [candidate, ...(candidate.fallbackCandidates ?? []).filter(isDownloadable)];
      let result: ApiResult<StartResult> | null = null;
      let used = candidate;
      // Each source gets three tries, then the next matched source is used.
      sources: for (const option of options) {
        for (let attempt = 0; attempt < 3; attempt++) {
          try {
            if (attempt) await sleep(attempt === 1 ? 400 : 1200, controller.signal);
            used = option;
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
        failed(meta.title || "Untitled", meta.artist);
        continue;
      }
      if (result.result.kind === "similar") {
        similar.push({ saving: importMetadata(used, meta), match: result.result.track, option: used, meta, at: index });
        continue;
      }
      slots[index] = addServerTrack(result.result.track);
      if (result.result.kind === "duplicate") duplicates++;
      else created++;
    }
    if (!cancelled && similar.length) {
      const save = await ask(similarQuestion(similar, kind));
      for (const [n, item] of similar.entries()) {
        if (controller.signal.aborted) {
          cancelled = true;
          break;
        }
        // Skipped: the song already saved stands in for it (in the playlist too).
        let id = "";
        if (save) {
          set({ transferName: `${n + 1} of ${similar.length} • ${item.saving.title}`, stage: "inspecting_source", progress: null });
          showTransfer();
          let again: ApiResult<StartResult> | null = null;
          try {
            again = await startDownload(item.option, item.meta, kind, controller.signal, true);
          } catch (error) {
            if (asFailure(error, "inspecting_source").code === "CANCELLED") {
              cancelled = true;
              break;
            }
          }
          if (!again?.ok) {
            if (again?.error.code === "CANCELLED") {
              cancelled = true;
              break;
            }
            failed(item.saving.title, item.saving.artist);
            continue;
          }
          id = addServerTrack(again.result.track);
          if (again.result.kind === "created") created++;
          else duplicates++;
        } else {
          id = addServerTrack(item.match);
          duplicates++;
        }
        slots[item.at] = id;
      }
    }
  } finally {
    // In the source playlist's order, each song once (a playlist can list one twice, or two of its songs be one
    // already saved). Songs already in the library join only if at least one song was kept, so a cancelled or
    // failed download doesn't leave a playlist of only those.
    const kept = created + duplicates;
    const placed = slots.flatMap((id, index) => (id ? [{ at: queue[index].at, id }] : []));
    // The playlist as it now stands (a followed one has more rows, and songs owned among them).
    const final = follow?.latest() ?? resolution;
    if (placed.length) placed.push(...(follow ? ownedIn(final, new Set(queue.map((entry) => entry.at))) : owned));
    const open = place(placed, final);
    const plural = (n: number) => `${n} ${noun}${n === 1 ? "" : "s"}`;
    settle({ playlistId: open?.playlistId ?? null, kept, total: queue.length, failed: failures.length, cancelled });
    if (!download && !cancelled) {
      finishTransfer(`Added ${plural(kept)} to “${playlistTitle}”`, {
        tone: failures.length ? "error" : "success",
        detail: failures.length ? `${plural(failures.length)} couldn't be streamed.` : "They stream from YouTube and SoundCloud: nothing was downloaded.",
        action: open,
      }, { quietInline: true });
      set({ stage: "complete" });
    } else if (cancelled) {
      finishTransfer(download ? "Playlist download cancelled" : "Stopped adding songs", { detail: `${download ? "Kept" : "Added"} ${kept} of ${plural(queue.length)}.`, action: open }, { quietInline: true });
      set({ stage: "cancelled" });
    } else if (failures.length) {
      finishTransfer(`Kept ${kept} of ${plural(queue.length)}`, { tone: "error", detail: `Failed after retrying: ${failures.slice(0, 3).map((f) => f.line).join("; ")}${failures.length > 3 ? ` and ${failures.length - 3} more` : ""}.`, action: open, duration: 9000 }, { quietInline: true });
      set({ stage: "failed", error: { stage: "downloading", message: `${failures.length} ${noun}${failures.length === 1 ? "" : "s"} could not be downloaded.` } });
    } else {
      const already = duplicates + owned.length;
      finishTransfer(`Kept ${plural(kept)} from “${playlistTitle}”`, {
        tone: "success",
        detail: already ? `${already} ${already === 1 ? "was" : "were"} already in your library; ${already === 1 ? "it's" : "they're"} in the playlist too.` : "Saved to your music server and kept on this device.",
        action: open,
      }, { quietInline: true });
      set({ stage: "complete" });
    }
    end(controller);
    if (!cancelled) showSaveSummary(final, kept, open?.playlistId ?? null, makePlaylist ? playlistTitle : null, failures, !download);
  }
}

/**
 * Once a playlist's songs are saved, the ones that weren't, in the list's order: never matched to an upload (or
 * never read from Spotify), then those that couldn't be downloaded. Nothing to show, no dialog; nor over another one.
 */
function showSaveSummary(final: Resolution, saved: number, playlistId: string | null, playlistName: string | null, failures: { title: string; artist: string }[], streamed = false) {
  const missing: ImportMissing[] = final.candidates.flatMap((c) => {
    if (!c.unmatched) return [];
    const meta = c.importMetadata;
    return [{ title: meta?.title || `Song ${c.playlistIndex ?? ""}`.trim(), artist: meta?.artist || "", reason: c.unmatched }];
  });
  missing.push(...failures.map((f) => ({ title: f.title, artist: f.artist, reason: streamed ? "unstreamable" as const : "failed" as const })));
  if (!missing.length) return;
  const summary = { type: "importSummary" as const, saved, playlistId, playlistName, missing, streamed };
  // Over another dialog it waits, and opens once that one closes (see the app wiring below).
  if (getState().modal) pendingSummary = summary;
  else openModal(summary);
}
/** A save's summary held back while another dialog was open. */
let pendingSummary: Extract<NonNullable<AppState["modal"]>, { type: "importSummary" }> | null = null;

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
  // (A moment later, so a dialog closing only to open another, in one go, isn't taken for the way being clear.)
  if (pendingSummary && !s.modal) {
    setTimeout(() => {
      if (!pendingSummary || getState().modal) return;
      const summary = pendingSummary;
      pendingSummary = null;
      openModal(summary);
    }, 0);
  }
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

// Playlists made without downloading keep their streamed songs (store.ts): they're playable songs again from the start.
keepStreamsWith(keptStream);
registerStreams(Object.values(savedPlaylistStreams()));

// Live audio and app state cannot be swapped in place: when this module (or anything it imports) changes, reload the page.
if (import.meta.hot) import.meta.hot.accept(() => location.reload());
