import { bytes, checkNotDeleted, getProfile, HttpError, https, normalizeUsername, record, text, USERNAME, type LibraryEnv, type Profile } from "./library";

/*
 * Friends and shared playlists.
 *
 * Friends: everyone has a friend code (like a Listen Along code). Sending
 * someone's code asks them to be friends; once they accept, each sees the
 * other's shared playlists, what they're playing (unless they've turned that
 * off) and the Listen Along room they're hosting, to join it in one click.
 *
 * Shared playlists: the owner's app publishes a playlist (its songs as links
 * and details, as Listen Along sends them) and republishes it as it changes,
 * so everyone sees the current version. Anyone signed in with its link can
 * open, play and follow it; only the owner changes it. It can also be sent to
 * friends, and shows on the owner's profile for friends.
 */

const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
export const FRIEND_CODE = /^[A-HJ-NP-Z2-9]{4}-?[A-HJ-NP-Z2-9]{4}$/;
export const SHARE_ID = /^[a-z0-9]{16}$/;
const PLAYLIST_ID = /^[A-Za-z0-9_-]{1,80}$/;
const MAX_SHARED_SONGS = 2_000;
const MAX_SHARE_BYTES = 900 * 1024;
const MAX_PENDING = 100;
const MAX_FRIENDS = 500;
/** What a friend played longer ago than this isn't shown as "listening now". */
const ACTIVITY_FRESH_MS = 10 * 60_000;

function randomCode(alphabet: string, length: number) {
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  return [...bytes].map((b) => alphabet[b % alphabet.length]).join("");
}
export const normalizeFriendCode = (code: string) => code.toUpperCase().replace(/-/g, "").replace(/^(.{4})(.{4})$/, "$1-$2");

/** Everything about `userId` this file keeps, for deleting an account (deleteAccount runs these with the rest, at once). */
export function socialDeletions(env: LibraryEnv, userId: string) {
  return [
    env.DB.prepare("DELETE FROM activity WHERE user_id = ?").bind(userId),
    env.DB.prepare("DELETE FROM friend_requests WHERE from_id = ?1 OR to_id = ?1").bind(userId),
    env.DB.prepare("DELETE FROM friends WHERE user_id = ?1 OR friend_id = ?1").bind(userId),
    env.DB.prepare("DELETE FROM playlist_follows WHERE user_id = ?1 OR share_id IN (SELECT id FROM shared_playlists WHERE owner_id = ?1)").bind(userId),
    env.DB.prepare("DELETE FROM playlist_inbox WHERE user_id = ?1 OR from_id = ?1 OR share_id IN (SELECT id FROM shared_playlists WHERE owner_id = ?1)").bind(userId),
    env.DB.prepare("DELETE FROM shared_playlists WHERE owner_id = ?").bind(userId),
  ];
}

/** Tries values from `next` for a unique column until one is free. */
async function assignUnique(env: LibraryEnv, userId: string, column: "friend_code" | "username", next: (attempt: number) => string) {
  for (let attempt = 0; attempt < 8; attempt++) {
    try {
      await env.DB.prepare(`UPDATE users SET ${column} = ? WHERE id = ? AND ${column} IS NULL`).bind(next(attempt), userId).run();
      return;
    } catch {
      // Taken (the unique index): try another.
    }
  }
}

/** A starting username from a name ("Gav Die!" becomes "gavdie"), or "listener". */
function baseUsername(name: string) {
  const slug = name.normalize("NFKD").toLowerCase().replace(/[^a-z0-9_]/g, "").slice(0, 16);
  return slug.length >= 3 ? slug : "listener";
}

