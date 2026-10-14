// Slopify's backend: the music server API, which exposes the Resonance provider
// modules in ./providers over HTTP. `npm start` runs it with the built app
// (server/main.mjs); during development it runs inside Vite (see vite.config.ts).
import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import fs from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import { createRecommendations } from "./recommendations.mjs";
import { createArtists } from "./artists.mjs";
import { createCatalog } from "./catalog.mjs";
import { createStateStore, readLargeJSON } from "./library-state.mjs";
import { runFolder, sweepOldTemp, sweepRunFolders } from "./run-folders.mjs";
import { SongFiles } from "./song-files.mjs";
import { SongStore } from "./songs.mjs";

const require = createRequire(import.meta.url);
const { checkoutDataDir } = require("./data-dir.cjs");
const { LocalImportError, youtubeVideoID } = require("./providers/local-import-core.cjs");
const { importConfirmedSource, resolveLocalImportSource } = require("./providers/local-import-platform.cjs");
const { looksLikeLink, searchAllPlatforms, searchMorePlatforms } = require("./providers/local-search.cjs");
const { downloadResolvedAudio, resolveYouTubeAudio } = require("./providers/local-youtube.cjs");
const { downloadResolvedSoundCloudAudio, isSoundCloudURL, resolveSoundCloudAudio } = require("./providers/local-soundcloud.cjs");

const MAX_BODY_BYTES = 256 * 1024;
const MAX_PREVIEW_BYTES = 32 * 1024 * 1024;
const PREVIEW_SECONDS = 30;
const ID = /^[A-Za-z0-9-]{8,64}$/;
const MEDIA_TYPES = { ".m4a": "audio/mp4", ".mp3": "audio/mpeg", ".mp4": "video/mp4", ".webm": "video/webm" };
const IMAGE_TYPES = { ".jpg": "image/jpeg", ".png": "image/png", ".webp": "image/webp", ".avif": "image/avif" };

function failure(error, fallbackStage) {
  if (error?.name === "AbortError") return { stage: fallbackStage, code: "CANCELLED", message: "Import cancelled." };
  if (error instanceof LocalImportError || (error && typeof error.stage === "string" && typeof error.code === "string")) {
    return { stage: error.stage, code: error.code, message: error.message, retryAfter: error.retryAfter || null };
  }
  return { stage: fallbackStage, code: "IMPORT_FAILED", message: error?.message || "Slopify could not complete the import." };
}

function sendJSON(res, status, value) {
  const body = JSON.stringify(value);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(body);
}

/** Whether a browser sent this request from another website (by its Fetch Metadata, else its Origin). */
function crossSite(req) {
  const site = req.headers["sec-fetch-site"];
  if (site) return site !== "same-origin" && site !== "none";
  const origin = req.headers.origin;
  if (!origin) return false;
  try {
    return new URL(origin).host !== req.headers.host;
  } catch {
    return true;
  }
}

async function readJSON(req) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw Object.assign(new Error("Request body too large."), { status: 413 });
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw Object.assign(new Error("Request body is not valid JSON."), { status: 400 });
  }
}

/**
 * Streams newline-delimited JSON: zero or more `{type:"progress"}` lines, then one
 * `{type:"result"}` line. Closing the request aborts the operation.
 */
function ndjson(res) {
  const controller = new AbortController();
  res.writeHead(200, { "Content-Type": "application/x-ndjson; charset=utf-8", "Cache-Control": "no-store", "X-Accel-Buffering": "no" });
  res.on("close", () => {
    if (!res.writableFinished) controller.abort(new DOMException("Request closed", "AbortError"));
  });
  const write = (value) => {
    if (!res.writableEnded && !res.destroyed) res.write(`${JSON.stringify(value)}\n`);
  };
  return {
    signal: controller.signal,
    progress: (value) => write({ type: "progress", ...value }),
    finish: (value) => {
      write({ type: "result", ...value });
      res.end();
    },
  };
}

/**
 * Pipes a file into the response. pipeline() closes the file when the player
 * seeks or disconnects, and a file that vanishes mid-request ends that response
 * instead of throwing an unhandled stream error.
 */
function streamFile(filePath, res, range) {
  pipeline(createReadStream(filePath, range), res).catch(() => undefined);
}

