import { AuthError, verifySession, type AuthEnv } from "./auth";
import { deleteSong, getProfile, getState, HttpError, listSongs, putSong, putState, saveProfile, type LibraryEnv } from "./library";
import { ListenRoom } from "./room";

/*
 * Slopify's online service (Cloudflare Worker): accounts and profiles, each
 * account's library (songs as links, playlists, likes, settings), and Listen
 * Along rooms. Songs' audio stays with each device's own music server; nothing
 * here downloads or plays music. Every route except /v1/health needs a Clerk
 * session token: `Authorization: Bearer <token>`, or `?token=` for WebSockets,
 * which browsers open without headers.
 *
 *   GET    /v1/health
 *   GET    /v1/me                      the caller's profile (null until saved)
 *   PUT    /v1/me                      { displayName, avatarUrl }
 *   GET    /v1/library/songs?since=t   songs changed after t, and `until` for next time
 *   PUT    /v1/library/songs/:id       save a song (a link and its details)
 *   DELETE /v1/library/songs/:id
 *   GET    /v1/library/state           { rev, data }
 *   PUT    /v1/library/state           { baseRev, data } → 200, or 409 with the current copy
 *   POST   /v1/rooms                   start a Listen Along room → { code }
 *   GET    /v1/rooms/:code             { code, hostName, members }
 *   GET    /v1/rooms/:code/socket      join (WebSocket)
 */

export { ListenRoom };

interface Env extends AuthEnv, LibraryEnv {
  ROOMS: DurableObjectNamespace<ListenRoom>;
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
function newCode() {
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  const chars = [...bytes].map((b) => CODE_ALPHABET[b % CODE_ALPHABET.length]).join("");
  return `${chars.slice(0, 4)}-${chars.slice(4)}`;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
    const parts = url.pathname.split("/").filter(Boolean);
    if (parts[0] !== "v1") return fail(404, "Not found.");
    try {
      if (parts[1] === "health" && parts.length === 2) return ok({ service: "slopify-cloud" });

      const bearer = request.headers.get("Authorization")?.replace(/^Bearer\s+/i, "");
      const { userId } = await verifySession(bearer || url.searchParams.get("token"), env);
      const method = request.method;

      if (parts[1] === "me" && parts.length === 2) {
        if (method === "GET") return ok(await getProfile(env, userId));
        if (method === "PUT") return ok(await saveProfile(env, userId, await body(request)));
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

      if (parts[1] === "rooms") {
        if (parts.length === 2 && method === "POST") {
          const profile = await getProfile(env, userId);
          if (!profile) throw new HttpError(400, "Choose a display name before starting a room.");
          for (let attempt = 0; attempt < 5; attempt++) {
            const code = newCode();
            const room = env.ROOMS.get(env.ROOMS.idFromName(code));
            if (await room.info()) continue;
            await room.create({ code, hostId: userId, hostName: profile.displayName, createdAt: Date.now() });
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
            // Who this is, as the room sees them; set here, after the token was checked.
            const headers = new Headers(request.headers);
            headers.set("X-Slopify-User", userId);
            headers.set("X-Slopify-Name", profile.displayName);
            if (profile.avatarUrl) headers.set("X-Slopify-Avatar", profile.avatarUrl);
            else headers.delete("X-Slopify-Avatar");
            return room.fetch(new Request(request.url, { method: "GET", headers }));
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
} satisfies ExportedHandler<Env>;