/** The caller's profile, given a friend code and a username (from `suggested`, or their name) the first time it's asked for. */
export async function profileWithCode(env: LibraryEnv, userId: string, suggested?: string | null): Promise<Profile | null> {
  const profile = await getProfile(env, userId);
  if (!profile || (profile.friendCode && profile.username)) return profile;
  if (!profile.friendCode) {
    await assignUnique(env, userId, "friend_code", () => {
      const raw = randomCode(CODE_ALPHABET, 8);
      return `${raw.slice(0, 4)}-${raw.slice(4)}`;
    });
  }
  if (!profile.username) {
    const wanted = suggested ? normalizeUsername(suggested) : "";
    const base = USERNAME.test(wanted) ? wanted.slice(0, 16) : baseUsername(profile.displayName);
    await assignUnique(env, userId, "username", (attempt) => (attempt === 0 ? base : attempt < 4 ? `${base}${attempt + 1}` : `${base}${randomCode("0123456789", 4)}`));
  }
  return getProfile(env, userId);
}

/* ───────────────────────── who's who ───────────────────────── */

export interface Person { id: string; displayName: string; avatarUrl: string | null; username: string | null }
type PersonRow = { id: string; display_name: string; avatar_url: string | null; username?: string | null };
const person = (row: PersonRow): Person => ({ id: row.id, displayName: row.display_name, avatarUrl: row.avatar_url, username: row.username ?? null });

async function areFriends(env: LibraryEnv, a: string, b: string) {
  return Boolean(await env.DB.prepare("SELECT 1 FROM friends WHERE user_id = ? AND friend_id = ?").bind(a, b).first());
}

/* ───────────────────────── what you're playing ───────────────────────── */

interface Activity {
  song: { title: string; artist: string; sourceURL: string | null; artworkUrl: string | null } | null;
  playing: boolean;
  /** The Listen Along room they host, for friends to join. */
  roomCode: string | null;
}

export async function setActivity(env: LibraryEnv, userId: string, body: unknown) {
  const input = record(body) ?? {};
  const profile = await getProfile(env, userId);
  if (!profile) throw new HttpError(400, "Choose a display name first.");
  if (!profile.shareActivity) return { shared: false };
  const song = record(input.song);
  const title = song && text(song.title, 300);
  const activity: Activity = {
    song: song && title ? { title, artist: text(song.artist, 300) ?? "Unknown artist", sourceURL: https(song.sourceURL), artworkUrl: https(song.artworkUrl) } : null,
    playing: input.playing === true,
    roomCode: typeof input.roomCode === "string" && FRIEND_CODE.test(input.roomCode) ? normalizeFriendCode(input.roomCode) : null,
  };
  await checkNotDeleted(env, userId);
  await env.DB.prepare("INSERT INTO activity (user_id, data, updated_at) VALUES (?1, ?2, ?3) ON CONFLICT(user_id) DO UPDATE SET data = ?2, updated_at = ?3")
    .bind(userId, JSON.stringify(activity), Date.now()).run();
  return { shared: true };
}

/* ───────────────────────── friends ───────────────────────── */

/**
 * Everything the friends panel shows, in one call: friends (with what they're
 * playing), requests both ways, playlists friends sent you, the playlists you
 * share and the shared playlists you follow.
 */
