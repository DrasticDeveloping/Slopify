/*
 * Accounts' profiles and libraries in D1. A library is the same thing the music
 * server keeps (server/songs.mjs and server/library-state.mjs): saved songs as
 * links with their details, and one document of playlists, likes and settings
 * with a revision number, so a write based on an old copy is refused (409) and
 * the app merges first. The audio itself never comes here.
 */

import { socialDeletions } from "./social";

export interface LibraryEnv { DB: D1Database }

export class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

const MAX_SONG_BYTES = 32 * 1024;
/** Songs one account can keep. */
const MAX_SONGS = 20_000;
const MAX_STATE_BYTES = 900 * 1024;
const SONG_ID = /^[A-Za-z0-9-]{8,64}$/;
/**
 * How long writes for a deleted account are refused: longer than another
 * device's sign-in lasts once its user is deleted (Clerk session tokens live a
 * minute), so a sync it started can't put the data back.
 */
const DELETED_FOR_MS = 15 * 60_000;
/** SQL that's true unless user `?1` was deleted after `?<at>` (now less DELETED_FOR_MS). */
const notDeleted = (at: number) => `NOT EXISTS (SELECT 1 FROM deleted_users WHERE id = ?1 AND deleted_at > ?${at})`;
export const deletedSince = () => Date.now() - DELETED_FOR_MS;
const gone = () => new HttpError(410, "This account was deleted.");

/** Refuses with 410 when the account was just deleted. Every write checks this itself too, in the same statement. */
export async function checkNotDeleted(env: LibraryEnv, userId: string) {
  const row = await env.DB.prepare(`SELECT ${notDeleted(2)} AS ok`).bind(userId, deletedSince()).first<{ ok: number }>();
  if (!row?.ok) throw gone();
}

export const bytes = (s: string) => new TextEncoder().encode(s).length;
export const record = (v: unknown) => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null);
export const text = (v: unknown, max: number) => (typeof v === "string" && v.trim() ? v.trim().slice(0, max) : null);
export const https = (v: unknown) => {
  if (typeof v !== "string" || v.length > 2048) return null;
  try {
    return new URL(v).protocol === "https:" ? v : null;
  } catch {
    return null;
  }
};

/* ───────────────────────── profile ───────────────────────── */

export interface Profile {
  id: string;
  displayName: string;
  avatarUrl: string | null;
  /** What friends add you with (src/social.ts). */
  friendCode: string | null;
  /** Unique and changeable, shown as @name; friends can add you by it too. */
  username: string | null;
  /** Whether friends see what you're playing. */
  shareActivity: boolean;
}

interface ProfileRow { id: string; display_name: string; avatar_url: string | null; friend_code: string | null; username: string | null; share_activity: number }
const toProfile = (row: ProfileRow): Profile => ({
  id: row.id, displayName: row.display_name, avatarUrl: row.avatar_url, friendCode: row.friend_code, username: row.username, shareActivity: row.share_activity !== 0,
});

/** 3 to 20 lowercase letters, digits, "_" and "." (not first or last). */
export const USERNAME = /^[a-z0-9_][a-z0-9_.]{1,18}[a-z0-9_]$/;
export const normalizeUsername = (v: string) => v.trim().replace(/^@/, "").toLowerCase();

/** Whether `username` is free (or already the caller's). */
export async function usernameAvailable(env: LibraryEnv, userId: string, username: string) {
  const name = normalizeUsername(username);
  if (!USERNAME.test(name)) return { username: name, available: false, reason: "3 to 20 letters, numbers, _ or ." };
  const row = await env.DB.prepare("SELECT id FROM users WHERE username = ?").bind(name).first<{ id: string }>();
  return { username: name, available: !row || row.id === userId, reason: row && row.id !== userId ? "That username is taken." : null };
}

