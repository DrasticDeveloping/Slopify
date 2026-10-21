import { AuthError, verifySession, type AuthEnv } from "./auth";
import { checkNotDeleted, deleteAccount, usernameAvailable, deleteSong, getProfile, getState, HttpError, leftRooms, listSongs, noteLeftRoom, noteRoom, putSong, putState, saveProfile, tidy, type LibraryEnv } from "./library";
import { ListenAlongRoom } from "./room";
import {
  acceptFriend, dismissInbox, dropRequest, followShared, friendPlaylists, getShared, getSocial, profileWithCode, requestFriend, sendShared, setActivity,
  SHARE_ID, sharePlaylist, unfriend, unsharePlaylist,
} from "./social";

/*
 * Slopify's online service (Cloudflare Worker): accounts and profiles, each
 * account's library (songs as links, playlists, likes, settings), and Listen
 * Along rooms. Songs' audio stays with each device's own music server; nothing
 * here downloads or plays music. Every route except /v1/health needs a Clerk
 * session token: `Authorization: Bearer <token>`, or `?token=` for WebSockets,
 * which browsers open without headers.
 *
 * Each account (and, before sign-in is checked, each address) may make a
 * limited number of calls a minute; past it, calls get 429 until the minute is up.
 *
 *   GET    /v1/health
 *   GET    /p/:shareId                 a shared playlist's link opened in a browser: how to open it in Slopify (no sign-in)
 *   GET    /v1/me                      the caller's profile (null until saved), with their friend code
 *   PUT    /v1/me                      { displayName, avatarUrl, shareActivity, username } (409 if the username is taken)
 *   GET    /v1/usernames/:name         { username, available, reason }
 *   PUT    /v1/me/activity             { song, playing, roomCode }: what friends see you playing
 *   GET    /v1/social                  friends (and what they play), requests, inbox, your shares, playlists you follow
 *   POST   /v1/friends/requests        { code }: ask someone to be friends (or accept, if they asked you)
 *   POST   /v1/friends/requests/:id    accept their request
 *   DELETE /v1/friends/requests/:id    decline theirs, or cancel yours
 *   DELETE /v1/friends/:id             stop being friends
 *   GET    /v1/friends/:id/playlists   a friend's profile playlists
 *   PUT    /v1/shares/:playlistId      { name, description, tracks, onProfile }: share your playlist, or update it → { shareId }
 *   DELETE /v1/shares/:playlistId      stop sharing it
 *   GET    /v1/shared/:shareId         a shared playlist
 *   PUT    /v1/shared/:shareId/follow  follow it (DELETE: unfollow)
 *   POST   /v1/shared/:shareId/send    { friendIds }: send it to friends
 *   DELETE /v1/inbox/:shareId          dismiss a playlist a friend sent
 *   DELETE /v1/me                      delete the caller's profile and library
 *   GET    /v1/library/songs?since=t   songs changed after t, and `until` for next time
 *   PUT    /v1/library/songs/:id       save a song (a link and its details)
 *   DELETE /v1/library/songs/:id
 *   GET    /v1/library/state           { rev, data }
 *   PUT    /v1/library/state           { baseRev, data } → 200, or 409 with the current copy
 *   POST   /v1/rooms                   start a Listen Along room → { code }
 *   GET    /v1/rooms/:code             { code, hostName, members }
 *   GET    /v1/rooms/:code/socket      join (WebSocket)
 */

export { ListenAlongRoom };

interface Env extends AuthEnv, LibraryEnv {
  ROOMS: DurableObjectNamespace<ListenAlongRoom>;
  /** Calls per account, and per address (wrangler.jsonc `ratelimits`). Absent in local development. */
  USER_LIMIT?: RateLimit;
  ADDRESS_LIMIT?: RateLimit;
}

async function limit(limiter: RateLimit | undefined, key: string) {
  if (limiter && !(await limiter.limit({ key })).success) throw new HttpError(429, "Too many requests. Wait a minute and try again.");
}

const MAX_BODY_BYTES = 1024 * 1024;
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const CODE = /^[A-HJ-NP-Z2-9]{4}-?[A-HJ-NP-Z2-9]{4}$/;

// Calls carry a token, not cookies, so any origin may call: the app runs from 127.0.0.1 or its own host.
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, PUT, POST, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Authorization, Content-Type",
  "Access-Control-Max-Age": "86400",
};

const reply = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store", ...CORS } });
const ok = (result: unknown) => reply(200, { ok: true, result });
const fail = (status: number, message: string) => reply(status, { ok: false, error: { message } });

async function body(request: Request) {
  const length = Number(request.headers.get("Content-Length") || 0);
  if (length > MAX_BODY_BYTES) throw new HttpError(413, "Request too large.");
  const raw = await request.text();
  if (raw.length > MAX_BODY_BYTES) throw new HttpError(413, "Request too large.");
  try {
    return raw ? (JSON.parse(raw) as unknown) : {};
  } catch {
    throw new HttpError(400, "Send JSON.");
  }
}