/** Serves a file with HTTP Range support so the player can seek. */
async function sendFile(req, res, filePath, contentType, extraHeaders = {}) {
  let info;
  try {
    info = await fs.stat(filePath);
  } catch {
    res.writeHead(404).end();
    return;
  }
  const total = info.size;
  const headers = { "Content-Type": contentType, "Accept-Ranges": "bytes", "Cache-Control": "no-cache", ...extraHeaders };
  const match = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || "");
  if (match && (match[1] || match[2])) {
    let start = match[1] ? Number(match[1]) : Math.max(0, total - Number(match[2]));
    let end = match[1] && match[2] ? Number(match[2]) : total - 1;
    end = Math.min(end, total - 1);
    if (start > end || start >= total) {
      res.writeHead(416, { "Content-Range": `bytes */${total}` }).end();
      return;
    }
    res.writeHead(206, { ...headers, "Content-Range": `bytes ${start}-${end}/${total}`, "Content-Length": end - start + 1 });
    if (req.method === "HEAD") return res.end();
    streamFile(filePath, res, { start, end });
    return;
  }
  res.writeHead(200, { ...headers, "Content-Length": total });
  if (req.method === "HEAD") return res.end();
  streamFile(filePath, res);
}

function ffmpegPath() {
  try {
    const value = require("ffmpeg-static");
    return typeof value === "string" && value ? value : null;
  } catch {
    return null;
  }
}

/** Reads a media file's duration from ffmpeg's banner (ffmpeg-static ships no ffprobe). */
function probeDuration(filePath) {
  const ffmpeg = ffmpegPath();
  if (!ffmpeg) return Promise.resolve(null);
  return new Promise((resolve) => {
    const child = spawn(ffmpeg, ["-hide_banner", "-i", filePath], { stdio: ["ignore", "ignore", "pipe"], windowsHide: true });
    let stderr = "";
    child.stderr.on("data", (chunk) => { stderr = `${stderr}${chunk}`.slice(-16_384); });
    child.on("error", () => resolve(null));
    child.on("close", () => {
      const m = /Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(stderr);
      resolve(m ? Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) : null);
    });
  });
}

/** The tallest video a streamed preview downloads. */
const PREVIEW_VIDEO_HEIGHT = 1080;

/** Short-lived preview files: streamed songs, and the "listen before you import" buttons. */
class Previews {
  /** Previews live in the library's data folder, in this server's own folder (see run-folders.mjs). */
  constructor(dataDir) {
    this.root = path.join(dataDir, "previews");
    this.dir = null;
    this.items = new Map();
    this.protected = new Map();
  }

  /** This server's preview folder, created on first use (shared by previews that start together). */
  directory() {
    // A failed attempt isn't remembered, so the next preview tries again.
    this.dir ??= runFolder(this.root).catch((error) => {
      this.dir = null;
      throw error;
    });
    return this.dir;
  }

  /** Clears out what stopped servers left, and old temp-folder previews from earlier versions. */
  async sweep() {
    await sweepRunFolders(this.root);
    await sweepOldTemp(/^slopify-preview-[A-Za-z0-9]{6}$/);
  }

  /** A preview of the source's audio, or (`video`, YouTube only) its video with sound. */
  async create(sourceURL, signal, mediaKind = "audio") {
    const video = mediaKind === "video" && !isSoundCloudURL(sourceURL);
    const key = createHash("sha256").update(video ? `video:${sourceURL}` : sourceURL).digest("hex").slice(0, 32);
    const cached = this.items.get(key);
    if (cached) {
      try {
        await fs.access(cached.filePath);
        // Reinserted, so a reused preview counts as recently used.
        this.items.delete(key);
        this.items.set(key, cached);
        return { token: key, durationSeconds: cached.durationSeconds };
      } catch {
        this.items.delete(key);
      }
    }
    if (video) return this.createVideo(key, sourceURL, signal);
    const soundCloud = isSoundCloudURL(sourceURL);
    const resolved = soundCloud ? await resolveSoundCloudAudio(sourceURL, signal) : await resolveYouTubeAudio(sourceURL, signal);
    if (resolved.contentLength > MAX_PREVIEW_BYTES) {
      throw new LocalImportError("previewing", "PREVIEW_TOO_LARGE", "This source is too large to preview. You can still select and import it.");
    }
    // Each request downloads to its own file: two previews of the same source can run at once.
    const filePath = path.join(await this.directory(), `${key}-${randomUUID()}${soundCloud ? ".mp3" : ".m4a"}`);
    try {
      if (soundCloud) await downloadResolvedSoundCloudAudio(resolved, filePath, signal);
      else await downloadResolvedAudio(resolved, filePath, signal);
    } catch (error) {
      await fs.rm(filePath, { force: true }).catch(() => undefined);
      throw error;
    }
    const durationSeconds = Math.min(PREVIEW_SECONDS, resolved.durationSeconds || PREVIEW_SECONDS);
    const replaced = this.items.get(key);
    this.items.delete(key);
    this.items.set(key, { filePath, durationSeconds, contentType: soundCloud ? "audio/mpeg" : "audio/mp4" });
    if (replaced) await fs.rm(replaced.filePath, { force: true }).catch(() => undefined);
    await this.evict();
    return { token: key, durationSeconds };
  }

