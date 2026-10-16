import { cloudCall, getAccount } from "./cloud";
import { listSongs, updateSong, type ServerSong, type SongChanges } from "./song-api";

/*
 * Your saved songs, following your Slopify account: this computer's music
 * server and the account keep the same songs (as links, under the same ids, so
 * playlists match everywhere). Each sync takes the account's changes since last
 * time, then sends this computer's.
 *
 * What was last agreed is kept per account (localStorage): the account's
 * timestamp for each song, and this server's timestamp when it was last sent or
 * received. A song changed on both sides keeps this computer's version. Songs
 * added from files on this computer have no link, so they stay here.
 */

interface CloudSong extends Partial<ServerSong> { id: string; updatedAt: number; deleted?: boolean; playableURL?: string | null }
interface Agreed {
  /** Ask the account for changes after this. */
  cursor: number;
  /** Songs both sides have: the account's updatedAt, and this server's when they last matched. */
  songs: Record<string, { cloud: number; local: number }>;
}

/** More songs than this missing here at once is taken as this computer's library being lost, not deleted. */
const MASS_LOSS = 5;

const key = (userId: string) => `slopify.cloud-songs.v1.${userId}`;
function readAgreed(userId: string): Agreed {
  try {
    const value = JSON.parse(localStorage.getItem(key(userId)) || "null") as Agreed | null;
    if (value && Number.isFinite(value.cursor) && value.songs) return value;
  } catch { /* Start afresh. */ }
  return { cursor: 0, songs: {} };
}
/** Forgets what was agreed with an account (it was deleted). */
export function forgetCloudSongs(userId: string) {
  try {
    localStorage.removeItem(key(userId));
  } catch { /* Nothing kept. */ }
}
function writeAgreed(userId: string, agreed: Agreed) {
  try {
    localStorage.setItem(key(userId), JSON.stringify(agreed));
  } catch { /* Next sync starts from the account's full list, which is safe. */ }
}

const portable = (s: ServerSong) => /^https:\/\//.test(s.sourceURL ?? "");
/** The details another device needs, as the account stores them. */
const forCloud = (s: ServerSong & { playableURL?: string | null }) => ({
  title: s.title,
  artist: s.artist,
  album: s.album,
  durationSeconds: s.durationSeconds,
  savedAs: s.savedAs,
  addedAt: s.addedAt,
  sourceURL: s.sourceURL,
  playableURL: s.playableURL ?? null,
  artworkUrl: s.artworkUrl?.startsWith("https://") ? s.artworkUrl : null,
  clip: s.clip,
  extra: s.extra,
});
/** The account's length and cover, where it has them (a cover kept only on this computer is never cleared). */
const cloudDuration = (c: CloudSong) => (Number.isFinite(c.durationSeconds) && c.durationSeconds! > 0 ? c.durationSeconds! : null);
const cloudArtwork = (c: CloudSong) => (c.artworkUrl?.startsWith("https://") ? c.artworkUrl : null);
const sameDetails = (a: ReturnType<typeof forCloud>, b: CloudSong) =>
  a.title === b.title && a.artist === b.artist && (a.album ?? null) === (b.album ?? null) && JSON.stringify(a.clip ?? null) === JSON.stringify(b.clip ?? null)
  && a.savedAs === b.savedAs && JSON.stringify(a.extra ?? {}) === JSON.stringify(b.extra ?? {})
  && (cloudDuration(b) === null || a.durationSeconds === cloudDuration(b))
  && (cloudArtwork(b) === null || a.artworkUrl === cloudArtwork(b));

async function local<T>(url: string, init: RequestInit) {
  const res = await fetch(url, { cache: "no-store", ...init, headers: { "Content-Type": "application/json", ...init.headers } });
  const body = (await res.json().catch(() => null)) as { ok?: boolean; song?: T; error?: { message?: string } } | null;
  if (!res.ok || !body?.ok) throw Object.assign(new Error(body?.error?.message || `Music server error (HTTP ${res.status}).`), { status: res.status });
  return body.song as T;
}