const normalizeCode = (code: string) => code.toUpperCase().replace(/-/g, "").replace(/^(.{4})(.{4})$/, "$1-$2");
/**
 * Removes a deleted account from the rooms it was in. Any that fail are kept
 * for the next try (deleting again repeats it), and the deletion reports it.
 */
async function leaveRooms(env: Env, userId: string, codes: string[]) {
  const results = await Promise.allSettled(codes.map((code) => env.ROOMS.get(env.ROOMS.idFromName(code)).removeUser(userId)));
  await leftRooms(env, userId, codes.filter((_code, i) => results[i].status === "fulfilled"));
  if (results.some((r) => r.status === "rejected")) {
    throw new HttpError(503, "Your library was deleted, but you couldn't be removed from a Listen Along room. Try deleting your account again.");
  }
}

/**
 * After starting or joining a room: if the account was deleted meanwhile (after
 * the deletion looked for its rooms), it's removed from this one too. The room
 * is recorded first, so if that fails, deleting the account again retries it.
 */
async function stillHere(env: Env, userId: string, code: string, room: DurableObjectStub<ListenAlongRoom>) {
  try {
    await checkNotDeleted(env, userId);
  } catch (error) {
    await noteLeftRoom(env, userId, code);
    await room.removeUser(userId);
    await leftRooms(env, userId, [code]);
    throw error;
  }
}

function newCode() {
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  const chars = [...bytes].map((b) => CODE_ALPHABET[b % CODE_ALPHABET.length]).join("");
  return `${chars.slice(0, 4)}-${chars.slice(4)}`;
}

/**
 * A shared playlist's link, opened in a browser. Slopify runs on your own
 * computer, so the page hands the link to the desktop app (slopify://p/<id>,
 * which desktop/main.cjs registers) straight away, with a button in case the
 * browser asks first. It shows nothing about the playlist (that needs an account).
 */
