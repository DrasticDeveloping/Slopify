import fs from "node:fs/promises";
import path from "node:path";
import { readDurably, writeDurably } from "./durable-file.mjs";

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
    // A damaged file falls back on its backup. Only a missing (or blank: nothing to lose) file is a
    // fresh start, which browsers fill again from their own copies; anything else is never overwritten.
    const found = await readDurably(file, {
      valid: (parsed) => Number.isSafeInteger(parsed?.rev) && typeof parsed.data === "object",
      damaged: () => new Error(`Slopify's library data file is damaged (${file}). Repair or move it, then try again.`),
      blankIsEmpty: true,
    });
    current = found ? { rev: found.value.rev, updatedAt: found.value.updatedAt ?? 0, data: found.value.data } : { rev: 0, updatedAt: 0, data: null };
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
        await writeDurably(file, text, beforeSave);
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
