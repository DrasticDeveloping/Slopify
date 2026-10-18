import { DurableObject } from "cloudflare:workers";

/*
 * One Listen Along room: a host whose playback everyone in the room follows.
 * Everyone keeps a WebSocket open to the room. The host sends what's playing
 * (the song's link and details, the position, speed and whether it's paused); the room
 * stamps it with the time and passes it to every guest, who plays that song from
 * its link on their own device and seeks to match. Uses WebSocket hibernation,
 * so an idle room costs nothing between messages.
 *
 * Messages (JSON), client → room:
 *   { type: "state", song, position, playing, rate }   host only
 *   { type: "ping", at }                          anyone; answered with pong (clock sync)
 *   { type: "end" }                               host only: closes the room
 * room → client:
 *   { type: "welcome", you, room, state, members, now }
 *   { type: "state", state, now }
 *   { type: "members", members }
 *   { type: "pong", at, now }
 *   { type: "ended", reason }
 *   { type: "error", message }
 */

export interface Member { userId: string; name: string; avatarUrl: string | null; host: boolean }
export interface PlaybackSong {
  title: string;
  artist: string;
  sourceURL: string;
  savedAs: "audio" | "video";
  durationSeconds: number | null;
  artworkUrl: string | null;
  songId: string | null;
}
export interface Playback { song: PlaybackSong | null; position: number; playing: boolean; rate: number; at: number }
interface Room { code: string; hostId: string; hostName: string; createdAt: number }

const MAX_MEMBERS = 20;
const MAX_MESSAGE_BYTES = 8 * 1024;
/** How long a room waits for its host to come back (a reload, a dropped connection). */
const HOST_GRACE_MS = 60_000;
/** An empty room is removed after this. */
const EMPTY_TTL_MS = 5 * 60_000;
/**
 * The longest a room lasts, even with its host there. The service's record of
 * who was in which room (to remove a deleted account) is kept longer than this.
 */
const MAX_ROOM_MS = 24 * 60 * 60_000;

const text = (v: unknown, max: number) => (typeof v === "string" && v.trim() ? v.trim().slice(0, max) : null);
const https = (v: unknown) => {
  if (typeof v !== "string" || v.length > 2048) return null;
  try {
    return new URL(v).protocol === "https:" ? v : null;
  } catch {
    return null;
  }
};

function checkSong(value: unknown): PlaybackSong | null {
  if (!value || typeof value !== "object") return null;
  const s = value as Record<string, unknown>;
  const title = text(s.title, 300);
  const sourceURL = https(s.sourceURL);
  if (!title || !sourceURL) return null;
  return {
    title,
    artist: text(s.artist, 300) ?? "Unknown artist",
    sourceURL,
    savedAs: s.savedAs === "video" ? "video" : "audio",
    durationSeconds: typeof s.durationSeconds === "number" && s.durationSeconds > 0 && s.durationSeconds < 86_400 ? s.durationSeconds : null,
    artworkUrl: https(s.artworkUrl),
    songId: text(s.songId, 80),
  };
}

/*
 * Called ListenRoom before rooms had a longest lifetime and a record of who was in
 * them. Rooms of that class were removed when this one replaced it (wrangler.jsonc
 * migration v2), so every room left follows the rules here.
 */
export class ListenAlongRoom extends DurableObject {
  /** Called by the Worker once, when the room is made. */
  async create(room: Room) {
    await this.ctx.storage.put("room", room);
    await this.ctx.storage.put("playback", { song: null, position: 0, playing: false, rate: 1, at: Date.now() } satisfies Playback);
    await this.ctx.storage.setAlarm(Date.now() + EMPTY_TTL_MS);
  }

  /** Sets the room's alarm for `at`, or for when the room has lasted its longest if that's sooner. */
  private async wake(room: Room, at: number) {
    await this.ctx.storage.setAlarm(Math.min(at, room.createdAt + MAX_ROOM_MS));
  }

  /** Removes an account that was deleted: the room ends if it's the host's, otherwise just they leave. */
  async removeUser(userId: string) {
    const room = await this.ctx.storage.get<Room>("room");
    if (!room) return;
    if (room.hostId === userId) return this.end("The host's account was deleted.");
    for (const ws of this.ctx.getWebSockets(userId)) {
      ws.close(4002, "Account deleted.");
      await this.left(ws);
    }
  }

  /** The room's summary, or null when there's no such room. */
  async info() {
    const room = await this.ctx.storage.get<Room>("room");
    if (!room) return null;
    return { code: room.code, hostName: room.hostName, members: this.members() };
  }

