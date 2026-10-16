import { engine } from "../audio/engine";
import { thisDevice } from "../lib/native";
import { ownedIndex } from "../recommend/owned";
import { followHost, toast } from "./actions";
import { cloudCall, CloudError, getAccount, roomSocketUrl } from "./cloud";
import { registerStreams, streamLink, streamTrackId } from "./importer";
import { getState, setState, subscribe, type RoomMember } from "./store";

/*
 * Listen Along: rooms on Slopify's online service (cloud/src/room.ts). The host's
 * player says what it's playing (the song's link and details, where it is, and
 * whether it's paused); everyone else's player follows, playing the same song
 * from its link on their own device (or from their library, if they have it).
 * Each guest's volume stays their own. Needs a Slopify account.
 */

interface PlaybackSong { title: string; artist: string; sourceURL: string; savedAs: "audio" | "video"; durationSeconds: number | null; artworkUrl: string | null; songId: string | null }
/** `rate` is missing from rooms on an older online service: normal speed. */
interface Playback { song: PlaybackSong | null; position: number; playing: boolean; rate?: number; at: number }

const PING_EVERY = 15_000;
const FOLLOW_EVERY = 3_000;
const HOST_CHECK_EVERY = 4_000;
const RECONNECTS = 5;

let socket: WebSocket | null = null;
let code = "";
let leaving = false;
let reconnects = 0;
let timers: number[] = [];
let retryTimer = 0;
/** Stops the host's publishing (see startHosting). */
let stopHosting: (() => void) | null = null;
/** Server clock minus this clock, from ping round trips. */
let offset = 0;
let playback: Playback | null = null;
let toldNoLink = "";
let toldHostOnly = false;
const resolved = new Map<string, string>();

const setListen = (patch: Partial<ReturnType<typeof getState>["listen"]>) => setState((s) => ({ listen: { ...s.listen, ...patch } }));
const send = (message: unknown) => {
  if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
};
const reason = (error: unknown) => (error instanceof Error ? error.message : "Couldn't reach Slopify's online service.");

function needAccount() {
  const account = getAccount();
  if (account.status === "signedIn") return false;
  toast(account.status === "disabled" ? "Listen Along isn't set up in this copy of Slopify" : "Sign in to use Listen Along", {
    detail: account.status === "disabled" ? "It needs Slopify's online service." : "Rooms are linked to your Slopify account.",
  });
  return true;
}

/* ───────────────────────── rooms ───────────────────────── */

export async function startRoom() {
  if (needAccount() || getState().listen.mode !== "idle") return;
  setListen({ mode: "connecting", code: "", members: [] });
  try {
    const { code: made } = await cloudCall<{ code: string }>("/v1/rooms", { method: "POST" });
    await connect(made);
  } catch (error) {
    reset();
    toast("Couldn't start a room", { tone: "error", detail: reason(error) });
  }
}

export async function joinRoom(roomCode: string) {
  if (needAccount() || getState().listen.mode !== "idle") return;
  const wanted = roomCode.trim().toUpperCase().replace(/^(\w{4})-?(\w{4})$/, "$1-$2");
  setListen({ mode: "connecting", code: wanted, members: [] });
  try {
    await cloudCall(`/v1/rooms/${encodeURIComponent(wanted)}`);
    await connect(wanted);
  } catch (error) {
    reset();
    toast("Couldn't join that room", { tone: "error", detail: error instanceof CloudError && error.status === 404 ? "No room has that code. Check it with the host." : reason(error) });
  }
}

/** Leaves the room; the host's leaving ends it for everyone. */
export function leaveRoom() {
  const was = getState().listen.mode;
  if (was === "idle") return;
  leaving = true;
  if (was === "host") send({ type: "end" });
  socket?.close(1000, "Left");
  reset();
  toast(was === "host" ? "Room closed" : "Left the room");
}

function reset() {
  timers.forEach(clearInterval);
  timers = [];
  clearTimeout(retryTimer);
  reconnects = 0;
  stopHosting?.();
  stopHosting = null;
  socket = null;
  code = "";
  playback = null;
  toldNoLink = "";
  toldHostOnly = false;
  setState({ listen: { mode: "idle", code: "", members: [] } });
}