/** A username the caller asked for, normalised: 400 if it isn't shaped like one, 409 if someone has it. */
async function checkNewUsername(env: LibraryEnv, userId: string, value: unknown) {
  if (typeof value !== "string") throw new HttpError(400, "Choose a username.");
  const { username, available, reason } = await usernameAvailable(env, userId, value);
  if (!USERNAME.test(username)) throw new HttpError(400, "A username is 3 to 20 letters, numbers, _ or . (not first or last).");
  if (!available) throw new HttpError(409, reason ?? "That username is taken.");
  return username;
}

export async function getProfile(env: LibraryEnv, userId: string): Promise<Profile | null> {
  const row = await env.DB.prepare("SELECT id, display_name, avatar_url, friend_code, username, share_activity FROM users WHERE id = ?").bind(userId).first<ProfileRow>();
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
  const shareActivity = typeof input.shareActivity === "boolean" ? input.shareActivity : current?.shareActivity ?? true;
  // A new username is checked first, so a taken one changes nothing (not even the rest of this update).
  let username = current?.username ?? null;
  if ("username" in input && input.username !== username) username = await checkNewUsername(env, userId, input.username);
  const now = Date.now();
  let result: D1Result;
  try {
    result = await env.DB.prepare(
      `INSERT INTO users (id, display_name, avatar_url, share_activity, username, created_at, updated_at) SELECT ?1, ?2, ?3, ?6, ?7, ?4, ?4 WHERE ${notDeleted(5)} ` +
        "ON CONFLICT(id) DO UPDATE SET display_name = ?2, avatar_url = ?3, share_activity = ?6, username = ?7, updated_at = ?4",
    ).bind(userId, displayName, avatarUrl, now, deletedSince(), shareActivity ? 1 : 0, username).run();
  } catch (error) {
    // Taken a moment ago, between the check and the write (the unique index).
    if (String(error).includes("UNIQUE") && String(error).includes("username")) throw new HttpError(409, "That username is taken.");
    throw error;
  }
  if (!result.meta.changes) throw gone();
  // Friends stop seeing what you play as soon as you turn it off.
  if (!shareActivity) await env.DB.prepare("DELETE FROM activity WHERE user_id = ?").bind(userId).run();
  return (await getProfile(env, userId))!;
}

/** Room records older than this are removed: rooms never last that long (MAX_ROOM_MS in src/room.ts). */
const ROOM_RECORD_MS = 2 * 24 * 60 * 60_000;

/**
 * Deletes the caller's profile and library: everything this service keeps
 * about them, except the deletion itself for a few minutes (see DELETED_FOR_MS).
 * All at once, so a write can't land in between. Returns the Listen Along
 * rooms they're in, to be left (src/index.ts), then forgotten with leftRooms.
 *
 * The rooms are read after the deletion is recorded: a room can only be noted
 * before that (noteRoom refuses after), so none is missed. One started or
 * joined meanwhile is checked again once it's set up (src/index.ts).
 */
export async function deleteAccount(env: LibraryEnv, userId: string) {
  await env.DB.batch([
    env.DB.prepare("INSERT INTO deleted_users (id, deleted_at) VALUES (?1, ?2) ON CONFLICT(id) DO UPDATE SET deleted_at = ?2").bind(userId, Date.now()),
    env.DB.prepare("DELETE FROM songs WHERE user_id = ?").bind(userId),
    env.DB.prepare("DELETE FROM song_counts WHERE user_id = ?").bind(userId),
    env.DB.prepare("DELETE FROM library_state WHERE user_id = ?").bind(userId),
    env.DB.prepare("DELETE FROM users WHERE id = ?").bind(userId),
    ...socialDeletions(env, userId),
  ]);
  const { results } = await env.DB.prepare("SELECT code FROM room_members WHERE user_id = ?").bind(userId).all<{ code: string }>();
  return { rooms: results.map((r) => r.code) };
}

/** Records room `code` for a deleted account that still has to be removed from it (deleting again retries it). */
export async function noteLeftRoom(env: LibraryEnv, userId: string, code: string) {
  await env.DB.prepare("INSERT INTO room_members (user_id, code, at) VALUES (?1, ?2, ?3) ON CONFLICT(user_id, code) DO UPDATE SET at = ?3").bind(userId, code, Date.now()).run();
}