export async function getSocial(env: LibraryEnv, userId: string) {
  const now = Date.now();
  const [friends, incoming, outgoing, inbox, mine, following] = await env.DB.batch([
    env.DB.prepare(
      "SELECT u.id, u.display_name, u.avatar_url, u.username, f.since, u.share_activity, a.data AS activity, a.updated_at AS activity_at FROM friends f JOIN users u ON u.id = f.friend_id " +
        "LEFT JOIN activity a ON a.user_id = u.id WHERE f.user_id = ? ORDER BY u.display_name COLLATE NOCASE",
    ).bind(userId),
    env.DB.prepare("SELECT u.id, u.display_name, u.avatar_url, u.username, r.created_at FROM friend_requests r JOIN users u ON u.id = r.from_id WHERE r.to_id = ? ORDER BY r.created_at DESC").bind(userId),
    env.DB.prepare("SELECT u.id, u.display_name, u.avatar_url, u.username, r.created_at FROM friend_requests r JOIN users u ON u.id = r.to_id WHERE r.from_id = ? ORDER BY r.created_at DESC").bind(userId),
    env.DB.prepare(
      "SELECT i.share_id, i.at, s.data, s.updated_at, u.id, u.display_name, u.avatar_url, u.username FROM playlist_inbox i JOIN shared_playlists s ON s.id = i.share_id " +
        "JOIN users u ON u.id = i.from_id WHERE i.user_id = ? ORDER BY i.at DESC",
    ).bind(userId),
    env.DB.prepare("SELECT id, playlist_id, on_profile, updated_at FROM shared_playlists WHERE owner_id = ?").bind(userId),
    env.DB.prepare(
      "SELECT s.id AS share_id, s.data, s.updated_at, f.at, u.id, u.display_name, u.avatar_url, u.username FROM playlist_follows f JOIN shared_playlists s ON s.id = f.share_id " +
        "JOIN users u ON u.id = s.owner_id WHERE f.user_id = ? ORDER BY f.at DESC",
    ).bind(userId),
  ]);
  type Row = Record<string, unknown> & PersonRow;
  const rows = (r: D1Result) => (r.results ?? []) as Row[];
  const summary = (row: Row) => {
    const data = JSON.parse(String(row.data)) as SharedData;
    return { shareId: String(row.share_id), name: data.name, description: data.description, songCount: data.tracks.length, artworkUrl: data.tracks.find((t) => t.artworkUrl)?.artworkUrl ?? null, updatedAt: Number(row.updated_at), owner: person(row) };
  };
  return {
    friends: rows(friends).map((row) => {
      const at = Number(row.activity_at ?? 0);
      const fresh = row.share_activity !== 0 && row.activity && now - at < ACTIVITY_FRESH_MS;
      return { ...person(row), since: Number(row.since), activity: fresh ? { ...(JSON.parse(String(row.activity)) as Activity), at } : null };
    }),
    incoming: rows(incoming).map((row) => ({ ...person(row), at: Number(row.created_at) })),
    outgoing: rows(outgoing).map((row) => ({ ...person(row), at: Number(row.created_at) })),
    inbox: rows(inbox).map((row) => ({ ...summary(row), sentAt: Number(row.at) })),
    shared: (mine.results as Array<{ id: string; playlist_id: string; on_profile: number; updated_at: number }>).map((r) => ({ shareId: r.id, playlistId: r.playlist_id, onProfile: r.on_profile !== 0, updatedAt: r.updated_at })),
    following: rows(following).map((row) => ({ ...summary(row), followedAt: Number(row.at) })),
  };
}

/** Asks the person with friend code or username `code` to be friends; if they'd already asked you, you're friends now. */
export async function requestFriend(env: LibraryEnv, userId: string, body: unknown) {
  const code = text(record(body)?.code, 40);
  const byCode = Boolean(code && FRIEND_CODE.test(code));
  const name = code ? normalizeUsername(code) : "";
  if (!byCode && !USERNAME.test(name)) throw new HttpError(400, "Enter a friend code (like ABCD-2345) or a username.");
  if (!(await getProfile(env, userId))) throw new HttpError(400, "Choose a display name first.");
  // A friend code can also look like a username ("abcd2345"): the code is tried first.
  let other = byCode ? await env.DB.prepare("SELECT id, display_name, avatar_url, username FROM users WHERE friend_code = ?").bind(normalizeFriendCode(code!)).first<PersonRow>() : null;
  if (!other && USERNAME.test(name)) other = await env.DB.prepare("SELECT id, display_name, avatar_url, username FROM users WHERE username = ?").bind(name).first<PersonRow>();
  if (!other) throw new HttpError(404, byCode ? "Nobody has that friend code. Check it with your friend." : `Nobody is called @${name}. Check the username with your friend.`);
  if (other.id === userId) throw new HttpError(400, "That's you.");
  if (await areFriends(env, userId, other.id)) return { status: "friends" as const, person: person(other) };
  await checkNotDeleted(env, userId);
  const theyAsked = await env.DB.prepare("SELECT 1 FROM friend_requests WHERE from_id = ? AND to_id = ?").bind(other.id, userId).first();
  if (theyAsked) {
    await befriend(env, userId, other.id);
    return { status: "friends" as const, person: person(other) };
  }
  await checkFriendLimit(env, userId, other.id);
  const counts = await env.DB.prepare("SELECT COUNT(*) AS pending FROM friend_requests WHERE from_id = ?").bind(userId).first<{ pending: number }>();
  if ((counts?.pending ?? 0) >= MAX_PENDING) throw new HttpError(429, "You have too many friend requests waiting. Cancel some first.");
  await env.DB.prepare("INSERT INTO friend_requests (from_id, to_id, created_at) VALUES (?, ?, ?) ON CONFLICT DO NOTHING").bind(userId, other.id, Date.now()).run();
  return { status: "requested" as const, person: person(other) };
}

