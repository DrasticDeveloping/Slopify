import fs from "node:fs/promises";
import path from "node:path";
import { runFolder, sweepOldTemp, sweepRunFolders } from "./run-folders.mjs";

/*
 * Temporary song files. The server keeps songs as links; when a device needs
 * the audio (to keep its own copy, or to play a song it has no copy of) the
 * file is prepared from the source into a temporary folder, served, and evicted
 * soon after. Requests for the same song share one preparation.
 */

const MAX_FILES = 6;
const MAX_BYTES = 2 * 1024 ** 3;
const KEEP_FOR = 30 * 60_000;
/** A preparation outlives any one request (another may be waiting on it), so it has its own deadline. */
const PREPARE_TIMEOUT = 5 * 60_000;

export class SongFiles {
  /**
   * `prepare(song, dir, signal)` downloads the song into `dir` and returns `{ filePath, size, sha256 }`.
   * Files are kept in the library's data folder, in this server's own folder (see run-folders.mjs).
   */
  constructor(prepare, dataDir) {
    this.prepare = prepare;
    this.items = new Map();
    this.pending = new Map();
    this.base = path.join(dataDir, "song-files");
    this.root = null;
    // Expired files go even when nothing new is prepared; this timer never keeps the server alive.
    setInterval(() => void this.evict().catch(() => undefined), 60_000).unref();
  }

  /** This server's folder, created on first use (shared by requests that arrive together). */
  directory() {
    // A failed attempt isn't remembered, so the next request tries again.
    this.root ??= runFolder(this.base).catch((error) => {
      this.root = null;
      throw error;
    });
    return this.root;
  }

  /** Clears out what stopped servers left, and old temp-folder files from earlier versions. */
  async sweep() {
    await sweepRunFolders(this.base);
    await sweepOldTemp(/^slopify-songs-[A-Za-z0-9]{6}$/);
  }

  /** The song's temporary file, prepared from its source if there isn't one. */
  async get(song) {
    const ready = this.items.get(song.id);
    if (ready) {
      try {
        await fs.access(ready.filePath);
        // Reinserted, so a reused file counts as recently used.
        this.items.delete(song.id);
        this.items.set(song.id, { ...ready, at: Date.now() });
        return ready;
      } catch {
        this.items.delete(song.id);
      }
    }
    let task = this.pending.get(song.id);
    if (!task) {
      task = this.create(song).finally(() => this.pending.delete(song.id));
      this.pending.set(song.id, task);
    }
    return task;
  }

  /** Keeps a file the import has just prepared, so the device's own copy is fetched without a second download. */
  async adopt(id, file) {
    const dir = await fs.mkdtemp(path.join(await this.directory(), `${id}-`));
    const filePath = path.join(dir, path.basename(file.filePath));
    await fs.rename(file.filePath, filePath).catch(async () => {
      await fs.copyFile(file.filePath, filePath);
      await fs.rm(file.filePath, { force: true });
    });
    this.items.set(id, { ...file, filePath, at: Date.now() });
    await this.evict();
  }

  async create(song) {
    const dir = await fs.mkdtemp(path.join(await this.directory(), `${song.id}-`));
    try {
      const file = await this.prepare(song, dir, AbortSignal.timeout(PREPARE_TIMEOUT));
      this.items.set(song.id, { ...file, at: Date.now() });
      await this.evict();
      return this.items.get(song.id);
    } catch (error) {
      await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
      throw error;
    }
  }

  /** Deletes a song's temporary file (its device copy is verified, or the song was deleted). */
  async drop(id) {
    const item = this.items.get(id);
    this.items.delete(id);
    if (item) await fs.rm(path.dirname(item.filePath), { recursive: true, force: true }).catch(() => undefined);
  }

  /** Drops expired files, then the least recently used until within the limits. */
  async evict() {
    const now = Date.now();
    for (const [id, item] of this.items) if (now - item.at > KEEP_FOR) await this.drop(id);
    let bytes = [...this.items.values()].reduce((n, item) => n + item.size, 0);
    for (const [id, item] of this.items) {
      if (this.items.size <= MAX_FILES && bytes <= MAX_BYTES) break;
      bytes -= item.size;
      await this.drop(id);
    }
  }
}