async function connect(roomCode: string) {
  code = roomCode;
  leaving = false;
  const ws = new WebSocket(await roomSocketUrl(roomCode));
  socket = ws;
  await new Promise<void>((resolve, reject) => {
    ws.addEventListener("open", () => resolve(), { once: true });
    ws.addEventListener("error", () => reject(new Error("Couldn't connect to the room.")), { once: true });
  });
  ws.addEventListener("message", (event) => {
    if (socket !== ws) return;
    try {
      received(JSON.parse(String(event.data)));
    } catch {
      // Not ours; ignore.
    }
  });
  ws.addEventListener("close", (event) => {
    if (socket !== ws || leaving) return;
    // 4000: this account joined from somewhere else; 4001: the room ended (already announced).
    if (event.code === 4000 || event.code === 4001 || reconnects >= RECONNECTS) {
      if (event.code === 4000) toast("You joined this room from somewhere else", { detail: "This device left the room." });
      else if (event.code !== 4001) toast("Lost the connection to the room", { tone: "error" });
      reset();
      return;
    }
    reconnect();
  });
}

/** Tries the room again after a growing wait, including when a reconnect itself fails to open. */
function reconnect() {
  if (reconnects >= RECONNECTS) {
    toast("Lost the connection to the room", { tone: "error" });
    reset();
    return;
  }
  reconnects++;
  setListen({ mode: "connecting" });
  const room = code;
  clearTimeout(retryTimer);
  retryTimer = window.setTimeout(() => {
    if (leaving || code !== room) return;
    void connect(room).catch(() => {
      if (!leaving && code === room) reconnect();
    });
  }, 1000 * 2 ** reconnects);
}

function received(message: Record<string, unknown>) {
  switch (message.type) {
    case "welcome": {
      reconnects = 0;
      const you = message.you as RoomMember;
      const members = message.members as RoomMember[];
      const room = message.room as { code: string; hostName: string };
      setState({ listen: { mode: you.host ? "host" : "guest", code: room.code, members, host: room.hostName } });
      offset = Number(message.now) - Date.now();
      timers.forEach(clearInterval);
      timers = [window.setInterval(() => send({ type: "ping", at: Date.now() }), PING_EVERY)];
      send({ type: "ping", at: Date.now() });
      if (you.host) startHosting();
      else {
        toast(`Joined ${room.hostName}'s room`, { tone: "success", detail: `${room.hostName} controls playback. Your volume is yours.` });
        playback = message.state as Playback;
        follow();
        timers.push(window.setInterval(follow, FOLLOW_EVERY));
      }
      break;
    }
    case "members": {
      const before = new Set(getState().listen.members.map((m) => m.userId));
      const members = message.members as RoomMember[];
      setListen({ members });
      if (getState().listen.mode === "host") for (const m of members) if (!before.has(m.userId) && !m.host) toast(`${m.name} joined your room`);
      break;
    }
    case "state":
      playback = message.state as Playback;
      follow();
      break;
    case "pong": {
      const sent = Number(message.at);
      const rtt = Date.now() - sent;
      if (rtt >= 0 && rtt < 10_000) offset = Number(message.now) - (sent + rtt / 2);
      break;
    }
    case "ended":
      leaving = true;
      toast("The room has ended", { detail: String(message.reason ?? "") });
      reset();
      break;
    case "error":
      toast("Listen Along", { tone: "error", detail: String(message.message ?? "") });
      break;
  }
}

/* ───────────────────────── guest: following the host ───────────────────────── */

