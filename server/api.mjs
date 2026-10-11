// Slopify import API. Runs inside the Vite dev/preview server (see vite.config.ts)
// and exposes the Resonance provider modules in ./providers over HTTP.
import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import fs from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

const require = createRequire(import.meta.url);
const { LocalImportError } = require("./providers/local-import-core.cjs");
const { fetchArtwork, importConfirmedSource, resolveLocalImportSource } = require("./providers/local-import-platform.cjs");
const { looksLikeLink, searchAllPlatforms } = require("./providers/local-search.cjs");
const { downloadResolvedAudio, resolveYouTubeAudio } = require("./providers/local-youtube.cjs");
const { downloadResolvedSoundCloudAudio, isSoundCloudURL, resolveSoundCloudAudio } = require("./providers/local-soundcloud.cjs");

const MAX_BODY_BYTES = 256 * 1024;
const MAX_PREVIEW_BYTES = 32 * 1024 * 1024;
const PREVIEW_SECONDS = 30;
const ID = /^[A-Za-z0-9-]{8,64}$/;
const MEDIA_TYPES = { ".m4a": "audio/mp4", ".mp3": "audio/mpeg", ".mp4": "video/mp4" };
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

/** Serves a file with HTTP Range support so the player can seek. */
async function sendFile(req, res, filePath, contentType) {
  let info;
  try {
    info = await fs.stat(filePath);
  } catch {
    res.writeHead(404).end();
    return;
  }
  const total = info.size;
  const headers = { "Content-Type": contentType, "Accept-Ranges": "bytes", "Cache-Control": "no-cache" };
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
    createReadStream(filePath, { start, end }).pipe(res);
    return;
  }
  res.writeHead(200, { ...headers, "Content-Length": total });
  if (req.method === "HEAD") return res.end();
  createReadStream(filePath).pipe(res);
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

class Library {
  constructor(dataDir) {
    this.dir = dataDir;
    this.mediaDir = path.join(dataDir, "media");
    this.artworkDir = path.join(dataDir, "artwork");
    this.file = path.join(dataDir, "library.json");
    this.tracks = null;
    this.writing = Promise.resolve();
  }

  async load() {
    if (this.tracks) return this.tracks;
    await fs.mkdir(this.mediaDir, { recursive: true });
    await fs.mkdir(this.artworkDir, { recursive: true });
    try {
      const parsed = JSON.parse(await fs.readFile(this.file, "utf8"));
      this.tracks = Array.isArray(parsed?.tracks) ? parsed.tracks : [];
    } catch {
      this.tracks = [];
    }
    return this.tracks;
  }

  save() {
    // Serialize writes and replace atomically so a crash never leaves half a file.
    this.writing = this.writing.then(async () => {
      const temp = `${this.file}.${process.pid}.tmp`;
      await fs.writeFile(temp, JSON.stringify({ version: 1, tracks: this.tracks }, null, 2));
      await fs.rename(temp, this.file);
    });
    return this.writing;
  }

  find(id) {
    return this.tracks?.find((t) => t.id === id) ?? null;
  }

  publicTrack(t) {
    return {
      id: t.id,
      title: t.title,
      artist: t.artist,
      album: t.album,
      durationSeconds: t.durationSeconds,
      mediaKind: t.mediaKind,
      size: t.size,
      addedAt: t.addedAt,
      sourceURL: t.sourceURL,
      mediaUrl: `/api/media/${t.id}`,
      artworkUrl: t.artwork ? `/api/artwork/${t.id}` : null,
    };
  }
}

/** Short-lived preview files for the "listen before you import" buttons. */
class Previews {
  constructor() {
    this.dir = null;
    this.items = new Map();
  }

  async directory() {
    if (!this.dir) this.dir = await fs.mkdtemp(path.join(os.tmpdir(), "slopify-preview-"));
    return this.dir;
  }

