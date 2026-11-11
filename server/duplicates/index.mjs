import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { readDurably, writeDurably } from "../durable-file.mjs";
import { PAYLOAD_PREFIX_BYTES, payloadHashOfBuffer, payloadHashOfFile } from "./payload.mjs";
import { MAX_SECONDS, WORD_SECONDS, coarsen, compare, decodeAudio, fromBuffer, libraryPrint, prepareQuery, queryPrint, toBuffer } from "./fingerprint.mjs";
import { namesOverlap } from "./keys.mjs";

const require = createRequire(import.meta.url);
const { youtubeVideoID } = require("../providers/local-import-core.cjs");
const { completedSoundCloudDownload, ffmpegExecutable } = require("../providers/local-import-platform.cjs");
const { downloadResolvedAudio, downloadYouTubeAudio, fetchResolvedAudioRange, resolveYouTubeAudio, youtubeCoolingDown } = require("../providers/local-youtube.cjs");
const {
  downloadResolvedSoundCloudAudio,
  downloadSoundCloudAudio,
  fetchResolvedSoundCloudRange,
  isSoundCloudURL,
  resolveSoundCloudAudio,
} = require("../providers/local-soundcloud.cjs");

/*
 * Whether a song being saved is already in the library, checked from the
 * cheapest evidence to the dearest, stopping at the first answer:
 *
 *   1. source keys        no download   the same upload, however its link is written
 *   2. stream signature   no download   the stream's content ETag (SoundCloud gives one)
 *   3. audio-data hash    ~190 KB       the same encoded sound, whatever its file around it
 *   4. fingerprint        ~45 s of it   the same recording from anywhere (asks first)
 *
 * A source-key match is certain, so the song is skipped. So is a signature
 * match, or an audio-data match between songs of the same length, for audio;
 * a video is more than its sound, so for one those only ask. A fingerprint
 * match is a judgement, so the person is always asked. Whatever the check fetched is handed
 * to the download, which carries on from there, so a song that turns out to
 * be new is not fetched twice. (The SHA-256 of the whole download, checked
 * after it, still catches what these miss.)
 *
 * The library side (signatures, audio-data hashes and fingerprints) lives in
 * duplicates.json and fingerprints/ in the library's folder, keyed by song. A
 * song saved from now on is fingerprinted in full from its download. One
 * saved before is fingerprinted from its first 75 seconds the first time a
 * song with a similar name is checked against it, and in full whenever a
 * device next fetches its file.
 */

/** Seconds of a song being checked that are fingerprinted, and of a library song fingerprinted from its source. */
const QUERY_SECONDS = 45;
const LIBRARY_SECONDS = 75;
/** Library songs fingerprinted from their source during one check, at most. */
const BACKFILLS_PER_CHECK = 3;
/** A library song that couldn't be fingerprinted is tried again after a week. */
const RECHECK_AFTER = 7 * 86_400_000;
/** Songs whose lengths differ by more than this aren't compared (a music video's intro and outro fit within it). */
const DURATION_GAP = 90;
/** An audio-data match counts as the same song only if the lengths agree this closely (an edit can share an opening). */
const SAME_LENGTH = 2;

const isAbort = (error) => error?.name === "AbortError";

function ffmpegPath() {
  try {
    return ffmpegExecutable();
  } catch {
    return null;
  }
}

/** A content ETag (an MD5, as S3 and CloudFront give): the stream's exact bytes. Other ETags may not be, so they're ignored. */
function strongSignature(etag) {
  const match = typeof etag === "string" ? /^"?([0-9a-f]{32}(?:-\d+)?)"?$/i.exec(etag.trim()) : null;
  return match ? `etag:${match[1].toLowerCase()}` : null;
}

/** About how many bytes of a stream hold its first `seconds`. */
function bytesFor(resolved, seconds) {
  const total = resolved.contentLength;
  const duration = Number(resolved.durationSeconds);
  const estimate = duration > 0
    ? Math.ceil(total * Math.min(1, (seconds + 3) / duration)) + 64 * 1024
    : Math.ceil(seconds * 24 * 1024);
  return Math.min(total, Math.max(estimate, PAYLOAD_PREFIX_BYTES));
}

