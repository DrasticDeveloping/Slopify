import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

/*
 * One running Slopify per library. Two servers on one library folder would
 * each keep their own copy in memory and overwrite each other's saves, so the
 * second one refuses to start.
 *
 * The lock is a small file in the library folder, created only if it doesn't
 * exist yet (so of two servers starting at once, exactly one gets it), that
 * its server touches every few seconds. A lock that hasn't been touched for a
 * while, or whose process is gone, is left over from a server that didn't stop
 * cleanly (a crash, a power cut) and is taken over: by one server at a time,
 * holding a second, short-lived lock while it does. (A process id alone isn't
 * enough: Windows reuses them quickly.) Each lock carries a token, so a server
 * only ever touches or removes its own.
 *
 * A server whose lock was taken over (it was frozen or suspended long enough to
 * look crashed) mustn't save anything more: it refuses changes from then on
 * (`owned`, checked before each one) and stops.
 */
const LOCK = ".slopify-lock";
const TOUCH_EVERY = 5_000;
const STALE_AFTER = 20_000;
/** A takeover takes milliseconds; one older than this was interrupted. */
const TAKEOVER_STALE_AFTER = 10_000;

export class LibraryInUseError extends Error {}

const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/** Creates `file` with `content` only if it doesn't exist. */
function create(file, content) {
  try {
    const fd = fs.openSync(file, "wx");
    try {
      fs.writeSync(fd, content);
    } finally {
      fs.closeSync(fd);
    }
    return true;
  } catch (error) {
    if (error?.code === "EEXIST") return false;
    throw error;
  }
}

/** Who holds the lock, or null when it's free to take over. */
function holder(file) {
  let stat;
  try {
    stat = fs.statSync(file);
  } catch {
    return null;
  }
  let held = null;
  try {
    held = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    // Being written right now, or damaged: only its age tells.
  }
  const fresh = Date.now() - stat.mtimeMs < STALE_AFTER;
  if (!fresh) return null;
  if (held && Number.isInteger(held.pid) && !alive(held.pid)) return null;
  return held ?? {};
}

const inUse = (held) => {
  const where = held.port ? ` on port ${held.port}` : "";
  const who = held.pid ? ` (process ${held.pid})` : "";
  return new LibraryInUseError(`Another Slopify is already using this library${where}${who}. Close it first, or run this one with its own library (--isolated or --data).`);
};

/**
 * Takes the library folder for this process, or throws LibraryInUseError naming
 * whoever has it. Returns `owned()`: whether this process still has it.
 */
export function lockLibrary(dataDir, { port, onLost = () => process.exit(1) } = {}) {
  fs.mkdirSync(dataDir, { recursive: true });
  const file = path.join(dataDir, LOCK);
  const takeover = `${file}.takeover`;
  const token = randomUUID();
  const mine = JSON.stringify({ pid: process.pid, port: port ?? null, token, at: Date.now() });

  for (let attempt = 0; ; attempt++) {
    if (create(file, mine)) break;
    const held = holder(file);
    if (held) throw inUse(held);
    // Left over: one server at a time removes it, then everyone races to create it again.
    let mkdirFailed = false;
    try {
      fs.mkdirSync(takeover);
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      mkdirFailed = true;
    }
    if (mkdirFailed) {
      try {
        if (Date.now() - fs.statSync(takeover).mtimeMs > TAKEOVER_STALE_AFTER) fs.rmSync(takeover, { recursive: true, force: true });
      } catch { /* Finished meanwhile. */ }
    } else {
      try {
        // Checked again: another server may have finished its own takeover just before.
        if (!holder(file)) fs.rmSync(file, { force: true });
      } finally {
        fs.rmSync(takeover, { recursive: true, force: true });
      }
    }
    if (attempt >= 50) throw inUse({});
    sleep(20 + Math.floor(Math.random() * 30));
  }

  let lost = false;
  const ours = () => {
    try {
      return JSON.parse(fs.readFileSync(file, "utf8"))?.token === token;
    } catch {
      return false;
    }
  };
  const giveUp = () => {
    if (lost) return;
    lost = true;
    clearInterval(touch);
    console.error("[slopify] Another Slopify took over this library (this one stopped responding for a while). This one is stopping; restart it to use the library again.");
    onLost();
  };
  const touch = setInterval(() => {
    if (ours()) {
      const now = new Date();
      try { fs.utimesSync(file, now, now); } catch { /* Gone this instant; next time recreates it. */ }
    } else if (!fs.existsSync(file) && (() => { try { return create(file, mine); } catch { return true; /* The folder is gone; nothing to protect. */ } })()) {
      // Deleted from under us: recreated, unless someone else has the library now.
    } else {
      giveUp();
    }
  }, TOUCH_EVERY);
  touch.unref();
  process.once("exit", () => {
    clearInterval(touch);
    try {
      if (!lost && ours()) fs.unlinkSync(file);
    } catch { /* Already gone. */ }
  });
  return function owned() {
    if (!lost && !ours()) giveUp();
    return !lost;
  };
}

function alive(pid) {
  if (pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: it exists but belongs to someone else.
    return error?.code === "EPERM";
  }
}