  /** Fetches a YouTube video (picture and sound in one MP4) the way a saved video is, into the preview folder. */
  async createVideo(key, sourceURL, signal) {
    const folder = path.join(await this.directory(), `${key}-${randomUUID()}`);
    let result;
    try {
      result = await importConfirmedSource({
        sourceURL,
        mediaKind: "video",
        metadata: { title: "Preview", artist: "Preview", sourceURL },
        existing: [],
        destinationDirectory: folder,
        temporaryRoot: os.tmpdir(),
        // A preview needn't be 4K: 1080p at most downloads in a fraction of the time.
        maxVideoHeight: PREVIEW_VIDEO_HEIGHT,
      }, signal, () => {});
    } catch (error) {
      await fs.rm(folder, { recursive: true, force: true }).catch(() => undefined);
      throw error;
    }
    const replaced = this.items.get(key);
    this.items.delete(key);
    this.items.set(key, { filePath: result.filePath, folder, durationSeconds: null, contentType: "video/mp4" });
    if (replaced) await this.remove(replaced);
    await this.evict();
    return { token: key, durationSeconds: null };
  }

  async remove(item) {
    await fs.rm(item.folder ?? item.filePath, { recursive: true, force: true }).catch(() => undefined);
  }

  /** Keeps these previews (the player's current and next streamed songs) on disk for ten minutes, replacing earlier protection. */
  protect(tokens) {
    this.protected = new Map(tokens.map((token) => [token, Date.now() + 10 * 60_000]));
  }

  /**
   * Keeps only a handful of previews on disk, least recently used going first
   * (recommended songs stream in full from these, so a few more than a dialog needs).
   */
  async evict() {
    for (const [token, until] of this.protected) if (until < Date.now()) this.protected.delete(token);
    const excess = Math.max(0, this.items.size - 12);
    const evictable = [...this.items].filter(([token]) => !this.protected.has(token)).slice(0, excess);
    for (const [token, item] of evictable) {
      this.items.delete(token);
      await this.remove(item);
    }
  }
}

/**
 * The link the song's audio downloads from. A song saved from Spotify (which
 * has no audio of its own) plays the YouTube or SoundCloud match chosen when it
 * was saved; its stored media address expires, so the match's page is used.
 */
function downloadLink(song) {
  const identity = song.sourceIdentity ?? {};
  const candidates = [
    song.sourceURL,
    ...(identity.aliases ?? []).map((alias) => alias?.sourcePageURL),
    identity.evidence?.matchedMediaReference,
  ];
  const downloadable = (url) => {
    try {
      return typeof url === "string" && Boolean(youtubeVideoID(url) || isSoundCloudURL(url));
    } catch {
      return false;
    }
  };
  return candidates.find(downloadable) ?? null;
}

/** Downloads a saved song from its source link into `dir` (a temporary copy; see song-files.mjs). */
async function prepareSongFile(song, dir, signal) {
  const sourceURL = downloadLink(song);
  if (!sourceURL) throw Object.assign(new Error("This song has no source link to fetch it from."), { status: 404 });
  const download = () => importConfirmedSource({
    sourceURL,
    sourceIdentity: song.sourceIdentity,
    mediaKind: song.savedAs,
    metadata: { title: song.title, artist: song.artist, album: song.album, artworkURL: song.artworkUrl },
    existing: [],
    destinationDirectory: dir,
    temporaryRoot: os.tmpdir(),
  }, signal, () => {});
  let result;
  try {
    result = await download();
  } catch (error) {
    // Sources occasionally fail once (an expired stream address, a dropped connection); try once more.
    if (signal.aborted) throw error;
    result = await download();
  }
  return { filePath: result.filePath, size: result.size, sha256: result.contentSha256 };
}