/* ───────────────────────── what is known of the library ───────────────────────── */

class DuplicateIndex {
  constructor(dataDir, beforeSave) {
    this.dir = dataDir;
    this.file = path.join(dataDir, "duplicates.json");
    this.printDir = path.join(dataDir, "fingerprints");
    this.beforeSave = beforeSave;
    this.entries = null;
    this.loading = null;
    this.writing = Promise.resolve();
    this.prints = new Map();
  }

  load() {
    this.loading ??= this.read().catch((error) => {
      this.loading = null;
      throw error;
    });
    return this.loading;
  }

  async read() {
    let found = null;
    try {
      found = await readDurably(this.file, {
        valid: (v) => v && typeof v.songs === "object" && !Array.isArray(v.songs),
        damaged: () => new Error("damaged"),
        blankIsEmpty: true,
      });
    } catch {
      // Only what can be worked out again is kept here, so a damaged file starts afresh.
    }
    const songs = found?.value?.songs;
    this.entries = songs && typeof songs === "object" && !Array.isArray(songs) ? songs : {};
    return this.entries;
  }

  get(id) {
    return this.entries?.[id] ?? null;
  }

  printFile(id) {
    const name = /^[\w-]{1,80}$/.test(id) ? id : createHash("sha1").update(String(id)).digest("hex");
    return path.join(this.printDir, `${name}.fp`);
  }

  /** Merges changes into a song's entry; a null value removes that field. */
  async update(id, changes) {
    await this.load();
    const next = { ...(this.entries[id] ?? {}), ...changes };
    for (const [key, value] of Object.entries(next)) if (value === null || value === undefined) delete next[key];
    this.entries[id] = next;
    await this.save();
  }

  /** Keeps a song's fingerprint: "full" (from its whole download) or "start" (its first seconds). */
  async setPrint(id, print, coverage) {
    await this.load();
    await fs.mkdir(this.printDir, { recursive: true });
    const file = this.printFile(id);
    const temp = `${file}.${process.pid}.tmp`;
    await fs.writeFile(temp, toBuffer(print));
    try {
      // A server that has lost the library mustn't change its files, these included.
      this.beforeSave();
      await fs.rename(temp, file);
    } catch (error) {
      await fs.rm(temp, { force: true }).catch(() => undefined);
      throw error;
    }
    this.prints.set(id, print);
    await this.update(id, { print: { coverage, seconds: Math.round(print.length * WORD_SECONDS), at: Date.now() } });
  }

  async print(id) {
    if (this.prints.has(id)) return this.prints.get(id);
    if (!this.get(id)?.print) return null;
    try {
      const print = fromBuffer(await fs.readFile(this.printFile(id)));
      this.prints.set(id, print);
      return print;
    } catch {
      return null;
    }
  }

  async remove(id) {
    await this.load();
    this.beforeSave();
    this.prints.delete(id);
    await fs.rm(this.printFile(id), { force: true }).catch(() => undefined);
    if (!(id in this.entries)) return;
    delete this.entries[id];
    await this.save();
  }

  save() {
    const write = this.writing.catch(() => undefined).then(async () => {
      await fs.mkdir(this.dir, { recursive: true });
      await writeDurably(this.file, JSON.stringify({ version: 1, songs: this.entries }), this.beforeSave);
    });
    this.writing = write;
    return write;
  }
}

/* ───────────────────────── the check ───────────────────────── */

/**
 * `songs`: the SongStore. `downloadLink(song)`: where a saved song's sound comes from.
 * `beforeSave` throws when this server may no longer write the library.
 */