/** Refuses when either person already has the most friends allowed. */
async function checkFriendLimit(env: LibraryEnv, a: string, b: string) {
  const row = await env.DB.prepare("SELECT (SELECT COUNT(*) FROM friends WHERE user_id = ?1) AS mine, (SELECT COUNT(*) FROM friends WHERE user_id = ?2) AS theirs").bind(a, b)
    .first<{ mine: number; theirs: number }>();
  if ((row?.mine ?? 0) >= MAX_FRIENDS) throw new HttpError(413, `You can have up to ${MAX_FRIENDS} friends.`);
  if ((row?.theirs ?? 0) >= MAX_FRIENDS) throw new HttpError(413, "They already have as many friends as Slopify allows.");
}

async function befriend(env: LibraryEnv, a: string, b: string) {
  await checkFriendLimit(env, a, b);
  const now = Date.now();
  await env.DB.batch([
    env.DB.prepare("INSERT INTO friends (user_id, friend_id, since) VALUES (?1, ?2, ?3) ON CONFLICT DO NOTHING").bind(a, b, now),
    env.DB.prepare("INSERT INTO friends (user_id, friend_id, since) VALUES (?2, ?1, ?3) ON CONFLICT DO NOTHING").bind(a, b, now),
    env.DB.prepare("DELETE FROM friend_requests WHERE (from_id = ?1 AND to_id = ?2) OR (from_id = ?2 AND to_id = ?1)").bind(a, b),
  ]);
}

export async function acceptFriend(env: LibraryEnv, userId: string, fromId: string) {
  const asked = await env.DB.prepare("SELECT 1 FROM friend_requests WHERE from_id = ? AND to_id = ?").bind(fromId, userId).first();
  if (!asked) throw new HttpError(404, "That friend request isn't there anymore.");
  await checkNotDeleted(env, userId);
  await befriend(env, userId, fromId);
  return { status: "friends" as const };
}

/** Declines a request to you, or cancels one you sent. */
export async function dropRequest(env: LibraryEnv, userId: string, otherId: string) {
  await env.DB.prepare("DELETE FROM friend_requests WHERE (from_id = ?1 AND to_id = ?2) OR (from_id = ?2 AND to_id = ?1)").bind(userId, otherId).run();
  return { removed: true };
}

/** Stops being friends, both ways. Playlists they sent you stay until you dismiss them. */
export async function unfriend(env: LibraryEnv, userId: string, friendId: string) {
  await env.DB.prepare("DELETE FROM friends WHERE (user_id = ?1 AND friend_id = ?2) OR (user_id = ?2 AND friend_id = ?1)").bind(userId, friendId).run();
  return { removed: true };
}

/** A friend's profile playlists. */
export async function friendPlaylists(env: LibraryEnv, userId: string, friendId: string) {
  if (!(await areFriends(env, userId, friendId))) throw new HttpError(403, "You can only see your friends' playlists.");
  const { results } = await env.DB.prepare(
    "SELECT s.id AS share_id, s.data, s.updated_at, u.id, u.display_name, u.avatar_url, u.username FROM shared_playlists s JOIN users u ON u.id = s.owner_id WHERE s.owner_id = ? AND s.on_profile = 1 ORDER BY s.updated_at DESC",
  ).bind(friendId).all<Record<string, unknown> & PersonRow>();
  return results.map((row) => {
    const data = JSON.parse(String(row.data)) as SharedData;
    return { shareId: String(row.share_id), name: data.name, description: data.description, songCount: data.tracks.length, artworkUrl: data.tracks.find((t) => t.artworkUrl)?.artworkUrl ?? null, updatedAt: Number(row.updated_at), owner: person(row) };
  });
}

