import fs from "node:fs/promises";
import path from "node:path";
import { readDurably, writeDurably } from "./durable-file.mjs";

/*
 * The music server's song library. A song is a record of where it comes from
 * (its source link) and what is known about it; the server keeps no copy of
 * the audio. Each device keeps its own file, fetched through
 * GET /api/songs/:id/file, which prepares a temporary copy from the source
 * (see song-files.mjs).
 *
 * Metadata is open-ended. SONG_FIELDS lists what a client may set, each with
 * its own check, so a new field is one entry here. `extra` holds anything else
 * under namespaced keys ("lyrics.offset", "player.eq") with no server change.
 *
 * Songs saved before links (library.json, version 1) kept their audio here.
 * They are converted on first load; each keeps its old file as `legacyFile`
 * until a device confirms it holds a verified copy (release), then it is deleted.
 */

const INVALID = Symbol("invalid");
const MAX_EXTRA_BYTES = 16 * 1024;
const EXTRA_KEY = /^[a-z][a-z0-9_.-]{0,63}$/i;

const text = (max, { optional = false } = {}) => (value) => {
  if (value === null && optional) return null;
  if (typeof value !== "string") return INVALID;
  const s = value.trim().slice(0, max);
  return s || (optional ? null : INVALID);
};
const httpsUrl = (value) => {
  if (value === null) return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" ? url.href : INVALID;
  } catch {
    return INVALID;
  }
};

/** Metadata a client may set on a song, each with its check. Add a field here to make it storable. */
const FIELDS = {
  title: text(500),
  artist: text(500),
  album: text(500, { optional: true }),
  durationSeconds: (v) => (v === null ? null : Number.isFinite(v) && v > 0 && v < 86_400 ? v : INVALID),
  /** Whether the song was saved as a video (and plays with its picture) or as audio. */
  savedAs: (v) => (v === "audio" || v === "video" ? v : INVALID),
  artworkUrl: httpsUrl,
  /** The part of the song that plays, when it has been trimmed. */
  clip: (v) => {
    if (v === null) return null;
    const ok = v && Number.isFinite(v.start) && Number.isFinite(v.end) && v.start >= 0 && v.end > v.start;
    return ok ? { start: v.start, end: v.end } : INVALID;
  },
};
export const SONG_FIELDS = Object.keys(FIELDS);

const invalid = (message) => Object.assign(new Error(message), { status: 400 });

/** Checks a set of metadata changes. Unknown fields are refused, so a typo never silently does nothing. */
export function checkMetadata(changes, { required = [] } = {}) {
  if (!changes || typeof changes !== "object") throw invalid("Send song metadata as an object.");
  const out = {};
  for (const [key, value] of Object.entries(changes)) {
    if (key === "extra") continue;
    const check = FIELDS[key];
    if (!check) throw invalid(`Unknown song field "${key}".`);
    const checked = check(value);
    if (checked === INVALID) throw invalid(`Invalid value for "${key}".`);
    out[key] = checked;
  }
  for (const key of required) if (out[key] === undefined || out[key] === null) throw invalid(`"${key}" is required.`);
  return out;
}

/** Applies `extra` changes: a key set to null is removed. */
function mergeExtra(current, changes) {
  if (changes === undefined) return current;
  if (!changes || typeof changes !== "object" || Array.isArray(changes)) throw invalid("extra must be an object.");
  const next = { ...current };
  for (const [key, value] of Object.entries(changes)) {
    if (!EXTRA_KEY.test(key)) throw invalid(`Invalid extra key "${key}".`);
    if (value === null) delete next[key];
    else next[key] = value;
  }
  if (JSON.stringify(next).length > MAX_EXTRA_BYTES) throw invalid("Too much extra metadata for one song.");
  return next;
}

/** A version-1 library entry (stored audio) as a song record. */
function fromVersion1(t) {
  const album = typeof t.album === "string" && !/^(import|imported)$/i.test(t.album.trim()) ? t.album : null;
  return {
    id: t.id,
    addedAt: t.addedAt || Date.now(),
    updatedAt: t.addedAt || Date.now(),
    title: t.title || "Untitled",
    artist: t.artist || "Unknown artist",
    album,
    durationSeconds: t.durationSeconds || null,
    savedAs: t.mediaKind === "video" ? "video" : "audio",
    sourceURL: t.sourceURL || null,
    sourceIdentity: t.sourceIdentity || null,
    sourceSha256: t.sourceSha256 || null,
    contentSha256: t.contentSha256 || null,
    artworkUrl: null,
    artworkFile: t.artwork || null,
    clip: null,
    extra: {},
    legacyFile: t.file || null,
  };
}