export function createDuplicateFinder({ dataDir, songs, downloadLink, beforeSave = () => {} }) {
  const index = new DuplicateIndex(dataDir, beforeSave);
  const backfilling = new Map();

  /** A link's audio stream, ready to read a range of: YouTube's M4A or SoundCloud's MP3. */
  async function openStream(link, signal) {
    if (typeof link !== "string" || !link) return null;
    if (isSoundCloudURL(link)) {
      const resolved = await resolveSoundCloudAudio(link, signal);
      return { provider: "soundcloud", resolved, range: (start, end) => fetchResolvedSoundCloudRange(resolved, start, end, signal) };
    }
    let id = null;
    try {
      id = youtubeVideoID(link);
    } catch {
      return null;
    }
    if (!id) return null;
    const resolved = await resolveYouTubeAudio(link, signal);
    return { provider: "youtube", resolved, range: (start, end) => fetchResolvedAudioRange(resolved, start, end, signal) };
  }

  /** The fingerprint of a stream's first bytes: fine for a song being checked, library spacing for one kept. */
  async function printStart(bytes, seconds, signal, fine) {
    const ffmpeg = ffmpegPath();
    if (!ffmpeg) return null;
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "slopify-print-"));
    try {
      const file = path.join(dir, "start");
      await fs.writeFile(file, bytes);
      const samples = await decodeAudio(ffmpeg, file, { seconds, signal });
      if (!samples) return null;
      return fine ? queryPrint(samples) : libraryPrint(samples);
    } finally {
      await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  const recentlyFailed = (entry) => Boolean(entry?.checkedAt && !entry.print && Date.now() - entry.checkedAt < RECHECK_AFTER);

  /** Fingerprints a library song from the start of its source (one at a time per song). */
  function backfill(song, signal) {
    let task = backfilling.get(song.id);
    if (!task) {
      task = backfillNow(song, signal).finally(() => backfilling.delete(song.id));
      backfilling.set(song.id, task);
    }
    return task;
  }

  async function backfillNow(song, signal) {
    const checkedAt = Date.now();
    const link = downloadLink(song);
    // Fingerprinting a library song can wait while YouTube is cooling down (it's tried again next time).
    if (typeof link === "string" && !isSoundCloudURL(link) && youtubeCoolingDown()) return;
    try {
      const stream = await openStream(link, signal);
      if (!stream) return void (await index.update(song.id, { checkedAt }));
      const bytes = await stream.range(0, bytesFor(stream.resolved, LIBRARY_SECONDS));
      const payload = await payloadHashOfBuffer(bytes);
      const print = await printStart(bytes, LIBRARY_SECONDS, signal, false);
      if (!songs.find(song.id)) return;
      if (print) await index.setPrint(song.id, print, "start");
      const entry = index.get(song.id) ?? {};
      await index.update(song.id, {
        signature: entry.signature || strongSignature(stream.resolved.etag),
        payload: entry.payload || payload,
        checkedAt,
      });
    } catch (error) {
      if (isAbort(error)) throw error;
      await index.update(song.id, { checkedAt }).catch(() => undefined);
    }
  }

  /** The library song (of those given) that sounds the same as a fine print, if one does. */
  async function findSimilar(fine, library, { metadata, durationSeconds }, signal) {
    const query = prepareQuery(fine);
    const length = Number(durationSeconds) || Number(metadata?.durationSeconds) || 0;
    const gap = (s) => (length > 0 && s.durationSeconds > 0 ? Math.abs(s.durationSeconds - length) : 0);
    const near = (s) => gap(s) <= DURATION_GAP;
    // Songs whose names say they might be this one are fingerprinted now if they never were.
    const unprinted = library
      .filter((s) => near(s) && !index.get(s.id)?.print && !recentlyFailed(index.get(s.id)) && namesOverlap(metadata ?? {}, s))
      .sort((a, b) => gap(a) - gap(b))
      .slice(0, BACKFILLS_PER_CHECK);
    await Promise.all(unprinted.map((s) => backfill(s, signal).catch((error) => {
      if (isAbort(error)) throw error;
    })));
    let best = null;
    let compared = 0;
    for (const song of library) {
      if (!near(song)) continue;
      // Comparing is CPU work: let other requests (and a cancel) in now and then.
      if (++compared % 25 === 0) {
        await new Promise((resolve) => setImmediate(resolve));
        if (signal?.aborted) throw signal.reason ?? new DOMException("Cancelled", "AbortError");
      }
      const print = await index.print(song.id);
      if (!print) continue;
      const match = compare(query, print);
      if (match?.same && (!best || match.ber < best.match.ber)) best = { song, match };
    }
    return best;
  }

  /**
   * Checks a song about to be saved against the library (its songs saved the same way, as audio
   * or as video). Answers `{ kind: "duplicate", song, layer }`, `{ kind: "similar", song, match }`
   * (to ask about: a fingerprint match, or an exact sound match that may still be another song or video) or `{ kind: "new", probe }`, where `probe` holds what
   * was fetched, for record() and downloadAdapters(). `allowSimilar` skips the fingerprint.
   */
  async function check({ sourceURL, sourceIdentity, savedAs, metadata, durationSeconds, allowSimilar = false }, signal, progress = () => {}) {
    await songs.load();
    await index.load().catch(() => undefined);
    const library = songs.songs.filter((s) => s.savedAs === savedAs);

    // 1. Source keys.
    const bySource = songs.findBySource(sourceURL, sourceIdentity, savedAs);
    if (bySource) return { kind: "duplicate", layer: "source", song: bySource };

    progress({ stage: "checking_library" });
    let stream = null;
    try {
      stream = await openStream(sourceURL, signal);
    } catch (error) {
      if (isAbort(error)) throw error;
    }
    if (!stream) return { kind: "new", probe: null };
    const probe = { provider: stream.provider, resolved: stream.resolved, signature: strongSignature(stream.resolved.etag), prefix: null, payload: null, print: null };
    const entry = (s) => index.get(s.id);
    const sameLength = (s) => {
      const a = Number(stream.resolved.durationSeconds);
      const b = Number(s.durationSeconds);
      return a > 0 && b > 0 && Math.abs(a - b) <= SAME_LENGTH;
    };
    /** What an exact sound match means: skipped (audio, and the whole stream or a same-length song), else asked about. */
    const exact = (song, layer, wholeStream) => {
      if (savedAs === "audio" && (wholeStream || sameLength(song))) return { kind: "duplicate", layer, song };
      if (allowSimilar) return null;
      const overlapSeconds = wholeStream ? Number(stream.resolved.durationSeconds) || 0 : 8;
      return { kind: "similar", layer, song, match: { ber: 0, overlapSeconds }, probe };
    };

    // 2. The stream's signature.
    if (probe.signature) {
      const known = library.find((s) => entry(s)?.signature === probe.signature);
      const answer = known && exact(known, "stream", true);
      if (answer) return answer;
    }

    try {
      // 3. The audio-data hash of its first seconds.
      probe.prefix = await stream.range(0, Math.min(stream.resolved.contentLength, PAYLOAD_PREFIX_BYTES));
      const byPayload = async () => {
        probe.payload ??= await payloadHashOfBuffer(probe.prefix);
        return probe.payload ? library.find((s) => entry(s)?.payload === probe.payload) ?? null : null;
      };
      let known = await byPayload();
      let answer = known && exact(known, "audio", false);
      if (answer) return answer;

      // 4. Its fingerprint.
      if (!allowSimilar && ffmpegPath()) {
        const want = bytesFor(stream.resolved, QUERY_SECONDS);
        if (want > probe.prefix.length) probe.prefix = Buffer.concat([probe.prefix, await stream.range(probe.prefix.length, want)]);
        if (!known) {
          known = await byPayload();
          answer = known && exact(known, "audio", false);
          if (answer) return answer;
        }
        probe.print = await printStart(probe.prefix, QUERY_SECONDS, signal, true);
        if (probe.print) {
          const similar = await findSimilar(probe.print, library, { metadata, durationSeconds: stream.resolved.durationSeconds || durationSeconds }, signal);
          if (similar) return { kind: "similar", song: similar.song, match: similar.match, probe };
        }
      }
    } catch (error) {
      // The check goes as far as it can; the import itself still runs (and reports its own failures).
      if (isAbort(error)) throw error;
    }
    return { kind: "new", probe };
  }

  /**
   * Adapters for importConfirmedSource that download the stream the check already resolved,
   * carrying on after the bytes it fetched. If that fails, the usual download runs instead.
   */
  function downloadAdapters(probe, mediaKind) {
    if (!probe?.resolved || mediaKind !== "audio") return {};
    const { resolved } = probe;
    const prefix = probe.prefix?.length ? probe.prefix : null;
    if (probe.provider === "youtube") {
      return {
        async downloadYouTubeAudio(source, destination, signal, onProgress) {
          try {
            const download = await downloadResolvedAudio(resolved, destination, signal, onProgress, fetch, { prefix });
            const { streamingURL, streamingHeaders, ...preview } = resolved;
            return { preview, mediaSourceURL: streamingURL, download };
          } catch (error) {
            if (isAbort(error) || signal?.aborted) throw error;
            // What the check saw may not be what this download gets: record() keeps none of it.
            probe.replaced = true;
            return downloadYouTubeAudio(source, destination, signal, onProgress);
          }
        },
      };
    }
    if (probe.provider === "soundcloud") {
      return {
        async downloadSoundCloudAudio(source, destination, signal, onProgress) {
          try {
            return completedSoundCloudDownload(resolved, await downloadResolvedSoundCloudAudio(resolved, destination, signal, onProgress, fetch, { prefix }));
          } catch (error) {
            if (isAbort(error) || signal?.aborted) throw error;
            probe.replaced = true;
            return downloadSoundCloudAudio(source, destination, signal, onProgress);
          }
        },
      };
    }
    return {};
  }

  /** A downloaded file studied: its audio-data hash and full fingerprint (importConfirmedSource's analyzeSource). */
  async function analyzeFile(filePath, { signal } = {}) {
    const payload = await payloadHashOfFile(filePath);
    const ffmpeg = ffmpegPath();
    const samples = ffmpeg ? await decodeAudio(ffmpeg, filePath, { seconds: MAX_SECONDS, signal }) : null;
    return { payload, print: samples ? libraryPrint(samples) : null };
  }

  /** Keeps what is known of a song just saved: from its check (`probe`) and its download (`analysis`). */
  async function record(id, { probe, analysis }) {
    // A check whose stream the download gave up on describes other bytes.
    const seen = probe && !probe.replaced ? probe : null;
    const print = analysis?.print ?? (seen?.print ? coarsen(seen.print) : null);
    if (print) await index.setPrint(id, print, analysis?.print ? "full" : "start");
    await index.update(id, {
      // The check's hash comes from the stream itself, as later checks' will.
      signature: seen?.signature ?? null,
      payload: seen?.payload ?? analysis?.payload ?? null,
      checkedAt: Date.now(),
    });
  }

  /** Whether a saved song's download is still worth studying (it has no full fingerprint or audio-data hash yet). */
  function wants(id) {
    const entry = index.get(id);
    return !entry || entry.print?.coverage !== "full" || !entry.payload;
  }

  /** Learns from a saved song's file fetched for a device (see prepareSongFile). */
  async function learn(id, analysis) {
    if (!analysis || !songs.find(id)) return;
    await index.load();
    const entry = index.get(id) ?? {};
    if (analysis.print && entry.print?.coverage !== "full") await index.setPrint(id, analysis.print, "full");
    if (analysis.payload && !entry.payload) await index.update(id, { payload: analysis.payload });
  }

  /** Studies songs whose sound is still stored on this server (from before links). Local work only. */
  async function studyStoredFiles() {
    await songs.load();
    await index.load();
    for (const song of songs.songs) {
      const file = songs.legacyPath(song);
      if (!file || !wants(song.id)) continue;
      try {
        await learn(song.id, await analyzeFile(file));
      } catch {
        // Unreadable, or the library moved on: another time.
      }
    }
  }

  return {
    check,
    downloadAdapters,
    analyzeFile,
    record,
    wants,
    learn,
    studyStoredFiles,
    remove: (id) => index.remove(id),
  };
}