/* ───────────────────────── shared playlists ───────────────────────── */

interface SharedSong { title: string; artist: string; album: string | null; sourceURL: string; savedAs: "audio" | "video"; durationSeconds: number | null; artworkUrl: string | null }
interface SharedData { name: string; description: string; tracks: SharedSong[] }

function checkShared(body: unknown): SharedData & { onProfile: boolean } {
  const input = record(body);
  if (!input) throw new HttpError(400, "Send the playlist as an object.");
  const name = text(input.name, 100);
  if (!name) throw new HttpError(400, "A shared playlist needs a name.");
  if (!Array.isArray(input.tracks)) throw new HttpError(400, "Send the playlist's songs.");
  if (input.tracks.length > MAX_SHARED_SONGS) throw new HttpError(413, `A shared playlist can have up to ${MAX_SHARED_SONGS.toLocaleString("en")} songs.`);
  const tracks = input.tracks.flatMap((value): SharedSong[] => {
    const s = record(value);
    const title = s && text(s.title, 300);
    const sourceURL = s && https(s.sourceURL);
    if (!s || !title || !sourceURL) return [];
    return [{
      title,
      artist: text(s.artist, 300) ?? "Unknown artist",
      album: text(s.album, 300),
      sourceURL,
      savedAs: s.savedAs === "video" ? "video" : "audio",
      durationSeconds: typeof s.durationSeconds === "number" && s.durationSeconds > 0 && s.durationSeconds < 86_400 ? s.durationSeconds : null,
      artworkUrl: https(s.artworkUrl),
    }];
  });
  return { name, description: text(input.description, 500) ?? "", tracks, onProfile: input.onProfile !== false };
}

/** Shares the caller's playlist `playlistId`, or updates the shared copy. The link stays the same while it's shared. */
export async function sharePlaylist(env: LibraryEnv, userId: string, playlistId: string, body: unknown) {
  if (!PLAYLIST_ID.test(playlistId)) throw new HttpError(400, "Invalid playlist id.");
  const { onProfile, ...data } = checkShared(body);
  const json = JSON.stringify(data);
  if (bytes(json) > MAX_SHARE_BYTES) throw new HttpError(413, "This playlist is too large to share.");
  if (!(await getProfile(env, userId))) throw new HttpError(400, "Choose a display name first.");
  await checkNotDeleted(env, userId);
  // An automatic republish names the version it saw: a newer one (from another device) isn't replaced.
  const base = record(body)?.baseUpdatedAt;
  if (typeof base === "number") {
    const current = await env.DB.prepare("SELECT updated_at FROM shared_playlists WHERE owner_id = ? AND playlist_id = ?").bind(userId, playlistId).first<{ updated_at: number }>();
    if (current && current.updated_at !== base) throw new HttpError(409, "This playlist was shared from another device since. Catch up first.");
  }
  const now = Date.now();
  const row = await env.DB.prepare(
    "INSERT INTO shared_playlists (id, owner_id, playlist_id, on_profile, data, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6) " +
      "ON CONFLICT(owner_id, playlist_id) DO UPDATE SET on_profile = ?4, data = ?5, updated_at = ?6 RETURNING id",
  ).bind(randomCode("abcdefghijklmnopqrstuvwxyz0123456789", 16), userId, playlistId, onProfile ? 1 : 0, json, now).first<{ id: string }>();
  return { shareId: row!.id, playlistId, onProfile, updatedAt: now, songCount: data.tracks.length };
}

/** Stops sharing: the link stops working, and it's gone from followers' libraries and friends' inboxes. */
export async function unsharePlaylist(env: LibraryEnv, userId: string, playlistId: string) {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM playlist_follows WHERE share_id IN (SELECT id FROM shared_playlists WHERE owner_id = ?1 AND playlist_id = ?2)").bind(userId, playlistId),
    env.DB.prepare("DELETE FROM playlist_inbox WHERE share_id IN (SELECT id FROM shared_playlists WHERE owner_id = ?1 AND playlist_id = ?2)").bind(userId, playlistId),
    env.DB.prepare("DELETE FROM shared_playlists WHERE owner_id = ?1 AND playlist_id = ?2").bind(userId, playlistId),
  ]);
  return { removed: true };
}

