/*
 * Accounts' profiles and libraries in D1. A library is the same thing the music
 * server keeps (server/songs.mjs and server/library-state.mjs): saved songs as
 * links with their details, and one document of playlists, likes and settings
 * with a revision number, so a write based on an old copy is refused (409) and
 * the app merges first. The audio itself never comes here.
 */

export interface LibraryEnv { DB: D1Database }

export class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

const MAX_SONG_BYTES = 32 * 1024;
const MAX_STATE_BYTES = 900 * 1024;
const SONG_ID = /^[A-Za-z0-9-]{8,64}$/;

const bytes = (s: string) => new TextEncoder().encode(s).length;
const record = (v: unknown) => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null);
const text = (v: unknown, max: number) => (typeof v === "string" && v.trim() ? v.trim().slice(0, max) : null);
const https = (v: unknown) => {
  if (typeof v !== "string" || v.length > 2048) return null;
  try {
    return new URL(v).protocol === "https:" ? v : null;
  } catch {
    return null;
  }
};

/* ───────────────────────── profile ───────────────────────── */

export interface Profile { id: string; displayName: string; avatarUrl: string | null }

const toProfile = (row: { id: string; display_name: string; avatar_url: string | null }): Profile => ({ id: row.id, displayName: row.display_name, avatarUrl: row.avatar_url });

export async function getProfile(env: LibraryEnv, userId: string): Promise<Profile | null> {
  const row = await env.DB.prepare("SELECT id, display_name, avatar_url FROM users WHERE id = ?").bind(userId).first<{ id: string; display_name: string; avatar_url: string | null }>();
  return row ? toProfile(row) : null;
}

/** Creates or updates the caller's profile. A field left out keeps its value. */
export async function saveProfile(env: LibraryEnv, userId: string, body: unknown): Promise<Profile> {
  const input = record(body);
  if (!input) throw new HttpError(400, "Send the profile as an object.");
  const current = await getProfile(env, userId);
  const displayName = "displayName" in input ? text(input.displayName, 40) : current?.displayName ?? null;
  if (!displayName) throw new HttpError(400, "Choose a display name.");
  const avatarUrl = "avatarUrl" in input ? (input.avatarUrl === null ? null : https(input.avatarUrl)) : current?.avatarUrl ?? null;
  const now = Date.now();
  await env.DB.prepare(
    "INSERT INTO users (id, display_name, avatar_url, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?4) " +
      "ON CONFLICT(id) DO UPDATE SET display_name = ?2, avatar_url = ?3, updated_at = ?4",
  ).bind(userId, displayName, avatarUrl, now).run();
  return { id: userId, displayName, avatarUrl };
}

/* ───────────────────────── songs ───────────────────────── */

/** A song as clients send it, reduced to what's portable between devices. */
function checkSong(id: string, body: unknown) {
  const s = record(body);
  if (!s) throw new HttpError(400, "Send the song as an object.");
  const title = text(s.title, 500);
  const artist = text(s.artist, 500);
  const sourceURL = https(s.sourceURL);
  if (!title || !artist) throw new HttpError(400, "A song needs a title and artist.");
  // Only songs from the web follow an account: a file from one computer can't play on another.
  if (!sourceURL) throw new HttpError(400, "Only songs saved from a link can sync.");
  const clip = s.clip && typeof s.clip === "object" ? (s.clip as Record<string, unknown>) : null;
  const song = {
    id,
    title,
    artist,
    album: text(s.album, 500),
    durationSeconds: typeof s.durationSeconds === "number" && s.durationSeconds > 0 && s.durationSeconds < 86_400 ? s.durationSeconds : null,
    savedAs: s.savedAs === "video" ? "video" : "audio",
    addedAt: typeof s.addedAt === "number" && s.addedAt > 0 ? s.addedAt : Date.now(),
    sourceURL,
    // Where the audio comes from, when the link has none of its own (a Spotify page).
    playableURL: https(s.playableURL),
    artworkUrl: https(s.artworkUrl),
    clip: clip && Number.isFinite(clip.start) && Number.isFinite(clip.end) && (clip.end as number) > (clip.start as number) && (clip.start as number) >= 0 ? { start: clip.start, end: clip.end } : null,
    extra: s.extra && typeof s.extra === "object" && !Array.isArray(s.extra) ? s.extra : {},
  };
  const data = JSON.stringify(song);
  if (bytes(data) > MAX_SONG_BYTES) throw new HttpError(413, "Too much metadata for one song.");
  return data;
}