/** The song here: your own copy if you have it, otherwise streamed in full from the host's link. */
function trackFor(song: PlaybackSong) {
  const known = resolved.get(song.sourceURL);
  if (known && getState().tracks[known]) return known;
  const s = getState();
  const mine = ownedIndex(s).find({ artist: song.artist, title: song.title, sources: [song.sourceURL] })[0];
  if (mine) {
    resolved.set(song.sourceURL, mine);
    return mine;
  }
  // A host's video plays as a video here too.
  const video = song.savedAs === "video" && !/soundcloud\.com/i.test(song.sourceURL);
  const key = `room:${video ? "video:" : ""}${song.sourceURL}`;
  registerStreams([{
    video,
    key,
    candidate: {
      sourceURL: song.sourceURL,
      sourceProvider: /soundcloud\.com/i.test(song.sourceURL) ? "soundcloud" : "youtube",
      title: song.title,
      artist: song.artist,
      durationSeconds: song.durationSeconds,
      thumbnailURL: song.artworkUrl,
      importMetadata: { title: song.title, artist: song.artist, durationSeconds: song.durationSeconds ?? undefined, artworkURL: song.artworkUrl ?? undefined },
    },
    title: song.title,
    artist: song.artist,
    artwork: song.artworkUrl ?? undefined,
    kind: "discover-search",
  }]);
  const id = streamTrackId(key);
  resolved.set(song.sourceURL, id);
  return id;
}

function follow() {
  const s = getState();
  if (s.listen.mode !== "guest" || !playback) return;
  const label = `${s.listen.host ?? "The host"}'s room`;
  if (!playback.song) {
    followHost(null, 0, false, label);
    // Say why once each time it happens, not on every check.
    if (playback.playing && !toldHostOnly) toast(`${s.listen.host ?? "The host"} is playing a song only they have`, { detail: "It's a file on their computer. You'll hear the next song saved from the web." });
    toldHostOnly = playback.playing;
    return;
  }
  toldHostOnly = false;
  const rate = playback.rate ?? 1;
  const elapsed = playback.playing ? ((Date.now() + offset - playback.at) / 1000) * rate : 0;
  followHost(trackFor(playback.song), playback.position + Math.max(0, elapsed), playback.playing, label, rate);
}

/* ───────────────────────── host: telling the room ───────────────────────── */

function current(): PlaybackSong | null {
  const s = getState();
  const t = s.currentId ? s.tracks[s.currentId] : null;
  if (!t) return null;
  const link = t.stream ? streamLink(t.id) : t.playableUrl ?? t.sourceUrl;
  const album = s.albums[t.albumId];
  if (!link?.startsWith("https://")) {
    // A file only this computer has: guests can't play it.
    if (toldNoLink !== t.id) {
      toldNoLink = t.id;
      toast("Your room can't hear this song", { detail: `It's a file on ${thisDevice}. Songs saved from the web play for everyone.` });
    }
    return null;
  }
  return {
    title: t.title,
    artist: s.artists[t.artistId]?.name ?? "Unknown artist",
    sourceURL: link,
    savedAs: t.kind === "video" ? "video" : "audio",
    durationSeconds: t.duration || null,
    artworkUrl: album?.artworkUrl?.startsWith("https://") ? album.artworkUrl : null,
    songId: t.serverId ?? null,
  };
}

function startHosting() {
  let sent = "";
  let sentAt = 0;
  let sentPosition = 0;
  const publish = (force = false) => {
    const s = getState();
    if (s.listen.mode !== "host") return;
    const song = current();
    const key = JSON.stringify([song?.sourceURL ?? null, s.isPlaying, s.speed]);
    const expected = sentPosition + (s.isPlaying ? ((Date.now() - sentAt) / 1000) * s.speed : 0);
    const jumped = Math.abs(engine.position - expected) > 2;
    if (!force && key === sent && !jumped) return;
    sent = key;
    sentAt = Date.now();
    sentPosition = engine.position;
    // Guests pause when song is null; preserve the host's actual playing state
    // so they can explain why this file cannot be heard.
    send({ type: "state", song, position: engine.position, playing: s.isPlaying, rate: s.speed });
  };
  stopHosting?.();
  stopHosting = subscribe(() => publish());
  // Catches seeks (which don't change the app's state), and refreshes late joiners' timing.
  const check = window.setInterval(() => publish(), HOST_CHECK_EVERY);
  const refresh = window.setInterval(() => publish(true), 30_000);
  timers.push(check, refresh);
  publish(true);
}