/** A shared playlist, for anyone signed in with its link. */
export async function getShared(env: LibraryEnv, userId: string, shareId: string) {
  const row = await env.DB.prepare(
    "SELECT s.id AS share_id, s.owner_id, s.playlist_id, s.data, s.updated_at, u.id, u.display_name, u.avatar_url, u.username, " +
      "EXISTS (SELECT 1 FROM playlist_follows WHERE user_id = ?2 AND share_id = s.id) AS following FROM shared_playlists s JOIN users u ON u.id = s.owner_id WHERE s.id = ?1",
  ).bind(shareId, userId).first<Record<string, unknown> & PersonRow>();
  if (!row) throw new HttpError(404, "This playlist isn't shared anymore, or the link is wrong.");
  const data = JSON.parse(String(row.data)) as SharedData;
  const mine = row.owner_id === userId;
  return { shareId, ...data, updatedAt: Number(row.updated_at), owner: person(row), mine, ...(mine ? { playlistId: String(row.playlist_id) } : {}), following: Boolean(row.following) };
}

export async function followShared(env: LibraryEnv, userId: string, shareId: string, follow: boolean) {
  if (!follow) {
    await env.DB.prepare("DELETE FROM playlist_follows WHERE user_id = ? AND share_id = ?").bind(userId, shareId).run();
    return { following: false };
  }
  const owner = await env.DB.prepare("SELECT owner_id FROM shared_playlists WHERE id = ?").bind(shareId).first<{ owner_id: string }>();
  if (!owner) throw new HttpError(404, "This playlist isn't shared anymore.");
  if (owner.owner_id === userId) throw new HttpError(400, "It's your own playlist.");
  await checkNotDeleted(env, userId);
  await env.DB.batch([
    env.DB.prepare("INSERT INTO playlist_follows (user_id, share_id, at) VALUES (?1, ?2, ?3) ON CONFLICT DO NOTHING").bind(userId, shareId, Date.now()),
    env.DB.prepare("DELETE FROM playlist_inbox WHERE user_id = ? AND share_id = ?").bind(userId, shareId),
  ]);
  return { following: true };
}

/** Sends a shared playlist to friends; it shows in their inbox until they open or dismiss it. */
export async function sendShared(env: LibraryEnv, userId: string, shareId: string, body: unknown) {
  const ids = record(body)?.friendIds;
  if (!Array.isArray(ids) || !ids.length || ids.length > 50 || !ids.every((id) => typeof id === "string" && id.length <= 200)) throw new HttpError(400, "Choose who to send it to.");
  const share = await env.DB.prepare("SELECT 1 FROM shared_playlists WHERE id = ?").bind(shareId).first();
  if (!share) throw new HttpError(404, "This playlist isn't shared anymore.");
  const { results } = await env.DB.prepare(`SELECT friend_id FROM friends WHERE user_id = ? AND friend_id IN (${ids.map(() => "?").join(",")})`).bind(userId, ...ids).all<{ friend_id: string }>();
  if (!results.length) throw new HttpError(403, "You can only send playlists to your friends.");
  await checkNotDeleted(env, userId);
  const now = Date.now();
  // Not to friends who already follow it (it's in their library).
  await env.DB.batch(results.map((r) => env.DB.prepare(
    "INSERT INTO playlist_inbox (user_id, share_id, from_id, at) SELECT ?1, ?2, ?3, ?4 WHERE NOT EXISTS (SELECT 1 FROM playlist_follows WHERE user_id = ?1 AND share_id = ?2) " +
      "ON CONFLICT(user_id, share_id) DO UPDATE SET from_id = ?3, at = ?4",
  ).bind(r.friend_id, shareId, userId, now)));
  return { sent: results.length };
}

export async function dismissInbox(env: LibraryEnv, userId: string, shareId: string) {
  await env.DB.prepare("DELETE FROM playlist_inbox WHERE user_id = ? AND share_id = ?").bind(userId, shareId).run();
  return { removed: true };
}