export class SongStore {
  /** `beforeSave` throws when this server may no longer write the library (see library-lock.mjs). */
  constructor(dataDir, beforeSave = () => {}) {
    this.dir = dataDir;
    this.beforeSave = beforeSave;
    this.file = path.join(dataDir, "songs.json");
    this.legacyLibrary = path.join(dataDir, "library.json");
    this.mediaDir = path.join(dataDir, "media");
    this.artworkDir = path.join(dataDir, "artwork");
    this.songs = null;
    this.loading = null;
    this.writing = Promise.resolve();
    this.editing = Promise.resolve();
  }

  /**
   * Runs one change to the library and its save before the next change starts,
   * so a change undone after a failed save never undoes (or keeps) another's.
   */
  exclusive(change) {
    const run = this.editing.catch(() => undefined).then(change);
    this.editing = run;
    return run;
  }

  /** Reads the library once. Requests that arrive together share the read, so they all edit the same array. */
  load() {
    this.loading ??= this.read().catch((error) => {
      this.loading = null;
      throw error;
    });
    return this.loading;
  }

  async read() {
    await fs.mkdir(this.artworkDir, { recursive: true });
    const parsed = await this.readJSON(this.file, (v) => Array.isArray(v?.songs));
    if (parsed) {
      if (!Array.isArray(parsed.songs)) throw new Error(`Slopify's song library is damaged (${this.file}). Repair or move it, then try again.`);
      return (this.songs = parsed.songs);
    }
    // First run with links: convert the old stored-audio library, keeping it as a backup.
    const old = await this.readJSON(this.legacyLibrary, (v) => Array.isArray(v?.tracks));
    if (old && !Array.isArray(old.tracks)) throw new Error(`Slopify's library file is damaged (${this.legacyLibrary}). Repair or move it, then try again.`);
    this.songs = (old?.tracks ?? []).map(fromVersion1);
    await this.save();
    if (old) await fs.rename(this.legacyLibrary, `${this.legacyLibrary}.v1-backup`).catch(() => undefined);
    return this.songs;
  }

  /** The parsed file (or its backup, if the file is damaged or isn't `valid`), or null if neither exists. Any other failure stops the load, so a real library is never overwritten. */
  async readJSON(file, valid) {
    const found = await readDurably(file, { valid, damaged: () => new Error(`Slopify's library file is damaged (${file}). Repair or move it, then try again.`) });
    return found ? found.value : null;
  }

  save() {
    // Serialize writes, flushed to the disk and replaced atomically, so a crash or a full disk never leaves a damaged file.
    const write = this.writing.catch(() => undefined).then(async () => {
      await fs.mkdir(this.dir, { recursive: true });
      await writeDurably(this.file, JSON.stringify({ version: 2, songs: this.songs }, null, 2), this.beforeSave);
    });
    this.writing = write;
    return write;
  }

  find(id) {
    return this.songs?.find((s) => s.id === id) ?? null;
  }

  /** The song already saved from this source, if any. */
  findBySource(sourceURL, sourceIdentity, savedAs) {
    return this.songs?.find((s) => s.savedAs === savedAs && ((sourceIdentity && s.sourceIdentity === sourceIdentity) || (sourceURL && s.sourceURL === sourceURL))) ?? null;
  }

  add(song) {
    return this.exclusive(() => this.addNow(song));
  }

  async addNow(song) {
    await this.load();
    this.songs.unshift(song);
    try {
      await this.save();
    } catch (error) {
      this.songs.splice(this.songs.indexOf(song), 1);
      throw error;
    }
    return song;
  }

  /**
   * Adds a song saved elsewhere (another computer, through a Slopify account) under
   * its own id: a link and its details. `playableURL` is where its audio comes from
   * when the link itself has none (a Spotify page plays a YouTube match).
   */
  adopt(id, body) {
    return this.exclusive(() => this.adoptNow(id, body));
  }