  async fetch(request: Request) {
    const room = await this.ctx.storage.get<Room>("room");
    if (!room) return new Response("No such room.", { status: 404 });
    if (request.headers.get("Upgrade") !== "websocket") return new Response("Expected a WebSocket.", { status: 426 });
    const userId = request.headers.get("X-Slopify-User")!;
    const member: Member = {
      userId,
      name: request.headers.get("X-Slopify-Name") || "Listener",
      avatarUrl: request.headers.get("X-Slopify-Avatar") || null,
      host: userId === room.hostId,
    };
    // The same account joining again (a reload, a second device) replaces its old connection.
    for (const ws of this.ctx.getWebSockets(userId)) ws.close(4000, "Joined from somewhere else.");
    if (!member.host && this.members().filter((m) => m.userId !== userId).length >= MAX_MEMBERS) return new Response("This room is full.", { status: 409 });

    const pair = new WebSocketPair();
    this.ctx.acceptWebSocket(pair[1], [userId]);
    pair[1].serializeAttachment(member);
    const playback = await this.ctx.storage.get<Playback>("playback");
    this.send(pair[1], { type: "welcome", you: member, room: { code: room.code, hostName: room.hostName }, state: playback, members: this.members(), now: Date.now() });
    this.broadcast({ type: "members", members: this.members() });
    // The host being here cancels any pending end. A guest joining doesn't: a room
    // whose host has gone still ends when the host's minute is up.
    if (member.host) await this.wake(room, Infinity);
    else if (!this.members().some((m) => m.host)) {
      const deadline = Date.now() + HOST_GRACE_MS;
      const pending = await this.ctx.storage.getAlarm();
      // Shorten the initial empty-room timer, while preserving an earlier host
      // deadline so more guests cannot keep extending an abandoned room.
      if (pending === null || pending > deadline) await this.wake(room, deadline);
    }
    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  async webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer) {
    const member = ws.deserializeAttachment() as Member;
    if (typeof raw !== "string" || raw.length > MAX_MESSAGE_BYTES) return this.send(ws, { type: "error", message: "Message too large." });
    let message: Record<string, unknown>;
    try {
      message = JSON.parse(raw);
    } catch {
      return this.send(ws, { type: "error", message: "Invalid message." });
    }
    if (!message || typeof message !== "object" || Array.isArray(message)) return this.send(ws, { type: "error", message: "Invalid message." });
    if (message.type === "ping") return this.send(ws, { type: "pong", at: message.at, now: Date.now() });
    if (!member.host) return this.send(ws, { type: "error", message: "Only the host controls playback." });
    if (message.type === "end") return this.end("The host ended the room.");
    if (message.type === "state") {
      const position = typeof message.position === "number" && message.position >= 0 && message.position < 86_400 ? message.position : 0;
      const rate = typeof message.rate === "number" && message.rate >= 0.25 && message.rate <= 4 ? message.rate : 1;
      const playback: Playback = { song: checkSong(message.song), position, playing: Boolean(message.playing), rate, at: Date.now() };
      await this.ctx.storage.put("playback", playback);
      this.broadcast({ type: "state", state: playback, now: Date.now() }, ws);
    }
  }

  async webSocketClose(ws: WebSocket) {
    await this.left(ws);
  }

  async webSocketError(ws: WebSocket) {
    await this.left(ws);
  }

  private async left(ws: WebSocket) {
    const room = await this.ctx.storage.get<Room>("room");
    if (!room) return;
    const member = ws.deserializeAttachment() as Member | null;
    const remaining = this.ctx.getWebSockets().filter((other) => other !== ws);
    this.broadcast({ type: "members", members: this.members(ws) }, ws);
    // The host left: give them a minute to come back. Nobody left: tidy up later.
    if (member?.host && !remaining.some((other) => (other.deserializeAttachment() as Member).host)) await this.wake(room, Date.now() + HOST_GRACE_MS);
    else if (!remaining.length) await this.wake(room, Date.now() + EMPTY_TTL_MS);
  }

  async alarm() {
    const room = await this.ctx.storage.get<Room>("room");
    if (!room) return;
    if (Date.now() >= room.createdAt + MAX_ROOM_MS) return this.end("Rooms last up to a day. Start a new one to keep listening.");
    const sockets = this.ctx.getWebSockets();
    if (sockets.some((ws) => (ws.deserializeAttachment() as Member).host)) return this.wake(room, Infinity);
    await this.end(sockets.length ? "The host left." : "The room was empty.");
  }

  private async end(reason: string) {
    this.broadcast({ type: "ended", reason });
    for (const ws of this.ctx.getWebSockets()) ws.close(4001, reason.slice(0, 100));
    await this.ctx.storage.deleteAll();
  }

  private members(excluding?: WebSocket): Member[] {
    const seen = new Map<string, Member>();
    for (const ws of this.ctx.getWebSockets()) {
      if (ws === excluding) continue;
      const member = ws.deserializeAttachment() as Member;
      seen.set(member.userId, member);
    }
    return [...seen.values()].sort((a, b) => Number(b.host) - Number(a.host) || a.name.localeCompare(b.name));
  }

  private send(ws: WebSocket, message: unknown) {
    try {
      ws.send(JSON.stringify(message));
    } catch {
      // Already closing.
    }
  }

  private broadcast(message: unknown, except?: WebSocket) {
    const text = JSON.stringify(message);
    for (const ws of this.ctx.getWebSockets()) {
      if (ws === except) continue;
      try {
        ws.send(text);
      } catch {
        // Closing; webSocketClose will update the others.
      }
    }
  }
}