function sharePage(shareId: string) {
  const valid = SHARE_ID.test(shareId);
  const app = `slopify://p/${shareId}`;
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>A playlist on Slopify</title><meta name="robots" content="noindex">
<style>body{font:16px/1.5 system-ui,sans-serif;background:#0b0b10;color:#eee;margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;text-align:center}main{max-width:30rem;padding:2rem}h1{font-size:1.5rem;margin:0 0 .5rem}p{color:#b8b8c4}a.btn{display:inline-block;margin:1rem 0;padding:.7rem 1.4rem;border-radius:999px;background:#a78bfa;color:#0b0b10;font-weight:700;text-decoration:none}small{color:#8a8a98}</style></head>
<body><main>${valid
    ? `<h1>Opening the playlist in Slopify…</h1><p>Someone shared a Slopify playlist with you.</p><a class="btn" href="${app}">Open in Slopify</a><p><small>Nothing happened? Open Slopify, sign in, and paste this page's address into the search bar.</small></p><script>location.href=${JSON.stringify(app)}</script>`
    : "<h1>This playlist link doesn't look right</h1><p>Ask for the link again.</p>"}</main></body></html>`;
  return new Response(html, { status: valid ? 200 : 404, headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "public, max-age=300", "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer" } });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
    const parts = url.pathname.split("/").filter(Boolean);
    if (parts[0] === "p" && parts.length === 2 && request.method === "GET") return sharePage(parts[1]);
    if (parts[0] !== "v1") return fail(404, "Not found.");
    try {
      if (parts[1] === "health" && parts.length === 2) return ok({ service: "slopify-cloud" });

      await limit(env.ADDRESS_LIMIT, request.headers.get("CF-Connecting-IP") ?? "unknown");
      const bearer = request.headers.get("Authorization")?.replace(/^Bearer\s+/i, "");
      const { userId } = await verifySession(bearer || url.searchParams.get("token"), env);
      await limit(env.USER_LIMIT, userId);
      const method = request.method;

      if (parts[1] === "me" && parts[2] === "activity" && parts.length === 3 && method === "PUT") return ok(await setActivity(env, userId, await body(request)));
      if (parts[1] === "me" && parts.length === 2) {
        if (method === "GET") return ok(await profileWithCode(env, userId));
        if (method === "PUT") {
          const input = await body(request);
          await saveProfile(env, userId, input);
          // A new profile's first username can come from the sign-in's own (Clerk) username.
          const suggested = input && typeof input === "object" ? (input as Record<string, unknown>).suggestedUsername : null;
          return ok(await profileWithCode(env, userId, typeof suggested === "string" ? suggested : null));
        }
        if (method === "DELETE") {
          const { rooms } = await deleteAccount(env, userId);
          // Their Listen Along rooms: ended where they host, left where they're a guest.
          await leaveRooms(env, userId, rooms);
          return ok({ deleted: true });
        }
      }

      if (parts[1] === "library") {
        if (parts[2] === "songs" && parts.length === 3 && method === "GET") {
          const since = Number(url.searchParams.get("since") || 0);
          return ok(await listSongs(env, userId, Number.isFinite(since) && since > 0 ? since : 0));
        }
        if (parts[2] === "songs" && parts.length === 4) {
          if (method === "PUT") return ok(await putSong(env, userId, parts[3], await body(request)));
          if (method === "DELETE") return ok(await deleteSong(env, userId, parts[3]));
        }
        if (parts[2] === "state" && parts.length === 3) {
          if (method === "GET") return ok(await getState(env, userId));
          if (method === "PUT") {
            const { conflict, ...current } = await putState(env, userId, await body(request));
            return conflict ? reply(409, { ok: false, conflict: true, ...current }) : ok(current);
          }
        }
      }

      if (parts[1] === "social" && parts.length === 2 && method === "GET") return ok(await getSocial(env, userId));
      if (parts[1] === "usernames" && parts.length === 3 && method === "GET") return ok(await usernameAvailable(env, userId, decodeURIComponent(parts[2])));
      if (parts[1] === "friends") {
        const id = parts[3] ? decodeURIComponent(parts[3]) : "";
        if (parts[2] === "requests" && parts.length === 3 && method === "POST") return ok(await requestFriend(env, userId, await body(request)));
        if (parts[2] === "requests" && parts.length === 4 && method === "POST") return ok(await acceptFriend(env, userId, id));
        if (parts[2] === "requests" && parts.length === 4 && method === "DELETE") return ok(await dropRequest(env, userId, id));
        const friendId = parts[2] ? decodeURIComponent(parts[2]) : "";
        if (parts.length === 3 && parts[2] !== "requests" && method === "DELETE") return ok(await unfriend(env, userId, friendId));
        if (parts.length === 4 && parts[3] === "playlists" && method === "GET") return ok(await friendPlaylists(env, userId, friendId));
      }
      if (parts[1] === "shares" && parts.length === 3) {
        const playlistId = decodeURIComponent(parts[2]);
        if (method === "PUT") return ok(await sharePlaylist(env, userId, playlistId, await body(request)));
        if (method === "DELETE") return ok(await unsharePlaylist(env, userId, playlistId));
      }
      if (parts[1] === "shared" && parts[2]) {
        if (!SHARE_ID.test(parts[2])) throw new HttpError(404, "That playlist link doesn't look right.");
        if (parts.length === 3 && method === "GET") return ok(await getShared(env, userId, parts[2]));
        if (parts.length === 4 && parts[3] === "follow" && (method === "PUT" || method === "DELETE")) return ok(await followShared(env, userId, parts[2], method === "PUT"));
        if (parts.length === 4 && parts[3] === "send" && method === "POST") return ok(await sendShared(env, userId, parts[2], await body(request)));
      }
      if (parts[1] === "inbox" && parts.length === 3 && method === "DELETE") return ok(await dismissInbox(env, userId, parts[2]));

      if (parts[1] === "rooms") {
        if (parts.length === 2 && method === "POST") {
          const profile = await getProfile(env, userId);
          if (!profile) throw new HttpError(400, "Choose a display name before starting a room.");
          for (let attempt = 0; attempt < 5; attempt++) {
            const code = newCode();
            const room = env.ROOMS.get(env.ROOMS.idFromName(code));
            if (await room.info()) continue;
            await noteRoom(env, userId, code);
            await room.create({ code, hostId: userId, hostName: profile.displayName, createdAt: Date.now() });
            await stillHere(env, userId, code, room);
            return ok({ code });
          }
          throw new HttpError(503, "Couldn't start a room. Try again.");
        }
        if (parts.length >= 3) {
          if (!CODE.test(parts[2])) throw new HttpError(404, "That room code doesn't look right.");
          const code = normalizeCode(parts[2]);
          const room = env.ROOMS.get(env.ROOMS.idFromName(code));
          if (parts.length === 3 && method === "GET") {
            const info = await room.info();
            return info ? ok(info) : fail(404, "No room with that code. Check it with the host.");
          }
          if (parts.length === 4 && parts[3] === "socket" && method === "GET") {
            if (request.headers.get("Upgrade") !== "websocket") throw new HttpError(426, "Expected a WebSocket.");
            const profile = await getProfile(env, userId);
            if (!profile) throw new HttpError(400, "Choose a display name before joining a room.");
            await noteRoom(env, userId, code);
            // Who this is, as the room sees them; set here, after the token was checked.
            const headers = new Headers(request.headers);
            headers.set("X-Slopify-User", userId);
            headers.set("X-Slopify-Name", profile.displayName);
            if (profile.avatarUrl) headers.set("X-Slopify-Avatar", profile.avatarUrl);
            else headers.delete("X-Slopify-Avatar");
            const joined = await room.fetch(new Request(request.url, { method: "GET", headers }));
            if (joined.status === 101) await stillHere(env, userId, code, room);
            return joined;
          }
        }
      }
      return fail(404, "Not found.");
    } catch (error) {
      if (error instanceof AuthError || error instanceof HttpError) return fail(error.status, error.message);
      console.error(error);
      return fail(500, "Something went wrong on Slopify's server.");
    }
  },

  async scheduled(_controller: ScheduledController, env: Env) {
    await tidy(env);
  },
} satisfies ExportedHandler<Env>;
