import type { ClipRange } from "../data/types";

/*
 * The music server's song API (server/songs.mjs). The server keeps each song as
 * a link with metadata; this device keeps the audio (see device.ts).
 */

export interface ServerSong {
  id: string;
  title: string;
  artist: string;
  album: string | null;
  durationSeconds: number | null;
  /** Saved as a video (plays with its picture) or as audio. */
  savedAs: "audio" | "video";
  addedAt: number;
  updatedAt: number;
  sourceURL: string | null;
  artworkUrl: string | null;
  clip: ClipRange | null;
  /** Further metadata under namespaced keys, for features that need no server change. */
  extra: Record<string, unknown>;
  /** Where to fetch the audio: the server prepares it from the source link. */
  fileUrl: string;
  /** The server still holds audio stored before links, until a device keeps its own copy. */
  serverCopy: boolean;
  /** The YouTube or SoundCloud page the audio comes from (for another computer, through an account). */
  playableURL?: string | null;
}

/** Metadata a client may change (the server checks each field; see SONG_FIELDS). */
export type SongChanges = Partial<Pick<ServerSong, "title" | "artist" | "album" | "durationSeconds" | "savedAs" | "artworkUrl" | "clip">> & {
  /** Keys set to null are removed. */
  extra?: Record<string, unknown>;
};

const songUrl = (id: string) => `/api/songs/${encodeURIComponent(id)}`;

async function call<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, { cache: "no-store", ...init });
  const body = await res.json().catch(() => null);
  if (!res.ok || !body?.ok) throw Object.assign(new Error(body?.error?.message || `Music server error (HTTP ${res.status}).`), { status: res.status });
  return body as T;
}

export async function listSongs() {
  return (await call<{ songs: ServerSong[] }>("/api/songs")).songs;
}

export async function updateSong(id: string, changes: SongChanges) {
  return (await call<{ song: ServerSong }>(songUrl(id), { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(changes) })).song;
}

/*
 * Metadata edits (clips, for now) wait here until the server has them, kept
 * across reloads so an edit made while the server is unreachable isn't lost.
 * Library sync sends them before reading the server's records.
 *
 * Every tab shares the stored queue, so each change re-reads it first: one
 * tab's edits never overwrite another's.
 */
const QUEUE_KEY = "slopify.song-changes.v1";
type Queue = Record<string, SongChanges>;
/** Used when storage is unavailable; edits are then still sent this session. */
let memory: Queue = {};

function readQueue(): Queue {
  try {
    const stored = localStorage.getItem(QUEUE_KEY);
    if (stored !== null) memory = JSON.parse(stored);
  } catch {
    // Unreadable: keep what this tab knows.
  }
  return memory;
}
function updateQueue(change: (queue: Queue) => void) {
  const queue = { ...readQueue() };
  change(queue);
  memory = queue;
  try {
    localStorage.setItem(QUEUE_KEY, JSON.stringify(queue));
  } catch {
    // Still sent this session.
  }
}

/** A later edit wins field by field; `extra` keys combine. */
function combine(earlier: SongChanges | undefined, later: SongChanges): SongChanges {
  const merged = { ...earlier, ...later };
  if (earlier?.extra && later.extra) merged.extra = { ...earlier.extra, ...later.extra };
  return merged;
}

/** Changes to a song not yet on the server, which take precedence over the server's copy. */
export const pendingSongChanges = (id: string): SongChanges | undefined => readQueue()[id];

/** Records an edit and sends it (with any others waiting). */
export function saveSongChanges(id: string, changes: SongChanges) {
  updateQueue((queue) => {
    queue[id] = combine(queue[id], changes);
  });
  return flushSongChanges();
}

let flushing: Promise<void> | null = null;
/** Sends every waiting edit, including ones made while sending; rejects if any couldn't be sent. */
export function flushSongChanges(): Promise<void> {
  flushing ??= sendQueued().finally(() => {
    flushing = null;
  });
  return flushing;
}

async function sendQueued() {
  const failed = new Set<string>();
  let failure: unknown;
  for (;;) {
    const queue = readQueue();
    const id = Object.keys(queue).find((key) => !failed.has(key));
    if (!id) break;
    const changes = queue[id];
    const sent = JSON.stringify(changes);
    try {
      await updateSong(id, changes);
    } catch (error) {
      // The song was deleted elsewhere: its edits no longer apply.
      if ((error as { status?: number }).status === 404) {
        updateQueue((q) => void delete q[id]);
      } else {
        failed.add(id);
        failure ??= error;
      }
      continue;
    }
    // An edit made during the request (in any tab) stays queued and is sent next.
    updateQueue((q) => {
      if (JSON.stringify(q[id]) === sent) delete q[id];
    });
  }
  if (failure) throw failure;
}

/** Deletes the song from the server. `keepalive` lets it finish as the page closes. */
export async function deleteSong(id: string, { keepalive = false } = {}) {
  const res = await fetch(songUrl(id), { method: "DELETE", keepalive });
  // Already gone counts as deleted.
  if (!res.ok && res.status !== 404) throw new Error(`Couldn't delete the song (HTTP ${res.status}).`);
  updateQueue((q) => void delete q[id]);
}

/** Tells the server this device has verified its own copy, so the server's copies can go. */
export async function releaseSong(id: string) {
  await call(`${songUrl(id)}/release`, { method: "POST" });
}

export const songFileUrl = (id: string) => `${songUrl(id)}/file`;