  async adoptNow(id, body) {
    await this.load();
    if (this.find(id)) throw Object.assign(new Error("That song is already here."), { status: 409 });
    const meta = checkMetadata(
      Object.fromEntries(Object.entries(body ?? {}).filter(([key]) => SONG_FIELDS.includes(key))),
      { required: ["title", "artist"] },
    );
    const link = (v) => {
      try {
        return typeof v === "string" && new URL(v).protocol === "https:" ? v : null;
      } catch {
        return null;
      }
    };
    const sourceURL = link(body?.sourceURL);
    if (!sourceURL) throw Object.assign(new Error("Only songs with a link can be added this way."), { status: 400 });
    const playableURL = link(body?.playableURL);
    const now = Date.now();
    return this.addNow({
      id,
      addedAt: Number.isFinite(body?.addedAt) && body.addedAt > 0 ? body.addedAt : now,
      updatedAt: now,
      title: meta.title,
      artist: meta.artist,
      album: meta.album ?? null,
      durationSeconds: meta.durationSeconds ?? null,
      savedAs: meta.savedAs ?? "audio",
      sourceURL,
      sourceIdentity: playableURL && playableURL !== sourceURL ? { aliases: [{ sourcePageURL: playableURL }] } : null,
      sourceSha256: null,
      contentSha256: null,
      artworkUrl: meta.artworkUrl ?? null,
      artworkFile: null,
      clip: meta.clip ?? null,
      extra: mergeExtra({}, body?.extra ?? {}),
      legacyFile: null,
    });
  }

  /** Updates a song's metadata (see SONG_FIELDS) and `extra`. */
  update(id, changes) {
    return this.exclusive(async () => {
      await this.load();
      const song = this.find(id);
      if (!song) return null;
      const before = { ...song };
      Object.assign(song, checkMetadata(changes), { extra: mergeExtra(song.extra ?? {}, changes.extra), updatedAt: Date.now() });
      try {
        await this.save();
      } catch (error) {
        Object.assign(song, before);
        throw error;
      }
      return song;
    });
  }

  async remove(id) {
    const song = await this.exclusive(async () => {
      await this.load();
      const index = this.songs.findIndex((s) => s.id === id);
      if (index < 0) return null;
      const [song] = this.songs.splice(index, 1);
      try {
        await this.save();
      } catch (error) {
        // Keep memory in line with the file, so a retry finds the song again.
        this.songs.splice(index, 0, song);
        throw error;
      }
      return song;
    });
    if (!song) return null;
    await this.dropLegacyFile(song);
    if (song.artworkFile) await fs.rm(path.join(this.artworkDir, path.basename(song.artworkFile)), { force: true }).catch(() => undefined);
    return song;
  }

  /** Deletes a converted song's old stored audio once a device holds its own copy. Songs with no source link keep theirs. */
  release(id) {
    return this.exclusive(async () => {
      await this.load();
      const song = this.find(id);
      if (!song?.legacyFile || !song.sourceURL) return false;
      await this.dropLegacyFile(song);
      song.legacyFile = null;
      await this.save();
      return true;
    });
  }

  legacyPath(song) {
    return song.legacyFile ? path.join(this.mediaDir, path.basename(song.legacyFile)) : null;
  }

  async dropLegacyFile(song) {
    const file = this.legacyPath(song);
    if (file) await fs.rm(file, { force: true }).catch(() => undefined);
  }

  /** What clients see of a song. */
  publicSong(s) {
    return {
      id: s.id,
      title: s.title,
      artist: s.artist,
      album: s.album,
      durationSeconds: s.durationSeconds,
      savedAs: s.savedAs,
      addedAt: s.addedAt,
      updatedAt: s.updatedAt,
      sourceURL: s.sourceURL,
      artworkUrl: s.artworkUrl || (s.artworkFile ? `/api/artwork/${s.id}` : null),
      clip: s.clip ?? null,
      extra: s.extra ?? {},
      fileUrl: `/api/songs/${s.id}/file`,
      /** Still holds stored audio from before links; a device should take its copy so the server can release it. */
      serverCopy: Boolean(s.legacyFile && s.sourceURL),
    };
  }
}
