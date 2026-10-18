import fs from "node:fs/promises";
import path from "node:path";

/*
 * The listener's library data on the music server: playlists, likes, listening
 * history and settings, shared by every browser that uses this server.
 * Songs themselves are in songs.mjs.
 */

const MAX_STATE_BYTES = 8 * 1024 * 1024;

const tooLarge = (message) => Object.assign(new Error(message), { status: 413 });

/**
 * The listener's library data as one versioned document. A write names the
 * revision it was based on; if another browser wrote in between, it is refused
 * with the current document, so the writer can merge and try again.
 */
export function createStateStore(dataDir, beforeSave = () => {}) {
  const file = path.join(dataDir, "library-state.json");
  let current = null;
  let writing = Promise.resolve();

  async function read() {
    if (current) return current;
    try {
      const parsed = JSON.parse(await fs.readFile(file, "utf8"));
      if (!Number.isSafeInteger(parsed?.rev) || typeof parsed.data !== "object") throw new Error("damaged");
      current = { rev: parsed.rev, updatedAt: parsed.updatedAt ?? 0, data: parsed.data };
    } catch (error) {
      // Only a missing file is a fresh start; anything else must not be overwritten.
      if (error?.code !== "ENOENT") throw new Error(`Slopify's library data file is damaged (${file}). Repair or move it, then try again.`);
      current = { rev: 0, updatedAt: 0, data: null };
    }
    return current;
  }

  return {
    get: read,
    /** Saves `data` if `baseRev` is still the current revision; otherwise returns the current document as a conflict. */
    async put(baseRev, data) {
      const next = writing.catch(() => undefined).then(async () => {
        const doc = await read();
        if (baseRev !== doc.rev) return { conflict: true, doc };
        const saved = { rev: doc.rev + 1, updatedAt: Date.now(), data };
        const text = JSON.stringify(saved);
        if (text.length > MAX_STATE_BYTES) throw tooLarge("Library data is too large to sync.");
        await fs.mkdir(dataDir, { recursive: true });
        const temp = `${file}.${process.pid}.tmp`;
        await fs.writeFile(temp, text);
        beforeSave();
        await fs.rename(temp, file);
        current = saved;
        return { conflict: false, doc: saved };
      });
      writing = next;
      return next;
    },
  };
}

/** Reads a JSON body of up to `max` bytes. */
export async function readLargeJSON(req, max = MAX_STATE_BYTES) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > max) throw tooLarge("Request body too large.");
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw Object.assign(new Error("Request body is not valid JSON."), { status: 400 });
  }
}