/** Forgets the rooms a deleted account was removed from. Those it couldn't be removed from stay, for the next try. */
export async function leftRooms(env: LibraryEnv, userId: string, codes: string[]) {
  if (!codes.length) return;
  await env.DB.batch(codes.map((code) => env.DB.prepare("DELETE FROM room_members WHERE user_id = ? AND code = ?").bind(userId, code)));
}

/** Remembers that the caller started or joined room `code` (see deleteAccount). Refused for a deleted account. */
export async function noteRoom(env: LibraryEnv, userId: string, code: string) {
  const result = await env.DB.prepare(`INSERT INTO room_members (user_id, code, at) SELECT ?1, ?2, ?3 WHERE ${notDeleted(4)} ON CONFLICT(user_id, code) DO UPDATE SET at = ?3`)
    .bind(userId, code, Date.now(), deletedSince()).run();
  if (!result.meta.changes) throw gone();
}

/** Removes deletion, room and listening-activity records that are no longer needed. Run daily (`scheduled` in src/index.ts). */
export async function tidy(env: LibraryEnv) {
  const now = Date.now();
  await env.DB.batch([
    env.DB.prepare("DELETE FROM deleted_users WHERE deleted_at <= ?").bind(now - DELETED_FOR_MS),
    env.DB.prepare("DELETE FROM room_members WHERE at < ?").bind(now - ROOM_RECORD_MS),
    // What someone was playing is only shown for minutes; a day later it's gone.
    env.DB.prepare("DELETE FROM activity WHERE updated_at < ?").bind(now - 24 * 60 * 60_000),
  ]);
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
    `INSERT INTO songs (user_id, id, data, deleted, updated_at) SELECT ?1, ?2, ?3, ?5, ${NEXT_TIME} WHERE ${notDeleted(6)} ` +
      `ON CONFLICT(user_id, id) DO UPDATE SET data = ?3, deleted = ?5, updated_at = ${NEXT_TIME} RETURNING updated_at`,
  ).bind(userId, id, data, Date.now(), deleted, deletedSince()).first<{ updated_at: number }>();
  if (!row) throw gone();
  return row.updated_at;
}

export async function putSong(env: LibraryEnv, userId: string, id: string, body: unknown) {
  if (!SONG_ID.test(id)) throw new HttpError(400, "Invalid song id.");
  const data = checkSong(id, body);
  // A new song (or one deleted before) counts towards the limit; changes to a saved one don't.
  const row = await env.DB.prepare("SELECT (SELECT deleted FROM songs WHERE user_id = ?1 AND id = ?2) AS deleted, COALESCE((SELECT saved FROM song_counts WHERE user_id = ?1), 0) AS saved")
    .bind(userId, id).first<{ deleted: number | null; saved: number }>();
  if (row && row.deleted !== 0 && row.saved >= MAX_SONGS) throw new HttpError(413, `An account can keep up to ${MAX_SONGS.toLocaleString("en")} songs.`);
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
  // One statement, so two devices writing at once can't both win (nor a write land after a deletion).
  const result = baseRev === 0
    ? await env.DB.prepare(`INSERT INTO library_state (user_id, rev, data, updated_at) SELECT ?1, 1, ?2, ?3 WHERE ${notDeleted(4)} ON CONFLICT(user_id) DO NOTHING`).bind(userId, data, now, deletedSince()).run()
    : await env.DB.prepare(`UPDATE library_state SET rev = rev + 1, data = ?2, updated_at = ?3 WHERE user_id = ?1 AND rev = ?4 AND ${notDeleted(5)}`).bind(userId, data, now, baseRev, deletedSince()).run();
  if (!result.meta.changes) await checkNotDeleted(env, userId);
  const current = await getState(env, userId);
  return { conflict: result.meta.changes === 0, ...current };
}
