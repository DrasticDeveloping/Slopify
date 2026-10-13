const net = require("node:net");
const path = require("node:path");
const { randomUUID } = require("node:crypto");

/*
 * "Listening to Slopify" on your Discord profile, through the Discord app's local
 * connection (its RPC pipe): nothing goes over the internet from here. It needs a
 * Discord application id (release.config.json → discordClientId); the
 * application's name is what Discord shows. If Discord isn't running, it tries
 * again every 20 seconds.
 */

const OP = { HANDSHAKE: 0, FRAME: 1, CLOSE: 2, PING: 3, PONG: 4 };
const RETRY = 20_000;

function pipePath(n) {
  // Test override: one fixed pipe (a stand-in for Discord), never the real app's.
  if (process.env.SLOPIFY_DISCORD_IPC_PATH) return process.env.SLOPIFY_DISCORD_IPC_PATH;
  if (process.platform === "win32") return `\\\\?\\pipe\\discord-ipc-${n}`;
  const dir = process.env.XDG_RUNTIME_DIR || process.env.TMPDIR || process.env.TMP || process.env.TEMP || "/tmp";
  return path.join(dir.replace(/\/$/, ""), `discord-ipc-${n}`);
}

function encode(op, data) {
  const json = Buffer.from(JSON.stringify(data));
  const header = Buffer.alloc(8);
  header.writeInt32LE(op, 0);
  header.writeInt32LE(json.length, 4);
  return Buffer.concat([header, json]);
}

function connectTo(n) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(pipePath(n));
    socket.once("connect", () => { socket.off("error", reject); resolve(socket); });
    socket.once("error", reject);
  });
}

function createDiscordPresence(clientId, log = () => {}) {
  let socket = null;
  let ready = false;
  let enabled = false;
  let activity = null;
  let retry = null;
  let buffer = Buffer.alloc(0);

  function send(op, data) {
    if (socket && !socket.destroyed) socket.write(encode(op, data));
  }

  function publish() {
    if (!ready) return;
    send(OP.FRAME, { cmd: "SET_ACTIVITY", args: { pid: process.pid, activity: enabled ? activity : null }, nonce: randomUUID() });
  }

  function onData(chunk) {
    buffer = Buffer.concat([buffer, chunk]);
    while (buffer.length >= 8) {
      const op = buffer.readInt32LE(0);
      const length = buffer.readInt32LE(4);
      if (buffer.length < 8 + length) return;
      let message = null;
      try { message = JSON.parse(buffer.subarray(8, 8 + length).toString("utf8")); } catch { /* Ignore a malformed frame. */ }
      buffer = buffer.subarray(8 + length);
      if (op === OP.PING) send(OP.PONG, message);
      else if (op === OP.CLOSE) { log(`[discord] closed: ${message?.message ?? ""}\n`); socket?.destroy(); }
      else if (message?.evt === "READY") { ready = true; publish(); }
      else if (message?.evt === "ERROR") log(`[discord] ${message.data?.message ?? "error"}\n`);
    }
  }

  let connecting = false;

  async function connect() {
    retry = null;
    // One connection at a time: settings can switch this on several times in a row.
    if (!enabled || socket || connecting) return;
    connecting = true;
    let found = null;
    try {
      for (let n = 0; n < (process.env.SLOPIFY_DISCORD_IPC_PATH ? 1 : 10); n++) {
        try {
          found = await connectTo(n);
          break;
        } catch { /* Not this pipe. */ }
      }
    } finally {
      connecting = false;
    }
    if (!found) return schedule();
    // Switched off (or closed) while connecting.
    if (!enabled) return void found.destroy();
    socket = found;
    buffer = Buffer.alloc(0);
    socket.on("data", onData);
    socket.on("error", () => {});
    socket.on("close", () => {
      socket = null;
      ready = false;
      schedule();
    });
    send(OP.HANDSHAKE, { v: 1, client_id: clientId });
  }

  function schedule() {
    if (enabled && !retry) retry = setTimeout(() => void connect(), RETRY);
    retry?.unref?.();
  }

  return {
    setEnabled(on) {
      enabled = Boolean(on);
      if (enabled) void connect();
      else {
        publish();
        clearTimeout(retry);
        retry = null;
        // Let the cleared activity reach Discord before hanging up.
        setTimeout(() => { if (!enabled) socket?.end(); }, 500);
      }
    },
    /** What's playing, from the web app, or null when nothing is. */
    setNowPlaying(now) {
      activity = now && now.playing ? toActivity(now) : null;
      publish();
    },
    close() {
      enabled = false;
      clearTimeout(retry);
      socket?.destroy();
    },
  };
}

const text = (v, max = 128) => {
  const s = typeof v === "string" ? v.trim() : "";
  // Discord needs at least two characters in each field.
  return s.length >= 2 ? s.slice(0, max) : s ? `${s} ` : undefined;
};

function toActivity(now) {
  const start = Date.now() - Math.max(0, now.position || 0) * 1000;
  const artwork = typeof now.artwork === "string" && now.artwork.startsWith("https://") && now.artwork.length <= 256 ? now.artwork : undefined;
  return {
    type: 2, // "Listening to"
    details: text(now.title),
    state: text(now.artist ? `by ${now.artist}` : undefined),
    timestamps: now.duration > 0 ? { start, end: start + now.duration * 1000 } : { start },
    assets: {
      ...(artwork ? { large_image: artwork } : {}),
      large_text: text(now.album),
    },
    instance: false,
  };
}

module.exports = { createDiscordPresence };