  async create(sourceURL, signal) {
    const key = createHash("sha256").update(sourceURL).digest("hex").slice(0, 32);
    const cached = this.items.get(key);
    if (cached) {
      try {
        await fs.access(cached.filePath);
        return { token: key, durationSeconds: cached.durationSeconds };
      } catch {
        this.items.delete(key);
      }
    }
    const soundCloud = isSoundCloudURL(sourceURL);
    const resolved = soundCloud ? await resolveSoundCloudAudio(sourceURL, signal) : await resolveYouTubeAudio(sourceURL, signal);
    if (resolved.contentLength > MAX_PREVIEW_BYTES) {
      throw new LocalImportError("previewing", "PREVIEW_TOO_LARGE", "This source is too large to preview. You can still select and import it.");
    }
    const filePath = path.join(await this.directory(), `${key}${soundCloud ? ".mp3" : ".m4a"}`);
    await fs.rm(filePath, { force: true });
    if (soundCloud) await downloadResolvedSoundCloudAudio(resolved, filePath, signal);
    else await downloadResolvedAudio(resolved, filePath, signal);
    const durationSeconds = Math.min(PREVIEW_SECONDS, resolved.durationSeconds || PREVIEW_SECONDS);
    this.items.set(key, { filePath, durationSeconds, contentType: soundCloud ? "audio/mpeg" : "audio/mp4" });
    // Keep only a handful of previews on disk.
    for (const [k, v] of [...this.items].slice(0, Math.max(0, this.items.size - 6))) {
      this.items.delete(k);
      await fs.rm(v.filePath, { force: true }).catch(() => undefined);
    }
    return { token: key, durationSeconds };
  }
}