/** Brings this computer's songs and the account's into step. Returns whether this computer's songs changed. */
export async function syncCloudSongs(): Promise<boolean> {
  const userId = getAccount().userId;
  if (getAccount().status !== "signedIn" || !userId) return false;
  const agreed = readAgreed(userId);
  const localSongs = new Map((await listSongs()).map((s) => [s.id, s as ServerSong & { playableURL?: string | null }]));
  const { songs: changes, until } = await cloudCall<{ songs: CloudSong[]; until: number }>(`/v1/library/songs?since=${agreed.cursor}`);
  let changedHere = false;
  const deletedThere = new Set<string>();

  // 1. The account's changes come here.
  for (const c of changes) {
    const mine = localSongs.get(c.id);
    const was = agreed.songs[c.id];
    if (c.deleted) {
      deletedThere.add(c.id);
      // Deleted elsewhere: delete here too, unless it was changed here since (then it's sent back).
      if (mine && (!was || mine.updatedAt <= was.local)) {
        // If it can't be deleted, stop before this is recorded as done: the next sync tries again,
        // rather than sending the song back to the account as if it were new.
        await local(`/api/songs/${encodeURIComponent(c.id)}`, { method: "DELETE" }).catch((error: { status?: number }) => {
          if (error.status !== 404) throw error;
        });
        localSongs.delete(c.id);
        changedHere = true;
      }
      delete agreed.songs[c.id];
      continue;
    }
    if (was?.cloud === c.updatedAt) continue; // Our own change, coming back.
    if (!mine) {
      const created = await local<ServerSong>(`/api/songs/${encodeURIComponent(c.id)}`, { method: "PUT", body: JSON.stringify(c) });
      localSongs.set(c.id, created);
      agreed.songs[c.id] = { cloud: c.updatedAt, local: created.updatedAt };
      changedHere = true;
    } else if (!was || mine.updatedAt <= was.local) {
      // Unchanged here since we last agreed: take the account's version.
      if (!sameDetails(forCloud(mine), c)) {
        const changes: SongChanges = { title: c.title, artist: c.artist, album: c.album ?? null, savedAs: c.savedAs, clip: c.clip ?? null };
        if (cloudDuration(c) !== null) changes.durationSeconds = cloudDuration(c);
        if (cloudArtwork(c) !== null) changes.artworkUrl = cloudArtwork(c);
        const removed = Object.fromEntries(Object.keys(mine.extra ?? {}).filter((k) => !(k in (c.extra ?? {}))).map((k) => [k, null]));
        const updated = await updateSong(c.id, { ...changes, extra: { ...removed, ...(c.extra ?? {}) } });
        localSongs.set(c.id, updated);
        changedHere = true;
      }
      agreed.songs[c.id] = { cloud: c.updatedAt, local: localSongs.get(c.id)!.updatedAt };
    }
    // Otherwise it changed on both sides: this computer's version is sent below.
  }
  agreed.cursor = Math.max(agreed.cursor, until);
  writeAgreed(userId, agreed);

  // 2. This computer's changes go to the account.
  for (const song of localSongs.values()) {
    if (!portable(song) || deletedThere.has(song.id)) continue;
    const was = agreed.songs[song.id];
    if (was && song.updatedAt <= was.local) continue;
    const saved = await cloudCall<CloudSong>(`/v1/library/songs/${encodeURIComponent(song.id)}`, { method: "PUT", body: forCloud(song) });
    agreed.songs[song.id] = { cloud: saved.updatedAt, local: song.updatedAt };
    writeAgreed(userId, agreed);
  }

  // 3. Songs deleted here are deleted from the account, unless so many vanished at once
  // that this computer's library was lost (then they come back from the account instead).
  const missing = Object.keys(agreed.songs).filter((id) => !localSongs.has(id));
  if (missing.length > MASS_LOSS && missing.length > Object.keys(agreed.songs).length / 2) {
    agreed.cursor = 0;
    for (const id of missing) delete agreed.songs[id];
  } else {
    for (const id of missing) {
      await cloudCall(`/v1/library/songs/${encodeURIComponent(id)}`, { method: "DELETE" });
      delete agreed.songs[id];
    }
  }
  writeAgreed(userId, agreed);
  return changedHere;
}