/**
 * The caller's songs changed after `since` (all of them when it's 0), deleted
 * ones as { id, deleted: true }, and the time to ask from next.
 */
export async function listSongs(env: LibraryEnv, userId: string, since: number) {
  const { results } = await env.DB.prepare("SELECT id, data, deleted, updated_at FROM songs WHERE user_id = ? AND updated_at > ? ORDER BY updated_at")
    .bind(userId, since).all<{ id: string; data: string; deleted: number; updated_at: number }>();
  const songs = results.map((r) => (r.deleted ? { id: r.id, deleted: true, updatedAt: r.updated_at } : { ...JSON.parse(r.data), updatedAt: r.updated_at }));
  const until = results.reduce((max, r) => Math.max(max, r.updated_at), since);
  return { songs, until };
}

/**
 * Writes one song row. Its time is computed inside the same statement (D1 runs
 * writes one at a time), so each change gets a time later than every change
 * before it: a `since` query can never miss one, even two in the same millisecond.
 */
const NEXT_TIME = "MAX(?4, COALESCE((SELECT MAX(updated_at) FROM songs WHERE user_id = ?1), 0) + 1)";
async function writeSong(env: LibraryEnv, userId: string, id: string, data: string, deleted: 0 | 1) {
  const row = await env.DB.prepare(
    `INSERT INTO songs (user_id, id, data, deleted, updated_at) VALUES (?1, ?2, ?3, ?5, ${NEXT_TIME}) ` +
      `ON CONFLICT(user_id, id) DO UPDATE SET data = ?3, deleted = ?5, updated_at = ${NEXT_TIME} RETURNING updated_at`,
  ).bind(userId, id, data, Date.now(), deleted).first<{ updated_at: number }>();
  return row!.updated_at;
}

export async function putSong(env: LibraryEnv, userId: string, id: string, body: unknown) {
  if (!SONG_ID.test(id)) throw new HttpError(400, "Invalid song id.");
  const data = checkSong(id, body);
  const updatedAt = await writeSong(env, userId, id, data, 0);
  return { ...JSON.parse(data), updatedAt };
}

export async function deleteSong(env: LibraryEnv, userId: string, id: string) {
  if (!SONG_ID.test(id)) throw new HttpError(400, "Invalid song id.");
  const updatedAt = await writeSong(env, userId, id, "{}", 1);
  return { id, deleted: true, updatedAt };
}

/* ───────────────────────── library state ───────────────────────── */

export async function getState(env: LibraryEnv, userId: string) {
  const row = await env.DB.prepare("SELECT rev, data FROM library_state WHERE user_id = ?").bind(userId).first<{ rev: number; data: string }>();
  return row ? { rev: row.rev, data: JSON.parse(row.data) as unknown } : { rev: 0, data: null };
}

/** Replaces the document if `baseRev` is still current; otherwise reports a conflict with the current one. */
export async function putState(env: LibraryEnv, userId: string, body: unknown) {
  const input = (record(body) ?? {}) as { baseRev?: unknown; data?: unknown };
  if (!Number.isSafeInteger(input.baseRev) || (input.baseRev as number) < 0 || typeof input.data !== "object" || !input.data) {
    throw new HttpError(400, "Send baseRev and data.");
  }
  const data = JSON.stringify(input.data);
  if (bytes(data) > MAX_STATE_BYTES) throw new HttpError(413, "Your library's playlists and settings are too large to sync.");
  const baseRev = input.baseRev as number;
  const now = Date.now();
  // One statement, so two devices writing at once can't both win.
  const result = baseRev === 0
    ? await env.DB.prepare("INSERT INTO library_state (user_id, rev, data, updated_at) VALUES (?, 1, ?, ?) ON CONFLICT(user_id) DO NOTHING").bind(userId, data, now).run()
    : await env.DB.prepare("UPDATE library_state SET rev = rev + 1, data = ?, updated_at = ? WHERE user_id = ? AND rev = ?").bind(data, now, userId, baseRev).run();
  const current = await getState(env, userId);
  return { conflict: result.meta.changes === 0, ...current };
}