export function createImportApi({ dataDir }) {
  const library = new Library(dataDir);
  const previews = new Previews();

  async function resolve(req, res) {
    const body = await readJSON(req);
    const source = String(body.source || "").trim();
    const mediaKind = body.mediaKind === "video" ? "video" : "audio";
    const stream = ndjson(res);
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

  async function startImport(req, res) {
    const body = await readJSON(req);
    const tracks = await library.load();
    const stream = ndjson(res);
    const mediaKind = body.mediaKind === "video" ? "video" : "audio";
    try {
      const result = await importConfirmedSource({
        sourceURL: String(body.sourceURL || ""),
        sourceIdentity: body.sourceIdentity,
        mediaKind,
        metadata: body.metadata && typeof body.metadata === "object" ? body.metadata : {},
        existing: tracks,
        destinationDirectory: library.mediaDir,
        temporaryRoot: os.tmpdir(),
      }, stream.signal, stream.progress);

      if (result.kind === "duplicate") {
        stream.progress({ stage: "local_complete", duplicate: true });
        stream.finish({ ok: true, result: { kind: "duplicate", track: library.publicTrack(result.track) } });
        return;
      }

      const id = randomUUID();
      let artwork = null;
      try {
        if (result.artwork?.startsWith("data:")) {
          // Video imports return their cover as a data URL.
          const [, type, b64] = /^data:([^;]+);base64,(.*)$/.exec(result.artwork) ?? [];
          const ext = Object.entries(IMAGE_TYPES).find(([, t]) => t === type)?.[0];
          if (ext && b64) {
            artwork = `${id}${ext}`;
            await fs.writeFile(path.join(library.artworkDir, artwork), Buffer.from(b64, "base64"));
          }
        } else if (result.metadata.artworkURL) {
          const temp = await fs.mkdtemp(path.join(os.tmpdir(), "slopify-art-"));
          try {
            const cover = await fetchArtwork(result.metadata.artworkURL, temp, stream.signal);
            if (cover) {
              artwork = `${id}${path.extname(cover).toLowerCase()}`;
              await fs.copyFile(cover, path.join(library.artworkDir, artwork));
            }
          } finally {
            await fs.rm(temp, { recursive: true, force: true }).catch(() => undefined);
          }
        }
      } catch (error) {
        if (error?.name === "AbortError") throw error;
        artwork = null;
      }

      const probed = await probeDuration(result.filePath);
      const requested = Number(body.durationSeconds);
      const track = {
        id,
        title: result.metadata.title,
        artist: result.metadata.artist,
        album: result.metadata.album,
        durationSeconds: probed || (Number.isFinite(requested) && requested > 0 ? requested : null),
        mediaKind,
        file: path.basename(result.filePath),
        size: result.size,
        artwork,
        addedAt: Date.now(),
        sourceURL: result.sourceURL || body.sourceURL || null,
        sourceIdentity: result.sourceIdentity || null,
        sourceSha256: result.sourceSha256 || null,
        contentSha256: result.contentSha256 || null,
      };
      tracks.unshift(track);
      await library.save();
      stream.progress({ stage: "local_complete" });
      stream.finish({ ok: true, result: { kind: "created", track: library.publicTrack(track) } });
    } catch (error) {
      stream.finish({ ok: false, error: failure(error, "inspecting_source") });
    }
  }

  async function preview(req, res) {
    const body = await readJSON(req);
    const controller = new AbortController();
    res.on("close", () => {
      if (!res.writableFinished) controller.abort(new DOMException("Preview stopped", "AbortError"));
    });
    try {
      const { token, durationSeconds } = await previews.create(String(body.sourceURL || ""), controller.signal);
      sendJSON(res, 200, { ok: true, result: { url: `/api/import/preview/${token}`, durationSeconds } });
    } catch (error) {
      if (error?.name === "AbortError") {
        if (!res.destroyed) sendJSON(res, 200, { ok: false, error: { stage: "previewing", code: "CANCELLED", message: "Preview stopped." } });
        return;
      }
      sendJSON(res, 200, { ok: false, error: failure(error, "previewing") });
    }
  }

  async function remove(res, id) {
    const tracks = await library.load();
    const index = tracks.findIndex((t) => t.id === id);
    if (index < 0) return sendJSON(res, 404, { ok: false });
    const [track] = tracks.splice(index, 1);
    await library.save();
    await fs.rm(path.join(library.mediaDir, path.basename(track.file)), { force: true }).catch(() => undefined);
    if (track.artwork) await fs.rm(path.join(library.artworkDir, path.basename(track.artwork)), { force: true }).catch(() => undefined);
    sendJSON(res, 200, { ok: true });
  }

  return async function handle(req, res, next) {
    const url = new URL(req.url || "/", "http://localhost");
    if (!url.pathname.startsWith("/api/")) return next();
    const parts = url.pathname.split("/").filter(Boolean).slice(1);
    const method = req.method || "GET";
    try {
      if (parts[0] === "health" && method === "GET") {
        return sendJSON(res, 200, { ok: true, import: true, ffmpeg: Boolean(ffmpegPath()) });
      }
      if (parts[0] === "library" && parts.length === 1 && method === "GET") {
        const tracks = await library.load();
        return sendJSON(res, 200, { ok: true, tracks: tracks.map((t) => library.publicTrack(t)) });
      }
      if (parts[0] === "library" && parts.length === 2 && method === "DELETE" && ID.test(parts[1])) {
        return await remove(res, parts[1]);
      }
      if (parts[0] === "media" && parts.length === 2 && ID.test(parts[1]) && (method === "GET" || method === "HEAD")) {
        await library.load();
        const t = library.find(parts[1]);
        if (!t) return res.writeHead(404).end();
        const file = path.join(library.mediaDir, path.basename(t.file));
        return await sendFile(req, res, file, MEDIA_TYPES[path.extname(file).toLowerCase()] || "application/octet-stream");
      }
      if (parts[0] === "artwork" && parts.length === 2 && ID.test(parts[1]) && method === "GET") {
        await library.load();
        const t = library.find(parts[1]);
        if (!t?.artwork) return res.writeHead(404).end();
        const file = path.join(library.artworkDir, path.basename(t.artwork));
        return await sendFile(req, res, file, IMAGE_TYPES[path.extname(file).toLowerCase()] || "application/octet-stream");
      }
      if (parts[0] === "import") {
        if (parts[1] === "resolve" && method === "POST") return await resolve(req, res);
        if (parts[1] === "start" && method === "POST") return await startImport(req, res);
        if (parts[1] === "preview" && parts.length === 2 && method === "POST") return await preview(req, res);
        if (parts[1] === "preview" && parts.length === 3 && /^[a-f0-9]{32}$/.test(parts[2]) && method === "GET") {
          const item = previews.items.get(parts[2]);
          if (!item) return res.writeHead(404).end();
          return await sendFile(req, res, item.filePath, item.contentType);
        }
      }
      sendJSON(res, 404, { ok: false, error: { code: "NOT_FOUND", message: "Unknown API route." } });
    } catch (error) {
      if (res.headersSent) {
        res.end();
        return;
      }
      sendJSON(res, error?.status || 500, { ok: false, error: { code: "SERVER_ERROR", message: error?.message || "Server error." } });
    }
  };
}

/** Vite plugin that mounts the import API on the dev and preview servers. */
export function slopifyApi(options = {}) {
  const dataDir = path.resolve(options.dataDir || process.env.SLOPIFY_DATA_DIR || "data");
  let handler = null;
  const mount = (server) => {
    handler ??= createImportApi({ dataDir });
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