export function createImportApi({ dataDir }) {
  const songs = new SongStore(dataDir);
  const songFiles = new SongFiles(prepareSongFile, dataDir);
  const previews = new Previews(dataDir);
  // Leftovers from servers that didn't stop cleanly go now, not on first use.
  void previews.sweep();
  void songFiles.sweep();
  const recommendations = createRecommendations();
  const artists = createArtists();
  const catalog = createCatalog();
  const libraryState = createStateStore(dataDir);

  /*
   * Release dates for saved songs, looked up in the background and kept in each
   * song's `extra` ("release.date", "release.album"), so every device shows the
   * year a song came out rather than the year it was saved. A song the catalog
   * doesn't know is asked about again after a week.
   */
  let backfilling = false;
  let backfillAgain = false;
  const RECHECK = 7 * 86_400_000;
  async function backfillReleases() {
    if (backfilling) return void (backfillAgain = true);
    backfilling = true;
    try {
      do {
        backfillAgain = false;
        await songs.load();
        const due = songs.songs.filter((s) => !s.extra?.["release.date"] && !(Date.now() - (Number(s.extra?.["release.checkedAt"]) || 0) < RECHECK));
        for (const song of due) {
          // Copied now: `song` is the live record, which a rename changes in place.
          const asked = { title: song.title, artist: song.artist };
          let found = null;
          try {
            found = await catalog.songRelease(asked.artist, asked.title, AbortSignal.timeout(60_000));
          } catch {
            continue; // The catalog is unreachable or busy: try this song next time.
          }
          // The song may have been deleted or renamed while we asked.
          const now = songs.find(song.id);
          if (!now || now.title !== asked.title || now.artist !== asked.artist) continue;
          const extra = { "release.checkedAt": Date.now(), ...(found ? { "release.date": found.released, "release.album": found.album } : {}) };
          await songs.update(song.id, { extra }).catch(() => undefined);
        }
      } while (backfillAgain);
    } finally {
      backfilling = false;
    }
  }
  let backfillTimer = null;
  /** Runs the backfill shortly; several requests in a row share one run. */
  const scheduleBackfill = () => {
    backfillTimer ??= setTimeout(() => {
      backfillTimer = null;
      void backfillReleases().catch((error) => console.error("[slopify] release dates:", error));
    }, 3000).unref();
  };
  scheduleBackfill();
  setInterval(scheduleBackfill, 6 * 3_600_000).unref();

  async function resolve(req, res) {
    const body = await readJSON(req);
    const source = String(body.source || "").trim();
    const mediaKind = body.mediaKind === "video" ? "video" : "audio";
    const stream = ndjson(res);
    // The next page of a search the user is scrolling through.
    if (typeof body.more === "string") {
      try {
        stream.finish({ ok: true, result: await searchMorePlatforms(body.more, stream.signal) });
      } catch (error) {
        stream.finish({ ok: false, error: failure(error, "searching_candidates") });
      }
      return;
    }
    if (!source) {
      stream.finish({ ok: false, error: { stage: "resolving_metadata", code: "MISSING_SOURCE", message: "Enter a song, artist, album, or a Spotify, SoundCloud, or YouTube link first." } });
      return;
    }
    const link = looksLikeLink(source);
    stream.progress({ stage: link ? "resolving_metadata" : "searching_candidates" });
    try {
      const result = link
        ? await resolveLocalImportSource(source, stream.signal, stream.progress, {}, { mediaKind })
        : await searchAllPlatforms(source, stream.signal, fetch, { mediaKind });
      stream.finish({ ok: true, result });
    } catch (error) {
      stream.finish({ ok: false, error: failure(error, "resolving_metadata") });
    }
  }

  /**
   * Saves a song from the web: the server records its source link and details,
   * and keeps the file it fetched only briefly, for this device to take its own copy.
   */
  async function startImport(req, res) {
    const body = await readJSON(req);
    await songs.load();
    const stream = ndjson(res);
    const mediaKind = body.mediaKind === "video" ? "video" : "audio";
    const sourceURL = String(body.sourceURL || "");
    let temp = null;
    try {
      // Already saved from this link: nothing to fetch.
      const known = songs.findBySource(sourceURL, body.sourceIdentity, mediaKind);
      if (known) {
        stream.progress({ stage: "local_complete", duplicate: true });
        stream.finish({ ok: true, result: { kind: "duplicate", track: songs.publicSong(known) } });
        return;
      }
      temp = await fs.mkdtemp(path.join(os.tmpdir(), "slopify-save-"));
      const result = await importConfirmedSource({
        sourceURL,
        sourceIdentity: body.sourceIdentity,
        mediaKind,
        metadata: body.metadata && typeof body.metadata === "object" ? body.metadata : {},
        existing: songs.songs.filter((s) => s.savedAs === mediaKind),
        destinationDirectory: temp,
        temporaryRoot: os.tmpdir(),
      }, stream.signal, stream.progress);

      if (result.kind === "duplicate") {
        stream.progress({ stage: "local_complete", duplicate: true });
        stream.finish({ ok: true, result: { kind: "duplicate", track: songs.publicSong(result.track) } });
        return;
      }

      const id = randomUUID();
      const artworkFile = await saveDataArtwork(id, result.artwork);
      const remoteArtwork = typeof result.metadata.artworkURL === "string" && result.metadata.artworkURL.startsWith("https://") ? result.metadata.artworkURL : null;
      const probed = await probeDuration(result.filePath);
      if (stream.signal.aborted) throw new DOMException("Import cancelled", "AbortError");
      const requested = Number(body.durationSeconds);
      const song = await songs.add({
        id,
        addedAt: Date.now(),
        updatedAt: Date.now(),
        title: result.metadata.title,
        artist: result.metadata.artist,
        album: result.metadata.album,
        durationSeconds: probed || (Number.isFinite(requested) && requested > 0 ? requested : null),
        savedAs: mediaKind,
        sourceURL: result.sourceURL || sourceURL || null,
        sourceIdentity: result.sourceIdentity || null,
        sourceSha256: result.sourceSha256 || null,
        contentSha256: result.contentSha256 || null,
        artworkUrl: artworkFile ? null : remoteArtwork,
        artworkFile,
        clip: null,
        // The app reads an upload's artist from its title before saving, so the
        // one-time correction of older songs (importer.ts) leaves this one alone.
        extra: { "credit.checked": 1 },
        legacyFile: null,
      });
      await songFiles.adopt(id, { filePath: result.filePath, size: result.size, sha256: result.contentSha256 });
      stream.progress({ stage: "local_complete" });
      stream.finish({ ok: true, result: { kind: "created", track: songs.publicSong(song) } });
      scheduleBackfill();
    } catch (error) {
      stream.finish({ ok: false, error: failure(error, "inspecting_source") });
    } finally {
      if (temp) await fs.rm(temp, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  /** Video saves bring their cover as a data URL; it is kept as a small image file. Other covers stay links. */
  async function saveDataArtwork(id, artwork) {
    if (!artwork?.startsWith("data:")) return null;
    const [, type, b64] = /^data:([^;]+);base64,(.*)$/.exec(artwork) ?? [];
    const ext = Object.entries(IMAGE_TYPES).find(([, t]) => t === type)?.[0];
    if (!ext || !b64) return null;
    const file = `${id}${ext}`;
    await fs.writeFile(path.join(songs.artworkDir, file), Buffer.from(b64, "base64"));
    return file;
  }

  /** Serves a song's audio (or video) for a device to play or keep: its old stored file if it still has one, else a temporary copy from its source. */
  async function sendSongFile(req, res, song) {
    const legacy = songs.legacyPath(song);
    if (legacy) {
      const sha256 = song.contentSha256;
      return sendFile(req, res, legacy, MEDIA_TYPES[path.extname(legacy).toLowerCase()] || "application/octet-stream", sha256 ? { "X-Content-SHA256": sha256 } : {});
    }
    const file = await songFiles.get(song);
    const headers = file.sha256 ? { "X-Content-SHA256": file.sha256 } : {};
    return sendFile(req, res, file.filePath, MEDIA_TYPES[path.extname(file.filePath).toLowerCase()] || "application/octet-stream", headers);
  }

  async function preview(req, res) {
    const body = await readJSON(req);
    const controller = new AbortController();
    res.on("close", () => {
      if (!res.writableFinished) controller.abort(new DOMException("Preview stopped", "AbortError"));
    });
    try {
      const { token, durationSeconds } = await previews.create(String(body.sourceURL || ""), controller.signal, body.mediaKind === "video" ? "video" : "audio");
      sendJSON(res, 200, { ok: true, result: { url: `/api/import/preview/${token}`, durationSeconds } });
    } catch (error) {
      if (error?.name === "AbortError") {
        if (!res.destroyed) sendJSON(res, 200, { ok: false, error: { stage: "previewing", code: "CANCELLED", message: "Preview stopped." } });
        return;
      }
      sendJSON(res, 200, { ok: false, error: failure(error, "previewing") });
    }
  }

  return async function handle(req, res, next) {
    const url = new URL(req.url || "/", "http://localhost");
    if (!url.pathname.startsWith("/api/")) return next();
    const parts = url.pathname.split("/").filter(Boolean).slice(1);
    const method = req.method || "GET";
    // Only Slopify's own pages may change the library: any website could otherwise post
    // here from the browser (a plain form or text/plain fetch needs no CORS permission).
    if (!["GET", "HEAD", "OPTIONS"].includes(method) && crossSite(req)) {
      return sendJSON(res, 403, { ok: false, error: { code: "FORBIDDEN", message: "Requests from other websites aren't allowed." } });
    }
    try {
      if (parts[0] === "health" && method === "GET") {
        return sendJSON(res, 200, { ok: true, import: true, ffmpeg: Boolean(ffmpegPath()) });
      }
      if (parts[0] === "metadata" && parts[1] === "artist" && parts.length === 2 && method === "POST") {
        const result = await artists.profile(await readJSON(req));
        if (!res.destroyed) sendJSON(res, 200, { ok: true, result });
        return;
      }
      if (parts[0] === "metadata" && parts[1] === "artists" && parts.length === 2 && method === "POST") {
        const body = await readJSON(req);
        const controller = new AbortController();
        const closed = () => { if (!res.writableFinished) controller.abort(); };
        res.on("close", closed);
        try {
          const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(20_000)]);
          const found = await artists.search(body, signal);
          // TheAudioDB has pictures for few artists; the music catalog fills in the rest. Only the
          // first artist of each name gets one, since a second "Nirvana" is someone else.
          const named = new Set();
          const unpictured = found.artists.filter((a) => {
            const first = !named.has(a.name.toLowerCase());
            named.add(a.name.toLowerCase());
            return first && !a.image;
          });
          const { pictures } = unpictured.length
            ? await catalog.artistPictures({ artists: unpictured.map((a) => a.name) }, AbortSignal.any([signal, AbortSignal.timeout(8_000)])).catch(() => ({ pictures: {} }))
            : { pictures: {} };
          const result = { ...found, artists: found.artists.map((a) => (unpictured.includes(a) && pictures[a.name] ? { ...a, image: pictures[a.name] } : a)) };
          if (!res.destroyed) sendJSON(res, 200, { ok: true, result });
        } finally { res.off("close", closed); }
        return;
      }
      // Release Radar and Albums for you: what artists have released, and album tracklists.
      if (parts[0] === "catalog" && parts[1] === "releases" && parts.length === 2 && method === "POST") {
        const body = await readJSON(req);
        const controller = new AbortController();
        const closed = () => { if (!res.writableFinished) controller.abort(); };
        res.on("close", closed);
        try {
          const result = await catalog.artistReleases(body, AbortSignal.any([controller.signal, AbortSignal.timeout(60_000)]));
          if (!res.destroyed) sendJSON(res, 200, { ok: true, result });
        } finally { res.off("close", closed); }
        return;
      }
      if (parts[0] === "catalog" && parts[1] === "pictures" && parts.length === 2 && method === "POST") {
        const result = await catalog.artistPictures(await readJSON(req), AbortSignal.timeout(30_000));
        return sendJSON(res, 200, { ok: true, result });
      }
      if (parts[0] === "catalog" && parts[1] === "album" && parts.length === 3 && method === "GET") {
        const result = await catalog.album(parts[2], AbortSignal.timeout(20_000));
        return sendJSON(res, 200, { ok: true, result });
      }
      if (parts[0] === "recommendations" && parts[1] === "related" && parts.length === 2 && method === "POST") {
        const body = await readJSON(req);
        // Stop asking upstream services once the browser gives up on the answer.
        const controller = new AbortController();
        const closed = () => { if (!res.writableFinished) controller.abort(); };
        res.on("close", closed);
        try {
          const result = await recommendations.related(body, controller.signal);
          if (!res.destroyed) sendJSON(res, 200, { ok: true, result });
        } finally {
          res.off("close", closed);
        }
        return;
      }
      if (parts[0] === "songs" && parts.length === 1 && method === "GET") {
        await songs.load();
        // playableURL: the YouTube or SoundCloud page the audio comes from, so another
        // music server (through a Slopify account) can play the song too.
        return sendJSON(res, 200, { ok: true, songs: songs.songs.map((s) => ({ ...songs.publicSong(s), playableURL: downloadLink(s) })) });
      }
      if (parts[0] === "songs" && parts.length >= 2 && ID.test(parts[1])) {
        const id = parts[1];
        await songs.load();
        const song = songs.find(id);
        // A song from your Slopify account, saved on another computer: added here with the same
        // id (so playlists match) as a link only. Its audio is fetched when something plays it.
        if (!song && parts.length === 2 && method === "PUT") {
          const created = await songs.adopt(id, await readJSON(req));
          scheduleBackfill();
          return sendJSON(res, 200, { ok: true, song: { ...songs.publicSong(created), playableURL: downloadLink(created) } });
        }
        if (!song) return sendJSON(res, 404, { ok: false, error: { code: "NOT_FOUND", message: "No such song." } });
        if (parts.length === 2 && method === "PATCH") {
          const savedAs = song.savedAs;
          const named = [song.title, song.artist];
          const updated = await songs.update(id, await readJSON(req));
          if (updated.savedAs !== savedAs) await songFiles.drop(id);
          // A renamed song may be a different release: look it up again.
          if (updated.title !== named[0] || updated.artist !== named[1]) {
            await songs.update(id, { extra: { "release.date": null, "release.album": null, "release.checkedAt": null } });
            scheduleBackfill();
          }
          return sendJSON(res, 200, { ok: true, song: songs.publicSong(updated) });
        }
        if (parts.length === 2 && method === "DELETE") {
          await songs.remove(id);
          await songFiles.drop(id);
          return sendJSON(res, 200, { ok: true });
        }
        if (parts.length === 3 && parts[2] === "file" && (method === "GET" || method === "HEAD")) return await sendSongFile(req, res, song);
        // The device has verified its own copy: the server's copies can go.
        if (parts.length === 3 && parts[2] === "release" && method === "POST") {
          await songs.release(id);
          await songFiles.drop(id);
          return sendJSON(res, 200, { ok: true });
        }
      }
      // Playlists, likes, history and settings shared by every browser using this server.
      // The Slopify account this computer's library syncs with (one at a time), so
      // signing in with another account never mixes two people's music.
      // The disk the library is on: its real size and free space, for the Storage page.
      if (parts[0] === "storage" && parts[1] === "disk" && parts.length === 2 && method === "GET") {
        await fs.mkdir(dataDir, { recursive: true });
        const disk = await fs.statfs(dataDir);
        return sendJSON(res, 200, { ok: true, result: { total: disk.blocks * disk.bsize, free: disk.bavail * disk.bsize } });
      }
      if (parts[0] === "cloud-link" && parts.length === 1) {
        const file = path.join(dataDir, "cloud-link.json");
        if (method === "GET") {
          const link = await fs.readFile(file, "utf8").then(JSON.parse).catch(() => null);
          return sendJSON(res, 200, { ok: true, link: link?.userId ? link : null });
        }
        if (method === "PUT") {
          const body = await readJSON(req);
          const userId = typeof body?.userId === "string" && body.userId.length <= 200 ? body.userId : null;
          if (!userId) return sendJSON(res, 400, { ok: false, error: { code: "BAD_LINK", message: "Send the account's userId." } });
          const current = await fs.readFile(file, "utf8").then(JSON.parse).catch(() => null);
          // Linking to another account must be asked for explicitly.
          if (current?.userId && current.userId !== userId && body.replace !== true) {
            return sendJSON(res, 409, { ok: false, link: current, error: { code: "LINKED_ELSEWHERE", message: "This computer's library belongs to another account." } });
          }
          const link = { userId, name: typeof body.name === "string" ? body.name.slice(0, 100) : null, email: typeof body.email === "string" ? body.email.slice(0, 200) : null, linkedAt: Date.now() };
          await fs.mkdir(dataDir, { recursive: true });
          await fs.writeFile(file, JSON.stringify(link, null, 2));
          return sendJSON(res, 200, { ok: true, link });
        }
      }
      if (parts[0] === "state" && parts.length === 1 && method === "GET") {
        return sendJSON(res, 200, { ok: true, ...(await libraryState.get()) });
      }
      if (parts[0] === "state" && parts.length === 1 && method === "PUT") {
        const body = await readLargeJSON(req);
        if (!Number.isSafeInteger(body?.baseRev) || typeof body.data !== "object" || !body.data) {
          return sendJSON(res, 400, { ok: false, error: { code: "BAD_STATE", message: "Send baseRev and data." } });
        }
        const { conflict, doc } = await libraryState.put(body.baseRev, body.data);
        return sendJSON(res, conflict ? 409 : 200, { ok: !conflict, ...doc });
      }
      if (parts[0] === "artwork" && parts.length === 2 && ID.test(parts[1]) && method === "GET") {
        await songs.load();
        const song = songs.find(parts[1]);
        if (!song?.artworkFile) return res.writeHead(404).end();
        const file = path.join(songs.artworkDir, path.basename(song.artworkFile));
        return await sendFile(req, res, file, IMAGE_TYPES[path.extname(file).toLowerCase()] || "application/octet-stream");
      }
      if (parts[0] === "import") {
        if (parts[1] === "protect" && parts.length === 2 && method === "POST") {
          const { tokens } = await readJSON(req);
          const valid = Array.isArray(tokens) && tokens.length <= 2 && tokens.every((token) => typeof token === "string" && /^[a-f0-9]{32}$/.test(token));
          if (!valid) return sendJSON(res, 400, { ok: false });
          previews.protect(tokens);
          return sendJSON(res, 200, { ok: true });
        }
        if (parts[1] === "resolve" && method === "POST") return await resolve(req, res);
        if (parts[1] === "start" && method === "POST") return await startImport(req, res);
        if (parts[1] === "preview" && parts.length === 2 && method === "POST") return await preview(req, res);
        if (parts[1] === "preview" && parts.length === 3 && /^[a-f0-9]{32}$/.test(parts[2]) && (method === "GET" || method === "HEAD")) {
          const item = previews.items.get(parts[2]);
          if (!item) return res.writeHead(404).end();
          // HEAD answers whether a preview is still on disk, without sending it.
          if (method === "HEAD") {
            await fs.access(item.filePath);
            return res.writeHead(200, { "Content-Type": item.contentType }).end();
          }
          return await sendFile(req, res, item.filePath, item.contentType);
        }
      }
      sendJSON(res, 404, { ok: false, error: { code: "NOT_FOUND", message: "Unknown API route." } });
    } catch (error) {
      // The browser left (a reload, or a request it no longer needs): nothing went wrong.
      if (res.headersSent || error?.name === "AbortError" || res.destroyed) {
        res.end();
        return;
      }
      const status = error?.status || 500;
      // Unexpected failures go to the server log, so their cause can be found later.
      if (status >= 500) console.error(`[slopify] ${method} ${url.pathname} failed:`, error);
      sendJSON(res, status, { ok: false, error: { code: "SERVER_ERROR", message: error?.message || "Server error." } });
    }
  };
}

/** Vite plugin that mounts the import API on the dev and preview servers. */
export function slopifyApi(options = {}) {
  let handler = null;
  const mount = (server) => {
    // Chosen when a server starts, not when the config loads, so `vite build` never touches the library.
    const chosen = options.dataDir || process.env.SLOPIFY_DATA_DIR;
    handler ??= createImportApi({ dataDir: chosen ? path.resolve(chosen) : checkoutDataDir(fileURLToPath(new URL("../", import.meta.url))) });
    server.middlewares.use((req, res, next) => {
      handler(req, res, next).catch(next);
    });
  };
  return {
    name: "slopify-import-api",
    configureServer: mount,
    configurePreviewServer: mount,
  };
}
