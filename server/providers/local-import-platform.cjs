const { createHash, randomUUID } = require("node:crypto");
const { createReadStream } = require("node:fs");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { sanitizeWindowsFilename, windowsCollisionFilename } = require("./filename-policy.cjs");
const { joinMP4 } = require("./mp4-join.cjs");
const { normalizeSourceIdentity } = require("./provenance.cjs");
const {
  LocalImportError,
  isSpotifyURL,
  spotifyPlaylistURL,
  resolveSpotifyPlaylist,
  resolveSpotifyTrack,
  readSpotifyTracks,
  pastedSpotifyTrack,
  pastedLocalTrack,
  pastedSongsIn,
  MAX_PASTED_SONGS,
  resolveYouTubePlaylist,
  normalizeMatchText,
  scoreUnderNames,
  searchYouTubeAudioSources,
  withoutCredit,
  youtubePlaylistID,
  youtubeVideoID,
} = require("./local-import-core.cjs");
const {
  downloadYouTubeAudio,
  downloadYouTubeVideo,
  inspectYouTubeAudio,
  inspectYouTubeVideo,
  preferredYouTubeArtworkURL,
  resolveYouTubeMetadata,
} = require("./local-youtube.cjs");
const {
  directSoundCloudCandidate,
  downloadResolvedSoundCloudAudio,
  downloadSoundCloudAudio,
  isSoundCloudURL,
  resolveSoundCloudAudio,
  resolveSoundCloudSource,
  searchSoundCloudAudioSources,
  soundCloudSourceURL,
} = require("./local-soundcloud.cjs");

const MAX_ARTWORK_BYTES = 10 * 1024 * 1024;
const PREPARED_SOUNDCLOUD_AUDIO_TTL_MS = 30_000;
const ARTWORK_CONTENT_TYPES = new Map([
  ["image/jpeg", ".jpg"],
  ["image/png", ".png"],
  ["image/webp", ".webp"],
  ["image/avif", ".avif"],
]);
const ARTWORK_HOST = /(^|\.)((spotifycdn\.com)|(scdn\.co)|(sndcdn\.com)|(ytimg\.com)|(ggpht\.com))$/i;

function localImportError(stage, code, message) {
  return new LocalImportError(stage, code, message);
}

function normalizedMediaKind(value) {
  return value === "video" ? "video" : "audio";
}

function normalizedSoundCloudPreparationSource(value) {
  const url = soundCloudSourceURL(value);
  url.hash = "";
  return url.toString();
}

function normalizedPreparationMediaKind(value) {
  return value === "audio" || value === "video" ? value : null;
}

function normalizedPreparationContext(value) {
  return typeof value === "string" && value.length > 0 && value.length <= 2_048 && !/[\u0000-\u001f]/.test(value)
    ? value
    : null;
}

// A prepared SoundCloud rendition belongs to one saved-song import only. Keep
// it in the resolution object instead of a process-global cache so it cannot
// cross server/profile operations, and invalidate it after a short window.
function createPreparedSoundCloudAudioHandoff(resolved, {
  source,
  mediaKind,
  preparationContext,
  nowMilliseconds = Date.now(),
} = {}) {
  const sourceKey = normalizedSoundCloudPreparationSource(source);
  const mediaKey = normalizedPreparationMediaKind(mediaKind);
  const contextKey = normalizedPreparationContext(preparationContext);
  if (!mediaKey || !contextKey) {
    throw localImportError("inspecting_source", "INVALID_PREPARATION_CONTEXT", "The prepared SoundCloud download context is invalid.");
  }
  const createdAt = Number.isFinite(nowMilliseconds) ? nowMilliseconds : Date.now();
  const expiresAt = createdAt + PREPARED_SOUNDCLOUD_AUDIO_TTL_MS;
  let prepared = resolved;
  return Object.freeze({
    consume(request = {}) {
      if (!prepared) return null;
      const value = prepared;
      prepared = null;
      let requestedSource;
      try { requestedSource = normalizedSoundCloudPreparationSource(request.source); }
      catch { return null; }
      const requestedAt = Number.isFinite(request.nowMilliseconds) ? request.nowMilliseconds : Date.now();
      if (
        requestedAt > expiresAt
        || requestedSource !== sourceKey
        || normalizedPreparationMediaKind(request.mediaKind) !== mediaKey
        || normalizedPreparationContext(request.preparationContext) !== contextKey
      ) return null;
      return value;
    },
  });
}

function completedSoundCloudDownload(resolved, download) {
  return {
    preview: {
      videoID: `soundcloud:${resolved.track.trackID}`,
      title: resolved.track.title,
      author: resolved.track.artist,
      durationSeconds: resolved.track.durationSeconds,
      thumbnailURL: resolved.track.artworkURL,
      sourceURL: resolved.track.sourceURL,
    },
    mediaSourceURL: resolved.streamingURL,
    download,
  };
}

function abortError(signal) {
  if (signal?.reason instanceof Error) return signal.reason;
  return new DOMException("Import cancelled", "AbortError");
}

function assertNotAborted(signal) {
  if (signal?.aborted) throw abortError(signal);
}

function cleanMetadata(value, fallback = "", maximum = 500) {
  if (typeof value !== "string") return fallback;
  const cleaned = value.replace(/[\u0000-\u001f]+/g, " ").replace(/\s+/g, " ").trim();
  return cleaned ? cleaned.slice(0, maximum) : fallback;
}

function normalizedMetadata(value, fallback = {}) {
  const title = cleanMetadata(value?.title, cleanMetadata(fallback.title, "Untitled"));
  const artist = cleanMetadata(value?.artist, cleanMetadata(fallback.artist, "Unknown Artist"));
  const album = cleanMetadata(value?.album, cleanMetadata(fallback.album)) || null;
  const sourceURL = typeof value?.sourceURL === "string" ? value.sourceURL.slice(0, 8_192) : fallback.sourceURL || null;
  const artworkURL = typeof value?.artworkURL === "string" ? value.artworkURL.slice(0, 2_048) : fallback.artworkURL || null;
  return { title, artist, album, sourceURL, artworkURL };
}

function safeFilename(value) {
  return sanitizeWindowsFilename(value, { pathInput: false });
}

// Slopify: claims the name by creating an empty placeholder (exclusive create), so two
// imports running at once can never choose the same file. The finished file replaces it,
// and importConfirmedSource removes it if the import fails first.
async function uniqueDestination(directory, preferred) {
  const clean = safeFilename(preferred) || `Track-${Date.now()}.m4a`;
  const extension = path.extname(clean) || ".m4a";
  const base = path.basename(clean, path.extname(clean));
  let candidate = path.join(directory, `${base}${extension}`);
  for (let counter = 2; ; counter += 1) {
    try {
      await (await fs.open(candidate, "wx")).close();
      return candidate;
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
    }
    candidate = path.join(directory, windowsCollisionFilename(`${base}${extension}`, counter));
  }
}

async function hashFile(filePath) {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(filePath);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    // Resolve on "close", not "end": on Windows the file can't be moved until its handle is released.
    stream.on("close", () => {
      if (stream.readableEnded) resolve(hash.digest("hex"));
      else reject(new Error("The local file closed before it could be verified."));
    });
  });
}

async function writeAll(file, bytes) {
  let offset = 0;
  while (offset < bytes.length) {
    const { bytesWritten } = await file.write(bytes, offset, bytes.length - offset);
    if (!bytesWritten) throw new Error("The local file could not be written.");
    offset += bytesWritten;
  }
}

function duplicateTrack(existing, sourceSha256, contentSha256 = null) {
  if (!Array.isArray(existing)) return null;
  return existing.find((track) =>
    track && typeof track.id === "string" &&
    (track.sourceSha256 === sourceSha256 ||
      track.contentSha256 === sourceSha256 ||
      (contentSha256 && track.contentSha256 === contentSha256))) || null;
}

function safeArtworkURL(value) {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    if (url.protocol === "https:" && !url.username && !url.password && ARTWORK_HOST.test(url.hostname)) return url;
  } catch {
    // Artwork is optional.
  }
  return null;
}

async function fetchArtwork(value, directory, signal, fetchImpl = fetch) {
  const url = safeArtworkURL(value);
  if (!url) return null;
  let current = url;
  let response = null;
  for (let redirects = 0; redirects <= 5; redirects += 1) {
    try {
      response = await fetchImpl(current, {
        headers: { Accept: "image/avif,image/webp,image/png,image/jpeg" },
        redirect: "manual",
        signal,
      });
    } catch (error) {
      if (error?.name === "AbortError") throw error;
      return null;
    }
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get("location");
      await response.body?.cancel().catch(() => undefined);
      if (!location) return null;
      try { current = new URL(location, current); } catch { return null; }
      if (!safeArtworkURL(current.toString())) return null;
      continue;
    }
    break;
  }
  const finalURL = safeArtworkURL(response?.url || current.toString());
  const contentType = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  const extension = ARTWORK_CONTENT_TYPES.get(contentType);
  const declaredLength = Number(response.headers.get("content-length") || 0);
  if (!response?.ok || !finalURL || !extension || declaredLength > MAX_ARTWORK_BYTES || !response.body) {
    await response?.body?.cancel().catch(() => undefined);
    return null;
  }
  const destination = path.join(directory, `cover${extension}`);
  const file = await fs.open(destination, "wx");
  let total = 0;
  try {
    const reader = response.body.getReader();
    while (true) {
      const { done, value: chunk } = await reader.read();
      if (done) break;
      total += chunk.byteLength;
      if (total > MAX_ARTWORK_BYTES) {
        await reader.cancel().catch(() => undefined);
        throw new Error("Artwork too large");
      }
      await writeAll(file, Buffer.from(chunk));
    }
    if (!total) throw new Error("Artwork was empty");
    return destination;
  } catch (error) {
    await fs.rm(destination, { force: true }).catch(() => undefined);
    if (error?.name === "AbortError") throw error;
    return null;
  } finally {
    await file.close().catch(() => undefined);
  }
}

async function artworkFileDataURL(filePath) {
  if (!filePath) return null;
  const extension = path.extname(filePath).toLowerCase();
  const contentType = [...ARTWORK_CONTENT_TYPES].find((entry) => entry[1] === extension)?.[0] || null;
  if (!contentType) return null;
  const bytes = await fs.readFile(filePath);
  return bytes.length ? `data:${contentType};base64,${bytes.toString("base64")}` : null;
}

function ffmpegExecutable() {
  let executable;
  try { executable = require("ffmpeg-static"); }
  catch {
    throw localImportError("processing", "FFMPEG_UNAVAILABLE", "The local media processor is unavailable in this build.");
  }
  if (typeof executable !== "string" || !executable) {
    throw localImportError("processing", "FFMPEG_UNAVAILABLE", "The local media processor is unavailable in this build.");
  }
  return executable.replace(/app\.asar([\\/])/i, "app.asar.unpacked$1");
}

/** Whether this build has ffmpeg (the iPhone app doesn't). */
function hasFFmpeg() {
  try {
    ffmpegExecutable();
    return true;
  } catch {
    return false;
  }
}

async function runFFmpeg(args, signal) {
  assertNotAborted(signal);
  return new Promise((resolve, reject) => {
    const spawnOptions = { stdio: ["ignore", "ignore", "pipe"] };
    if (process.platform === "win32") spawnOptions.windowsHide = true;
    const child = spawn(ffmpegExecutable(), args, spawnOptions);
    let stderr = "";
    let settled = false;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", cancel);
      callback(value);
    };
    const cancel = () => {
      child.kill("SIGKILL");
      finish(reject, abortError(signal));
    };
    signal?.addEventListener("abort", cancel, { once: true });
    child.stderr.on("data", (chunk) => { stderr = `${stderr}${chunk}`.slice(-8_192); });
    child.on("error", (error) => finish(reject, localImportError("processing", "FFMPEG_START_FAILED", error.message || "The local media processor could not start.")));
    child.on("close", (code) => {
      if (signal?.aborted) return cancel();
      if (code === 0) finish(resolve, true);
      else finish(reject, localImportError("processing", "FFMPEG_FAILED", cleanMetadata(stderr, "The local media processor could not tag this audio.", 1_000)));
    });
  });
}

function m4aTagArguments(input, output, metadata, artwork) {
  const args = ["-y", "-i", input];
  if (artwork) args.push("-i", artwork);
  args.push("-map", "0:a:0");
  if (artwork) args.push("-map", "1:v:0");
  if (path.extname(input).toLowerCase() === ".mp3") args.push("-c:a", "aac", "-b:a", "192k");
  else args.push("-c:a", "copy");
  args.push("-movflags", "+faststart");
  if (artwork) args.push("-c:v", "mjpeg", "-disposition:v:0", "attached_pic");
  args.push("-map_metadata", "-1", "-metadata", `title=${metadata.title}`, "-metadata", `artist=${metadata.artist}`);
  if (metadata.album) args.push("-metadata", `album=${metadata.album}`);
  if (metadata.sourceURL) args.push("-metadata", `comment=Matched from ${metadata.sourceURL}`);
  args.push(output);
  return args;
}

function mp4MuxArguments(video, audio, output, metadata) {
  const args = ["-y", "-i", video, "-i", audio, "-map", "0:v:0", "-map", "1:a:0", "-c", "copy", "-movflags", "+faststart", "-map_metadata", "-1"];
  args.push("-metadata", `title=${metadata.title}`, "-metadata", `artist=${metadata.artist}`);
  if (metadata.album) args.push("-metadata", `album=${metadata.album}`);
  if (metadata.sourceURL) args.push("-metadata", `comment=Downloaded from ${metadata.sourceURL}`);
  args.push(output);
  return args;
}

async function tagM4A(input, output, metadata, artwork, signal) {
  await runFFmpeg(m4aTagArguments(input, output, metadata, artwork), signal);
}

/** Waits before each retry of a move that Windows refused because something briefly held the file. */
const MOVE_RETRY_DELAYS = [100, 250, 500];

async function moveFile(source, destination) {
  for (let attempt = 0; ; attempt++) {
    try {
      await fs.rename(source, destination);
      return;
    } catch (error) {
      // Another drive: rename can't cross devices, so copy instead.
      if (error?.code === "EXDEV") {
        await fs.copyFile(source, destination);
        await fs.rm(source, { force: true });
        return;
      }
      // Windows virus scanners and indexers briefly lock a freshly written file.
      const locked = process.platform === "win32" && (error?.code === "EPERM" || error?.code === "EBUSY");
      if (!locked || attempt >= MOVE_RETRY_DELAYS.length) throw error;
      await new Promise((resolve) => setTimeout(resolve, MOVE_RETRY_DELAYS[attempt]));
    }
  }
}

function directYouTubeMetadata(preview) {
  return {
    provider: "youtube",
    type: "track",
    trackID: preview.videoID,
    title: preview.title,
    artist: preview.author || "Unknown uploader",
    album: null,
    trackNumber: null,
    durationSeconds: preview.durationSeconds,
    artworkURL: preview.thumbnailURL,
    embedURL: null,
    sourceURL: preview.sourceURL,
  };
}

function publicSoundCloudMetadata(track) {
  const { directlyImportable: _directlyImportable, ...metadata } = track;
  return metadata;
}

/*
 * Playlist songs are matched to YouTube uploads by searching YouTube for each one. YouTube turns away a burst of
 * searches from one computer (about a dozen within a few seconds) for about a minute; one every 2.5 seconds stays
 * clear of that (measured Nov 2026). So playlist searches take turns at that pace, shared by every playlist being
 * matched, and a search YouTube turns away waits and is asked again rather than losing the song. Every song stays
 * listed: one that couldn't be matched says why, and one already in the library isn't searched for at all.
 */
const PLAYLIST_SEARCH_GAP_MS = 2_500;
/** How long a turned-away search waits before each retry. */
const PLAYLIST_SEARCH_BACKOFF_MS = [15_000, 30_000, 60_000];
/** Songs in a row whose every retry was turned away before the rest are left unsearched (YouTube isn't letting up). */
const PLAYLIST_SEARCH_GIVE_UP_AFTER = 2;
let nextPlaylistSearchAt = 0;

function pause(ms, signal) {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", stop);
      resolve();
    }, ms);
    const stop = () => {
      clearTimeout(timer);
      reject(abortError(signal));
    };
    if (signal?.aborted) stop();
    else signal?.addEventListener("abort", stop, { once: true });
  });
}

/** SoundCloud searches' own pace: a separate service, so they don't wait on YouTube's. */
const SOUNDCLOUD_SEARCH_GAP_MS = 1_200;
const SOUNDCLOUD_SEARCH_BACKOFF_MS = [10_000, 30_000];
/** How long the reading of pasted songs must have given no quick search to do before broader searches go on meanwhile. */
const HEAVY_AFTER_IDLE_MS = 5_000;
/** How long YouTube's search waits for SoundCloud's to reach a song before searching it anyway. */
const SOUNDCLOUD_HEAD_START_MS = 4_000;
let nextSoundCloudSearchAt = 0;

async function soundCloudSearchTurn(signal, gap) {
  const now = Date.now();
  const at = Math.max(now, nextSoundCloudSearchAt);
  nextSoundCloudSearchAt = at + gap;
  await pause(at - now, signal);
}

/** Waits for this search's turn: `gap` after the one before it, across all playlists. */
async function playlistSearchTurn(signal, gap) {
  const now = Date.now();
  const at = Math.max(now, nextPlaylistSearchAt);
  nextPlaylistSearchAt = at + gap;
  await pause(at - now, signal);
}

/**
 * A playlist's rows, in its order: `entries` are `{ track, ready }`, where `ready` is a row needing no search (a
 * direct SoundCloud stream). Others are searched for, unless `ownedSong(track)` names a library song that already is
 * this one (the row then carries its `ownedSongId`), or `matchCache.get(track)` remembers its row from a recent
 * search (`matchCache.set` is told each new one). A song not found is searched once more, broadly. A row nothing
 * matched has no `sourceURL` and says `unmatched`: "not_found" (YouTube answered, nothing fit) or "search_failed"
 * (YouTube kept turning the search away; not remembered, so it's searched again next time).
 *
 * `onStage` hears `preview(rows)` before the first search (every song, unmatched ones still `pending`), each row as
 * it settles (`row: { at, candidate }`), and `waitingSeconds` while a turned-away search waits.
 *
 * `listen(track, links, { signal })` (preview-check.mjs's listenForMatch) hears the songs matched by artist and
 * length alone, alongside the searches: a match that sounds like the song is kept as sure, one that surely doesn't is
 * dropped. Each verdict is remembered with the match, so a song is listened to once (an unsure one again when
 * LISTEN_VERSION goes up).
 */
/**
 * Raised when listening improves (2: Deezer's own spelling of an artist's name is found and searched under; 3: songs
 * not found, or matched by length and not confirmed, have the search's other uploads of about their length listened
 * to; 4: uploads heard not to be the song aren't kept as fallbacks, and a Deezer track found under a suggested
 * spelling of the artist can't rule a match out). Songs settled before it are looked at again: unsure ones listened
 * to again, not found ones (those ruled out by ear included) searched again, and ones confirmed by ear keep no
 * fallback that may have been heard and rejected; 5: matches by name are scored again under the whole-word title
 * rules, and those whose titles only half agree are listened to).
 */
const LISTEN_VERSION = 5;
async function matchPlaylistRows(entries, { signal, onStage, search, searchSoundCloud, ownedSong, matchCache, preview, read, listen, pace = {} }) {
  const gap = pace.gapMs ?? PLAYLIST_SEARCH_GAP_MS;
  const backoff = pace.backoffMs ?? PLAYLIST_SEARCH_BACKOFF_MS;
  const soundCloudGap = pace.soundCloudGapMs ?? SOUNDCLOUD_SEARCH_GAP_MS;
  const soundCloudBackoff = pace.soundCloudBackoffMs ?? SOUNDCLOUD_SEARCH_BACKOFF_MS;
  const base = (track) => ({ importMetadata: track, playlistIndex: track.trackNumber });
  /** A match by the artist's upload of the same length alone (see ownUploadByLength), to be listened to. */
  const lengthOnly = (row) => Boolean(row?.match?.byArtistAndLength && typeof row.sourceURL === "string");
  /**
   * A match by name whose title only half agrees ("Maybe Mine" for "Be Mine": one word of two): taken, but listened
   * to as well, so a different song by the same artist is caught rather than saved.
   */
  const WEAK_TITLE = 0.75;
  const weakName = (row) => typeof row?.sourceURL === "string" && !row.match?.byArtistAndLength && typeof row.match?.title === "number" && row.match.title < WEAK_TITLE;
  /** A match to listen to: by length alone, or by a title that only half agrees. */
  const toVerify = (row) => lengthOnly(row) || weakName(row);
  /** A song not found whose search had uploads of about its length the names couldn't settle, to be listened to. */
  const rescuable = (row) => row?.unmatched === "not_found" && Array.isArray(row.nearby) && row.nearby.length > 0;
  /*
   * An upload naming another song of this playlist besides its own ("Fumble & Munchkin" for Fumble!, when the
   * playlist has Munchkin too) is a mashup of the two, not the song. Songs' titles are known before they're searched
   * (pasted songs' as each is read), so such uploads are left out as each song settles (before a save following the
   * matching takes them), remembered ones included.
   */
  const compactTitle = (title) => normalizeMatchText(withoutCredit(title || "")).replace(/ /g, "");
  const playlistTitles = new Set();
  const noteTitle = (track) => {
    const title = compactTitle(track.title);
    if (title.length >= 5) playlistTitles.add(title);
  };
  for (const { track, unread } of entries) if (!unread) noteTitle(track);
  const namesAnotherSong = (track, candidate) => {
    const own = compactTitle(track.title);
    const upload = normalizeMatchText(candidate.title || "").replace(/ /g, "");
    for (const title of playlistTitles) if (title !== own && !own.includes(title) && upload.includes(title)) return true;
    return false;
  };
  /** A remembered match by name (YouTube's or SoundCloud's: one scorer), scored by the current rules: null if they turn it down. */
  const rescored = (track, known) => {
    if (typeof known.sourceURL !== "string") return known;
    const again = (c) => {
      const scored = scoreUnderNames(track, c);
      return scored ? { ...c, score: scored.score, match: { ...c.match, ...scored.match } } : null;
    };
    const row = again(known);
    if (!row) return null;
    return { ...row, fallbackCandidates: (known.fallbackCandidates || []).map(again).filter(Boolean) };
  };
  /** A song's row before any search: already in the library, remembered from a recent search, or to be searched. */
  const startRow = (track) => {
    let owned = null;
    try { owned = ownedSong?.(track) || null; } catch { owned = null; }
    if (owned) return { ...base(track), ownedSongId: owned };
    // A song matched (or found missing) recently needn't be searched for again.
    let known = null;
    try { known = matchCache?.get(track) || null; } catch { known = null; }
    // Not found, or matched by length and not confirmed, before listening could look further (LISTEN_VERSION): searched again.
    const unconfirmed = known?.unmatched === "not_found" || (known?.match?.byArtistAndLength && known.match.listened?.verdict !== "same");
    const older = (known?.searchedV ?? 0) < LISTEN_VERSION;
    if (known && listen && unconfirmed && older) known = null;
    // Confirmed by ear by an older way of listening: its fallbacks may include uploads heard not to be the song.
    if (known && older && known.match?.listened?.verdict === "same" && known.fallbackCandidates?.length) known = { ...known, fallbackCandidates: [] };
    // A match by name from before the current title rules ("Maybe Mine" once passed for "Be Mine") is scored
    // again (its fallbacks too): one the rules now turn down is searched again, one that only half agrees is then
    // listened to (toVerify).
    if (known && older && known.match?.listened?.verdict !== "same" && !known.match?.byArtistAndLength) known = rescored(track, known);
    return known && !(typeof known.sourceURL === "string" && namesAnotherSong(track, known)) ? { ...known, ...base(track) } : { ...base(track), pending: true };
  };
  const rows = entries.map(({ track, ready, unread }) => {
    if (ready) return { ...ready, importMetadata: track, playlistIndex: track.trackNumber, fallbackCandidates: [] };
    if (unread) {
      // A pasted song saved before is known from its link alone (its Spotify id), so it needn't be read at all.
      let owned = null;
      try { owned = ownedSong?.(track) || null; } catch { owned = null; }
      if (owned) return { ...base(track), ownedSongId: owned };
      // Pasted songs not read from Spotify yet (see `read`).
      return { ...base(track), reading: true };
    }
    return startRow(track);
  });
  // Songs to search for: grows while pasted songs are read.
  const todo = rows.flatMap((row, at) => (row.pending ? [at] : []));
  const toRead = rows.filter((row) => row.reading).length;
  const total = todo.length + toRead;
  let completed = 0;
  let readCount = 0;
  let readingDone = !read || !toRead;
  // Matches to listen to (see `listen`), and how many have been.
  const toListen = [];
  const queuedToListen = new Set();
  let listenedCount = 0;
  /** The progress line's fields: songs settled of those to settle, and how far reading pasted songs has got. */
  const status = (extra = {}) => ({
    stage: "searching_candidates",
    completed,
    total,
    ...(toRead ? { reading: { completed: readCount, total: toRead } } : {}),
    ...(queuedToListen.size ? { listening: { completed: listenedCount, total: queuedToListen.size } } : {}),
    ...extra,
  });
  /**
   * A match made by artist and length alone, or a song not found with uploads of about its length to listen to, not
   * listened to yet, is queued to be; so is one left unsure by an older way of listening (LISTEN_VERSION).
   */
  const queueListen = (at) => {
    if (!listen || queuedToListen.has(at)) return;
    const row = rows[at];
    if (!toVerify(row) && !rescuable(row)) return;
    const heard = toVerify(row) ? row.match.listened : row.listened;
    if (heard && (heard.verdict !== "unsure" || (heard.v ?? 1) >= LISTEN_VERSION)) return;
    queuedToListen.add(at);
    toListen.push(at);
  };
  rows.forEach((_, at) => queueListen(at));
  onStage(status({ preview: preview(rows) }));

  /** Remembers a song's row for next time (search failures aren't: see matchCache). */
  const remember = (row) => {
    try {
      const { importMetadata: _metadata, playlistIndex: _index, listening: _listening, ...known } = row;
      matchCache?.set(row.importMetadata, { ...known, searchedV: LISTEN_VERSION });
    } catch {
      // Remembering is only a shortcut for next time.
    }
  };
  const settled = new Set();
  /** Settles a song's row: shown, counted, and remembered. */
  const settle = (at, row) => {
    if (settled.has(at)) return;
    settled.add(at);
    rows[at] = row;
    completed += 1;
    remember(row);
    queueListen(at);
    onStage(status({ row: { at, candidate: row } }));
  };
  // A small ordered fallback set per song: a match can fail at download time even when another upload works.
  /** A song's row from the uploads found for it, best first, or null if none is only this song. */
  const matchedRow = (track, found) => {
    const [candidate, ...fallbacks] = found.filter((value) => value && !namesAnotherSong(track, value));
    if (!candidate) return null;
    return {
      ...candidate,
      ...base(track),
      fallbackCandidates: fallbacks.filter((value) => typeof value.sourceURL === "string").slice(0, 2),
    };
  };

  /*
   * Pasted songs are read from Spotify (a page each, at Spotify's pace) while the songs already read are searched
   * for, so the first matches come in seconds, not after the whole list. Each song read joins the searches, or is
   * settled at once (in the library, remembered, or not a public song).
   */
  const readerTask = async () => {
    if (readingDone) return;
    try {
      await read((at, outcome) => {
        readCount += 1;
        const placeholder = rows[at].importMetadata;
        if (outcome.track) {
          // Its place is the placeholder's: the reader numbers only the songs it reads.
          const track = { ...placeholder, ...outcome.track, trackNumber: placeholder.trackNumber };
          noteTitle(track);
          const row = startRow(track);
          rows[at] = row;
          if (row.pending) {
            todo.push(at);
            onStage(status({ row: { at, candidate: row } }));
            return;
          }
          settled.add(at);
          completed += 1;
          queueListen(at);
          onStage(status({ row: { at, candidate: row } }));
          return;
        }
        // Not a public song ("not_on_spotify"), or Spotify never answered for it ("unread": pasting again asks again).
        settled.add(at);
        completed += 1;
        rows[at] = { ...base(placeholder), unmatched: outcome.missing ? "not_on_spotify" : "unread" };
        onStage(status({ row: { at, candidate: rows[at] } }));
      }, (seconds) => onStage(status({ spotifyWaitingSeconds: seconds })), (at) => Boolean(rows[at]?.reading));
    } finally {
      readingDone = true;
    }
  };
  /** Waits a moment for more songs to search, while pasted songs are still being read; false once none can come. */
  const moreComing = async () => {
    if (readingDone) return false;
    await pause(100, signal);
    return true;
  };

  /*
   * Two searches run side by side, each at its own service's pace: SoundCloud's (quicker, and many producers post
   * their own uploads there) and YouTube's. A song SoundCloud has as the artist's own upload is settled there and
   * not searched on YouTube; YouTube looks first at songs SoundCloud has already been through without that. A
   * weaker SoundCloud match is used only if YouTube finds nothing.
   */
  const soundCloudResult = new Map(); // at -> row or null, once SoundCloud has been asked
  const youTubeOutcome = new Map(); // at -> "none" | "failed", once YouTube found nothing
  /** at -> uploads of about the song's length the names couldn't settle (see withNearLength), to listen to. */
  const nearLength = new Map();
  let soundCloudFinished = !searchSoundCloud;
  const decide = (at) => {
    if (settled.has(at) || !youTubeOutcome.has(at)) return;
    if (!soundCloudResult.has(at) && !soundCloudFinished) return;
    const track = rows[at].importMetadata;
    const fromSoundCloud = soundCloudResult.get(at);
    const nearby = nearLength.get(at) ?? [];
    if (fromSoundCloud) settle(at, fromSoundCloud);
    else if (youTubeOutcome.get(at) === "failed") settle(at, { ...base(track), unmatched: "search_failed" });
    // Its uploads of about its length go with it, to be listened to (see listenLane).
    else settle(at, { ...base(track), unmatched: "not_found", ...(nearby.length ? { nearby } : {}) });
  };

  let refusedInARow = 0;
  /** One YouTube search, at its turn, asked again while YouTube turns it away: the uploads found, or null if it never answered. */
  const searchYouTubeOnce = async (track, options) => {
    for (let attempt = 0; ; attempt++) {
      await playlistSearchTurn(signal, gap);
      try {
        const found = await search(track, signal, undefined, { maxResults: 3, enrich: false, ...options });
        refusedInARow = 0;
        return Array.isArray(found) ? found : [];
      } catch (error) {
        if (error?.name === "AbortError" || signal?.aborted) throw error;
        if (!error?.retryable) return null;
        if (attempt >= backoff.length) {
          refusedInARow += 1;
          return null;
        }
        // Every playlist's searches wait it out, not just this one.
        nextPlaylistSearchAt = Math.max(nextPlaylistSearchAt, Date.now() + backoff[attempt]);
        onStage(status({ waitingSeconds: Math.round(backoff[attempt] / 1000) }));
      }
    }
  };

  /*
   * YouTube's searches go lightest first: every song's quick search ("official audio") before any heavier one. A
   * song that search didn't settle (nothing found, or only its artist's upload of the same length) waits for a
   * broader search until no quick one is left to do, so one hard song doesn't hold up the rest of the list.
   */
  const firstTried = new Set();
  /** at -> what the quick search found: its row (a match by length alone) and uploads of about its length. */
  const afterQuick = new Map();
  /** Songs waiting for the broader search, in the order their quick searches left them. */
  const heavier = [];
  /** When the last quick search finished (see youTubeLane: broader searches wait for the reading). */
  let lastQuickAt = Date.now();
  /** Whether quick searches are still to come (listening waits for them: see listenLane). */
  const quickPending = () => !readingDone || todo.some((at) => !settled.has(at) && !firstTried.has(at));
  /** Settles a song from YouTube's searches: a match, or nothing (then SoundCloud's weaker match, if any, decides). */
  const youTubeSettles = (at, row, near, failed) => {
    if (settled.has(at)) return;
    const listenTo = near.filter((n) => n.sourceURL !== row?.sourceURL).slice(0, 3);
    // A match by length alone takes the other uploads of about its length along, in case it isn't the song.
    if (row && listen && lengthOnly(row) && listenTo.length) row = { ...row, nearby: listenTo };
    if (!row && listen && listenTo.length) nearLength.set(at, listenTo);
    if (row) settle(at, row);
    else {
      youTubeOutcome.set(at, failed ? "failed" : "none");
      decide(at);
    }
  };
  const addNear = (near, uploads) => {
    for (const upload of uploads?.nearLength ?? []) if (!near.some((n) => n.sourceURL === upload.sourceURL)) near.push(upload);
  };

  const youTubeLane = async () => {
    const quickOpen = (at) => !settled.has(at) && !firstTried.has(at);
    const seen = (at) => quickOpen(at) && soundCloudResult.has(at);
    for (;;) {
      if (todo.some(quickOpen)) {
        // SoundCloud goes first where it can: a song it settles needs no YouTube search at all.
        for (const until = Date.now() + SOUNDCLOUD_HEAD_START_MS; !soundCloudFinished && Date.now() < until && !todo.some(seen) && todo.some(quickOpen);) {
          await pause(50, signal);
        }
        const at = todo.find(seen) ?? todo.find(quickOpen);
        if (at === undefined) continue;
        firstTried.add(at);
        const track = rows[at].importMetadata;
        const found = refusedInARow < PLAYLIST_SEARCH_GIVE_UP_AFTER ? await searchYouTubeOnce(track, {}) : null;
        lastQuickAt = Date.now();
        if (settled.has(at)) continue;
        const near = [];
        addNear(near, found);
        const row = found?.length ? matchedRow(track, found) : null;
        // A file of the user's own without an artist tag was searched under its title alone already.
        const broader = !(track.localFile && !track.artist);
        // Settled unless it found nothing (and SoundCloud has no upload of it either, which is what the broader search
        // would settle for) or only a match by length: those wait for the broader search.
        const waits = broader && found && refusedInARow < PLAYLIST_SEARCH_GIVE_UP_AFTER
          && (row ? lengthOnly(row) : !soundCloudResult.get(at));
        if (waits) {
          afterQuick.set(at, { row, near });
          heavier.push(at);
        } else youTubeSettles(at, row, near, !found);
        continue;
      }
      // Broader searches wait for the reading too, so they don't delay the quick searches of songs read later; only a
      // long lull in the reading (Spotify asking for a pause) lets them go on meanwhile.
      if (heavier.length && (readingDone || Date.now() - lastQuickAt >= HEAVY_AFTER_IDLE_MS)) {
        const at = heavier.shift();
        const { row: quick, near } = afterQuick.get(at);
        afterQuick.delete(at);
        if (settled.has(at)) continue;
        const track = rows[at].importMetadata;
        // Not found under "official audio": once more more broadly (music videos, fan uploads, Japanese names). Not
        // needed any more if SoundCloud has an upload of it by now.
        const found = !quick && soundCloudResult.get(at) ? [] : refusedInARow < PLAYLIST_SEARCH_GIVE_UP_AFTER ? await searchYouTubeOnce(track, { broad: true }) : null;
        if (settled.has(at)) continue;
        addNear(near, found);
        const broad = found?.length ? matchedRow(track, found) : null;
        // A match by name beats one by length alone; otherwise the quick search's match by length stands.
        const row = broad && !lengthOnly(broad) ? broad : quick ?? broad;
        youTubeSettles(at, row, near, !quick && !found);
        continue;
      }
      if (await moreComing()) continue;
      return;
    }
  };

  const soundCloudLane = async () => {
    if (!searchSoundCloud) return;
    try {
      for (let next = 0; ; next++) {
        while (next >= todo.length) {
          if (!(await moreComing())) return;
        }
        const at = todo[next];
        if (settled.has(at)) continue;
        const track = rows[at].importMetadata;
        let result = null;
        for (let attempt = 0; ; attempt++) {
          await soundCloudSearchTurn(signal, soundCloudGap);
          try {
            result = await searchSoundCloud(track, signal);
            break;
          } catch (error) {
            if (error?.name === "AbortError" || signal?.aborted) throw error;
            if (!error?.retryable || attempt >= soundCloudBackoff.length) break;
            nextSoundCloudSearchAt = Math.max(nextSoundCloudSearchAt, Date.now() + soundCloudBackoff[attempt]);
          }
        }
        if (settled.has(at)) continue;
        const candidates = result?.candidates?.length ? result.candidates : null;
        const row = candidates ? matchedRow(track, candidates) : null;
        if (row && result.strong) settle(at, row);
        else {
          soundCloudResult.set(at, row);
          decide(at);
        }
      }
    } finally {
      soundCloudFinished = true;
      if (!signal?.aborted) for (const at of todo) decide(at);
    }
  };

  /**
   * A row once listened to (`uploads`: what was listened to, the match and its fallbacks first, then the uploads of
   * about its length): kept as sure (maybe as another of those uploads), dropped, or left to the user.
   */
  const heardRow = (row, heard, uploads) => {
    const track = row.importMetadata;
    const verdict = { verdict: heard.verdict === "different" ? "different" : "unsure", deezerID: heard.deezer?.id ?? null, v: LISTEN_VERSION };
    if (rescuable(row) && heard.verdict !== "same") return { ...base(track), unmatched: "not_found", listened: verdict };
    if (heard.verdict === "different") return { ...base(track), unmatched: "not_found", listened: verdict };
    if (heard.verdict !== "same") return { ...row, match: { ...row.match, listened: verdict } };
    const strip = ({ fallbackCandidates: _f, importMetadata: _m, playlistIndex: _i, nearby: _n, unmatched: _u, listened: _l, listening: _g, ...c }) => c;
    const chosen = strip(uploads[heard.at]);
    const { byArtistAndLength: _byLength, ...chosenMatch } = chosen.match || {};
    // Fallbacks (played if the chosen upload fails) are the match's own ones not listened to yet, that is after the
    // chosen one, and never a match by length alone: uploads heard not to be the song, and uploads only listened to,
    // aren't.
    const own = toVerify(row) ? [row, ...(row.fallbackCandidates || [])].filter((c, at) => at > heard.at && !c.match?.byArtistAndLength) : [];
    return {
      ...chosen,
      ...base(track),
      confidence: "likely",
      evidenceStrength: "audio_fingerprint",
      requiresReview: false,
      match: { ...chosenMatch, listened: { verdict: "same", ber: heard.ber, deezerID: heard.deezer.id } },
      fallbackCandidates: own.map(strip).slice(0, 2),
    };
  };
  let searching = true;
  /** Listens to the queued matches one at a time, while the searches go on, until both are done. */
  const listenLane = async () => {
    if (!listen) return;
    for (;;) {
      // The quick searches come first (they settle most songs); listening downloads audio, so it waits for them.
      if (searching && quickPending()) {
        await pause(200, signal);
        continue;
      }
      const at = toListen.shift();
      if (at === undefined) {
        if (!searching) return;
        await pause(200, signal);
        continue;
      }
      const row = rows[at];
      if (!toVerify(row) && !rescuable(row)) {
        listenedCount += 1;
        continue;
      }
      // The match and its fallbacks, then the uploads of about the song's length that the names couldn't settle.
      const own = toVerify(row) ? [row, ...(row.fallbackCandidates || [])] : [];
      const uploads = [...own, ...(row.nearby || [])].filter((c) => typeof c.sourceURL === "string");
      rows[at] = { ...row, listening: true };
      onStage(status({ row: { at, candidate: rows[at] } }));
      let heard = null;
      try {
        heard = await listen(row.importMetadata, uploads.map((c) => c.sourceURL), { signal, strictFrom: own.length });
      } catch (error) {
        if (error?.name === "AbortError" || signal?.aborted) throw error;
      }
      listenedCount += 1;
      // Couldn't listen (Deezer or the upload didn't answer): as it was, and asked again next time.
      rows[at] = heard ? heardRow(row, heard, uploads) : row;
      if (heard) remember(rows[at]);
      onStage(status({ row: { at, candidate: rows[at] } }));
    }
  };

  // A line every so often even while everything waits (Spotify or YouTube asking for a pause), so the app knows the
  // matching is still going rather than stalled.
  const heartbeat = setInterval(() => onStage(status()), 30_000);
  try {
    await Promise.all([
      Promise.all([readerTask(), youTubeLane(), soundCloudLane()]).finally(() => { searching = false; }),
      listenLane(),
    ]);
  } finally {
    clearInterval(heartbeat);
  }
  // A song matched only as its artist's upload of the same length has its upload's title unchecked. If another song
  // of the playlist matched an upload carrying that same title ("イガク/Medicine" for Medicine), the upload is that
  // other song, and this match was a coincidence of length.
  const titleOf = (title) => normalizeMatchText(withoutCredit(title || "").split(/\s[-–—|]\s|／|\//)[0]).replace(/ /g, "");
  const compact = (title) => normalizeMatchText(title || "").replace(/ /g, "");
  rows.forEach((row, at) => {
    if (!row.match?.byArtistAndLength) return;
    const key = titleOf(row.title);
    if (key.length < 2) return;
    const taken = rows.some((other, otherAt) => otherAt !== at
      && typeof other.sourceURL === "string"
      && other.importMetadata?.trackID !== row.importMetadata?.trackID
      && compact(other.title).includes(key));
    if (!taken) return;
    const track = row.importMetadata;
    rows[at] = { ...base(track), unmatched: "not_found" };
    try {
      matchCache?.set(track, { unmatched: "not_found", searchedV: LISTEN_VERSION });
    } catch {
      // Remembering is only a shortcut for next time.
    }
    onStage({ stage: "searching_candidates", completed, total, row: { at, candidate: rows[at] } });
  });
  return rows;
}

/** The error for a playlist with no song to offer: YouTube refusing searches, or nothing matching. */
function noPlaylistMatches(rows, message) {
  if (rows.some((row) => row.unmatched === "search_failed")) {
    return localImportError("searching_candidates", "YOUTUBE_SEARCH_BUSY", "YouTube is turning searches away for a moment. Try the playlist again in a minute.");
  }
  return localImportError("searching_candidates", "NO_AUDIO_MATCH", message);
}

const playlistOffers = (rows) => rows.some((row) => typeof row.sourceURL === "string" || row.ownedSongId);

/**
 * A resolved playlist, everything but its rows. `playlist.unavailableCount`: songs the provider lists but doesn't
 * offer publicly (rows that couldn't be matched are listed themselves, so aren't counted here).
 */
function playlistSummary(kind, provider, fallbackArtist, playlist) {
  const { items, ...details } = playlist;
  return {
    kind,
    mediaKind: "audio",
    playlist: details,
    track: {
      provider,
      type: "playlist",
      trackID: playlist.playlistID,
      title: playlist.title,
      artist: playlist.author || fallbackArtist,
      album: null,
      trackNumber: null,
      durationSeconds: items.reduce((total, item) => total + (item.durationSeconds || 0), 0) || null,
      artworkURL: playlist.artworkURL,
      embedURL: null,
      sourceURL: playlist.sourceURL,
    },
  };
}

const soundCloudPlaylistSummary = (playlist) => playlistSummary("soundcloud_playlist", "soundcloud", "SoundCloud", playlist);
const spotifyPlaylistSummary = (playlist) => playlistSummary("spotify_playlist", "spotify", "Spotify", playlist);

async function resolveLocalImportMetadata(source, signal, adapters = {}, options = {}) {
  const mediaKind = normalizedMediaKind(options.mediaKind);
  assertNotAborted(signal);
  if (isSoundCloudURL(source)) {
    if (mediaKind === "video") {
      throw localImportError("resolving_metadata", "SOUNDCLOUD_AUDIO_ONLY", "SoundCloud links can only be imported as audio.");
    }
    const soundCloudResolve = adapters.resolveSoundCloudSource || resolveSoundCloudSource;
    const resolved = await soundCloudResolve(source, signal);
    if (resolved.kind !== "track") {
      throw localImportError(
        "resolving_metadata",
        "PLAYLIST_METADATA_UNSUPPORTED",
        "A saved server song must identify one track, not a playlist.",
      );
    }
    return publicSoundCloudMetadata(resolved.track);
  }
  if (isSpotifyURL(source)) {
    if (mediaKind === "video") {
      throw localImportError("resolving_metadata", "YOUTUBE_VIDEO_REQUIRED", "Video downloads require a direct YouTube video URL. Spotify links can only be imported as audio.");
    }
    if (spotifyPlaylistURL(source)) {
      throw localImportError(
        "resolving_metadata",
        "PLAYLIST_METADATA_UNSUPPORTED",
        "A saved server song must identify one track, not a playlist.",
      );
    }
    const spotifyResolve = adapters.resolveSpotifyTrack || resolveSpotifyTrack;
    return spotifyResolve(source, signal);
  }
  if (youtubePlaylistID(source)) {
    throw localImportError(
      "resolving_metadata",
      "PLAYLIST_METADATA_UNSUPPORTED",
      "A saved server song must identify one video, not a playlist.",
    );
  }
  if (!youtubeVideoID(source)) {
    throw localImportError("resolving_metadata", "UNSUPPORTED_SOURCE", "Enter a Spotify, SoundCloud, or supported YouTube track URL.");
  }
  const youtubeMetadata = adapters.resolveYouTubeMetadata || resolveYouTubeMetadata;
  return youtubeMetadata(source, signal);
}

async function resolveLocalImportSource(source, signal, onStage = () => {}, adapters = {}, options = {}) {
  const mediaKind = normalizedMediaKind(options.mediaKind);
  const spotifyResolve = adapters.resolveSpotifyTrack || resolveSpotifyTrack;
  const candidateSearch = adapters.searchYouTubeAudioSources || searchYouTubeAudioSources;
  const youtubeInspect = mediaKind === "video"
    ? adapters.inspectYouTubeVideo || inspectYouTubeVideo
    : adapters.inspectYouTubeAudio || inspectYouTubeAudio;
  assertNotAborted(signal);
  if (isSoundCloudURL(source)) {
    if (mediaKind === "video") {
      throw localImportError("resolving_metadata", "SOUNDCLOUD_AUDIO_ONLY", "SoundCloud links can only be imported as audio.");
    }
    onStage({ stage: "resolving_metadata" });
    const soundCloudResolve = adapters.resolveSoundCloudSource || resolveSoundCloudSource;
    const resolved = await soundCloudResolve(source, signal);
    if (resolved.kind === "track") {
      const track = publicSoundCloudMetadata(resolved.track);
      onStage({ stage: "searching_candidates", track });
      const candidates = resolved.track.directlyImportable ? [directSoundCloudCandidate(resolved.track)] : [];
      if (!candidates.length) {
        try {
          candidates.push(...await candidateSearch(track, signal));
        } catch (error) {
          if (error?.name === "AbortError") throw error;
        }
      }
      if (!candidates.length) {
        throw localImportError(
          "searching_candidates",
          "SOUNDCLOUD_STREAM_UNAVAILABLE",
          "This SoundCloud track has no direct public audio rendition and no matching alternate source was found.",
        );
      }
      return { kind: "soundcloud", mediaKind: "audio", track, candidates };
    }

    const playlist = resolved.playlist;
    const summary = soundCloudPlaylistSummary(playlist);
    const matched = await matchPlaylistRows(playlist.items.map((sourceTrack) => ({
      track: publicSoundCloudMetadata(sourceTrack),
      ready: sourceTrack.directlyImportable ? directSoundCloudCandidate(sourceTrack) : null,
    })), {
      signal,
      onStage,
      search: candidateSearch,
      ownedSong: options.ownedSong,
      matchCache: options.matchCache,
      pace: adapters.playlistSearchPace,
      preview: (rows) => ({ ...summary, candidates: rows }),
    });
    if (!playlistOffers(matched)) throw noPlaylistMatches(matched, "No public audio source could be imported from this SoundCloud playlist.");
    return { ...summary, candidates: matched };
  }
  /** A Spotify playlist's (or pasted songs') rows, each song matched to an upload (see matchPlaylistRows). */
  /** `read`: pasted songs still to read from Spotify (their items are placeholders); see matchPlaylistRows. */
  const matchSpotifyPlaylist = async (playlist, read = null) => {
    const summary = spotifyPlaylistSummary(playlist);
    // (Pasted files of the user's own have nothing to read: their tags are all there is.)
    const matched = await matchPlaylistRows(playlist.items.map((track) => ({ track, unread: Boolean(read) && !track.localFile })), {
      read,
      signal,
      onStage,
      search: candidateSearch,
      // Searched alongside YouTube; an adapter of null leaves SoundCloud out.
      searchSoundCloud: adapters.searchSoundCloudAudioSources === undefined ? searchSoundCloudAudioSources : adapters.searchSoundCloudAudioSources,
      ownedSong: options.ownedSong,
      matchCache: options.matchCache,
      listen: options.listen,
      pace: adapters.playlistSearchPace,
      preview: (rows) => ({ ...summary, candidates: rows }),
    });
    // Pasted songs Spotify didn't answer for are listed to ask again for, rather than ending in an error.
    if (!playlistOffers(matched) && !matched.some((row) => row.unmatched === "unread")) {
      throw noPlaylistMatches(matched, "No file-backed audio source matched the public tracks in this Spotify playlist.");
    }
    return { ...summary, candidates: matched };
  };
  // Several Spotify song links pasted together (Spotify's app copies one per song for a selection, the user's own
  // files among them): one playlist, however long, where a playlist link gives only its first 100 songs.
  const pastedSongs = pastedSongsIn(source);
  if (pastedSongs.length > 1) {
    if (mediaKind === "video") {
      throw localImportError("resolving_metadata", "YOUTUBE_VIDEO_REQUIRED", "Spotify songs can only be imported as audio.");
    }
    // Every song is listed at once and read from Spotify while the songs already read are being matched.
    const songs = pastedSongs.slice(0, MAX_PASTED_SONGS);
    const items = songs.map((song, at) => (song.trackID ? pastedSpotifyTrack(song.trackID, at) : pastedLocalTrack(song.local, at)));
    const reader = adapters.readSpotifyTracks || readSpotifyTracks;
    const ids = items.flatMap((track) => (track.trackID ? [track.trackID] : []));
    // Reads the Spotify songs among them that are still to read (`wanted`: not files, not known from their links),
    // numbered by the reader among those; `places` turns its numbers back into the list's.
    const read = (onTrack, onWait, wanted = () => true) => {
      const places = items.flatMap((track, at) => (track.trackID && wanted(at) ? [at] : []));
      if (!places.length) return undefined;
      return reader(places.map((at) => items[at].trackID), signal, undefined, (at, outcome) => onTrack(places[at], outcome), onWait);
    };
    return matchSpotifyPlaylist({
      playlistID: null,
      title: "Songs pasted from Spotify",
      author: "Spotify",
      artworkURL: null,
      sourceURL: null,
      items,
      unavailableCount: 0,
      truncated: pastedSongs.length > songs.length,
    }, ids.length ? read : null);
  }
  if (isSpotifyURL(source)) {
    if (mediaKind === "video") {
      throw localImportError("resolving_metadata", "YOUTUBE_VIDEO_REQUIRED", "Video downloads require a direct YouTube video URL. Spotify links can only be imported as audio.");
    }
    onStage({ stage: "resolving_metadata" });
    const playlistResolve = adapters.resolveSpotifyPlaylist || resolveSpotifyPlaylist;
    let directPlaylist = null;
    try { directPlaylist = spotifyPlaylistURL(source); } catch (error) { throw error; }
    let playlist = null;
    if (directPlaylist) {
      playlist = await playlistResolve(source, signal);
    } else if (!adapters.resolveSpotifyTrack && !["open.spotify.com", "www.open.spotify.com"].includes(new URL(source).hostname.toLowerCase())) {
      try {
        const track = await spotifyResolve(source, signal);
        onStage({ stage: "searching_candidates", track });
        const candidates = await candidateSearch(track, signal);
        if (!candidates.length) {
          throw localImportError("searching_candidates", "NO_AUDIO_MATCH", "No file-backed audio source matched this Spotify track. Try a direct YouTube URL instead.");
        }
        return { kind: "spotify", mediaKind: "audio", track, candidates };
      } catch (error) {
        if (error?.code !== "SPOTIFY_INVALID_REDIRECT") throw error;
        playlist = await playlistResolve(source, signal);
      }
    }
    if (playlist) return matchSpotifyPlaylist(playlist);
    const track = await spotifyResolve(source, signal);
    onStage({ stage: "searching_candidates", track });
    const candidates = await candidateSearch(track, signal);
    if (!candidates.length) {
      throw localImportError("searching_candidates", "NO_AUDIO_MATCH", "No file-backed audio source matched this Spotify track. Try a direct YouTube URL instead.");
    }
    return { kind: "spotify", mediaKind: "audio", track, candidates };
  }
  const playlistID = youtubePlaylistID(source);
  if (playlistID) {
    onStage({ stage: "resolving_metadata" });
    const playlistResolve = adapters.resolveYouTubePlaylist || resolveYouTubePlaylist;
    const playlist = await playlistResolve(source, signal);
    const durationSeconds = playlist.items.reduce((total, item) => total + (item.durationSeconds || 0), 0) || null;
    return {
      kind: "youtube_playlist",
      mediaKind,
      playlist,
      track: {
        provider: "youtube",
        type: "playlist",
        trackID: playlistID,
        title: playlist.title,
        artist: playlist.author || "YouTube",
        album: null,
        trackNumber: null,
        durationSeconds,
        artworkURL: playlist.artworkURL,
        embedURL: null,
        sourceURL: playlist.sourceURL,
      },
      candidates: playlist.items,
    };
  }
  const videoID = youtubeVideoID(source);
  if (!videoID) throw localImportError("resolving_metadata", "UNSUPPORTED_SOURCE", "Enter a Spotify, SoundCloud, or supported YouTube track or playlist URL.");
  onStage({ stage: "inspecting_source" });
  const preview = await youtubeInspect(source, signal);
  const track = directYouTubeMetadata(preview);
  return {
    kind: "youtube",
    mediaKind,
    track,
    candidates: [{
      videoID: preview.videoID,
      title: preview.title,
      artist: preview.author,
      album: null,
      durationSeconds: preview.durationSeconds,
      thumbnailURL: preview.thumbnailURL,
      sourceProvider: "youtube",
      officialArtist: false,
      sourceURL: preview.sourceURL,
      contentType: preview.contentType || (mediaKind === "video" ? "video/mp4" : "audio/mp4"),
      qualityLabel: preview.qualityLabel || null,
      quality: mediaKind === "video" ? preview.qualityLabel || "MP4" : null,
      width: preview.width || null,
      height: preview.height || null,
      fps: preview.fps || null,
      score: 1,
      confidence: "high",
      match: { title: 1, artist: 1, album: null, duration: 1, durationDeltaSeconds: 0 },
    }],
  };
}

// A server catalog row has already been through metadata hydration before the
// user can choose it. Reuse that trusted display metadata while preparing a
// saved-link download so providers do not repeat the metadata request.
// Short-lived SoundCloud renditions are prepared here and handed directly to
// the immediately following import, while other provider stream discovery
// still happens at the byte-transfer step.
async function resolveLocalImportDownloadSource(
  source,
  knownMetadata,
  signal,
  onStage = () => {},
  adapters = {},
  options = {},
) {
  const mediaKind = normalizedMediaKind(options.mediaKind);
  assertNotAborted(signal);
  const metadata = normalizedMetadata(knownMetadata, { sourceURL: source });

  if (isSoundCloudURL(source)) {
    if (mediaKind === "video") {
      throw localImportError("inspecting_source", "SOUNDCLOUD_AUDIO_ONLY", "SoundCloud links can only be imported as audio.");
    }
    onStage({ stage: "inspecting_source" });
    const audioResolve = adapters.resolveSoundCloudAudio || resolveSoundCloudAudio;
    let preparedAudio;
    try {
      preparedAudio = await audioResolve(source, signal);
    } catch {
      assertNotAborted(signal);
      const durationSeconds = Number(knownMetadata?.durationSeconds || knownMetadata?.duration);
      const track = {
        provider: "soundcloud",
        type: "track",
        trackID: cleanMetadata(knownMetadata?.trackID, ""),
        title: metadata.title,
        artist: metadata.artist,
        album: metadata.album,
        trackNumber: null,
        durationSeconds: Number.isFinite(durationSeconds) && durationSeconds > 0 ? durationSeconds : null,
        artworkURL: metadata.artworkURL,
        embedURL: "",
        sourceURL: normalizedSoundCloudPreparationSource(source),
        directlyImportable: false,
      };
      onStage({ stage: "searching_candidates", track });
      const candidateSearch = adapters.searchYouTubeAudioSources || searchYouTubeAudioSources;
      const candidates = await candidateSearch(track, signal);
      assertNotAborted(signal);
      if (!candidates.length) {
        throw localImportError(
          "searching_candidates",
          "SOUNDCLOUD_STREAM_UNAVAILABLE",
          "This SoundCloud track has no direct public audio rendition and no matching alternate source was found.",
        );
      }
      return { kind: "soundcloud", mediaKind: "audio", track, candidates };
    }
    assertNotAborted(signal);
    const durationSeconds = Number(knownMetadata?.durationSeconds || knownMetadata?.duration);
    const track = {
      ...preparedAudio.track,
      provider: "soundcloud",
      type: "track",
      title: metadata.title,
      artist: metadata.artist,
      album: metadata.album,
      trackNumber: null,
      durationSeconds: Number.isFinite(durationSeconds) && durationSeconds > 0
        ? durationSeconds
        : preparedAudio.track.durationSeconds,
      artworkURL: metadata.artworkURL,
      embedURL: "",
      sourceURL: normalizedSoundCloudPreparationSource(source),
      directlyImportable: true,
    };
    return {
      kind: "soundcloud",
      mediaKind: "audio",
      track,
      candidates: [{
        ...directSoundCloudCandidate(track),
        preparedSoundCloudAudio: createPreparedSoundCloudAudioHandoff(preparedAudio, {
          source: track.sourceURL,
          mediaKind: "audio",
          preparationContext: options.preparationContext,
        }),
      }],
    };
  }

  if (isSpotifyURL(source)) {
    if (mediaKind === "video") {
      throw localImportError("resolving_metadata", "YOUTUBE_VIDEO_REQUIRED", "Video downloads require a direct YouTube video URL. Spotify links can only be imported as audio.");
    }
    if (spotifyPlaylistURL(source)) {
      throw localImportError("resolving_metadata", "PLAYLIST_METADATA_UNSUPPORTED", "A saved server song must identify one track, not a playlist.");
    }
    const track = {
      provider: "spotify",
      type: "track",
      trackID: cleanMetadata(knownMetadata?.trackID, ""),
      title: metadata.title,
      artist: metadata.artist,
      album: metadata.album,
      trackNumber: null,
      durationSeconds: Number(knownMetadata?.durationSeconds || knownMetadata?.duration) || null,
      artworkURL: metadata.artworkURL,
      embedURL: null,
      sourceURL: source,
    };
    onStage({ stage: "searching_candidates", track });
    const candidateSearch = adapters.searchYouTubeAudioSources || searchYouTubeAudioSources;
    const candidates = await candidateSearch(track, signal);
    if (!candidates.length) {
      throw localImportError("searching_candidates", "NO_AUDIO_MATCH", "No file-backed audio source matched this Spotify track. Try a direct YouTube URL instead.");
    }
    return { kind: "spotify", mediaKind: "audio", track, candidates };
  }

  if (youtubePlaylistID(source)) {
    throw localImportError("resolving_metadata", "PLAYLIST_METADATA_UNSUPPORTED", "A saved server song must identify one track, not a playlist.");
  }
  const videoID = youtubeVideoID(source);
  if (!videoID) {
    throw localImportError("resolving_metadata", "UNSUPPORTED_SOURCE", "Enter a Spotify, SoundCloud, or supported YouTube track URL.");
  }
  const track = {
    provider: "youtube",
    type: "track",
    trackID: videoID,
    title: metadata.title,
    artist: metadata.artist,
    album: metadata.album,
    trackNumber: null,
    durationSeconds: Number(knownMetadata?.durationSeconds || knownMetadata?.duration) || null,
    artworkURL: metadata.artworkURL,
    embedURL: null,
    sourceURL: source,
  };
  onStage({ stage: "inspecting_source", track });
  return {
    kind: "youtube",
    mediaKind,
    track,
    candidates: [{
      videoID,
      title: track.title,
      artist: track.artist,
      album: track.album,
      durationSeconds: track.durationSeconds,
      thumbnailURL: track.artworkURL,
      sourceProvider: "youtube",
      officialArtist: false,
      sourceURL: source,
      contentType: mediaKind === "video" ? "video/mp4" : "audio/mp4",
      qualityLabel: null,
      quality: mediaKind === "video" ? "MP4" : null,
      width: null,
      height: null,
      fps: null,
      score: 1,
      confidence: "high",
      match: { title: 1, artist: 1, album: null, duration: 1, durationDeltaSeconds: 0 },
    }],
  };
}

async function importConfirmedSource(input, signal, onStage = () => {}, adapters = {}) {
  const mediaKind = normalizedMediaKind(input.mediaKind);
  const soundCloudSource = isSoundCloudURL(input.sourceURL);
  const sourceIdentity = normalizeSourceIdentity(input.sourceIdentity, {
    provider: soundCloudSource ? "soundcloud" : "youtube",
    providerID: soundCloudSource ? null : youtubeVideoID(input.sourceURL),
    sourcePageURL: input.metadata?.sourceURL || input.sourceURL,
    mediaSourceURL: null,
  });
  if (soundCloudSource && mediaKind === "video") {
    throw localImportError("inspecting_source", "SOUNDCLOUD_AUDIO_ONLY", "SoundCloud links can only be imported as audio.");
  }
  const youtubeDownload = mediaKind === "video"
    ? adapters.downloadYouTubeVideo || downloadYouTubeVideo
    : adapters.downloadYouTubeAudio || downloadYouTubeAudio;
  const soundCloudDownload = adapters.downloadSoundCloudAudio || downloadSoundCloudAudio;
  const soundCloudResolvedDownload = adapters.downloadResolvedSoundCloudAudio || downloadResolvedSoundCloudAudio;
  const artworkFetch = adapters.fetchArtwork || fetchArtwork;
  const m4aTag = adapters.tagM4A || tagM4A;
  const fileHash = adapters.hashFile || hashFile;
  const fileMove = adapters.moveFile || moveFile;
  const temporaryRoot = input.temporaryRoot || os.tmpdir();
  const temporary = await fs.mkdtemp(path.join(temporaryRoot, "resonance-local-import-"));
  let sourcePath = path.join(temporary, mediaKind === "video" ? "source.mp4" : soundCloudSource ? "source.mp3" : "source.m4a");
  const outputPath = path.join(temporary, "tagged.m4a");
  const metadataSnapshot = input.metadataSnapshot || { settled: false, metadata: null };
  if (input.metadataPromise) {
    void Promise.resolve(input.metadataPromise).then(
      (metadata) => {
        metadataSnapshot.metadata = metadata || null;
        metadataSnapshot.settled = true;
      },
      () => {
        // Optional enrichment must never own the media-transfer lifecycle. The
        // caller can retry metadata hydration independently after this import.
        metadataSnapshot.settled = true;
      },
    );
  }
  let savedPath = null;
  // Slopify: `input.analyzeSource(path, { mediaKind, signal })` studies the download as it came
  // (for the duplicate check's fingerprints). Optional: its failure never fails the import.
  let pendingAnalysis = null;
  const analyze = (filePath) => {
    if (typeof input.analyzeSource !== "function") return Promise.resolve(null);
    pendingAnalysis = Promise.resolve()
      .then(() => input.analyzeSource(filePath, { mediaKind, signal }))
      .catch((error) => {
        if (error?.name === "AbortError") throw error;
        return null;
      });
    pendingAnalysis.catch(() => undefined);
    return pendingAnalysis;
  };
  try {
    assertNotAborted(signal);
    if (!soundCloudSource) {
      const videoID = youtubeVideoID(input.sourceURL);
      if (!videoID) throw localImportError("inspecting_source", "INVALID_YOUTUBE_VIDEO", "The selected source is not a supported YouTube video.");
    }
    onStage({ stage: "inspecting_source", selected: input.sourceURL });
    const downloadProgress = (completed, total) => onStage({ stage: "downloading", completed, total });
    let result;
    if (soundCloudSource) {
      assertNotAborted(signal);
      const preparedAudio = input.preparedSoundCloudAudio?.consume?.({
        source: input.sourceURL,
        mediaKind,
        preparationContext: input.preparationContext,
      }) || null;
      assertNotAborted(signal);
      if (preparedAudio) {
        const download = await soundCloudResolvedDownload(
          preparedAudio,
          sourcePath,
          signal,
          downloadProgress,
        );
        result = completedSoundCloudDownload(preparedAudio, download);
      } else {
        result = await soundCloudDownload(input.sourceURL, sourcePath, signal, downloadProgress);
      }
      // An HLS track arrives as AAC in M4A: named so, its audio is copied as it is when tagged, not re-encoded.
      if (result.download?.format === "m4a") {
        const m4a = path.join(temporary, "source.m4a");
        await fs.rename(sourcePath, m4a);
        sourcePath = m4a;
      }
    } else {
      result = await youtubeDownload(input.sourceURL, sourcePath, signal, downloadProgress, undefined, input.maxVideoHeight ? { maxHeight: input.maxVideoHeight } : {});
    }
    assertNotAborted(signal);
    const enrichedMetadata = metadataSnapshot.settled ? metadataSnapshot.metadata : null;
    const metadata = normalizedMetadata({ ...input.metadata, ...(enrichedMetadata || {}) }, {
      title: result.preview.title,
      artist: result.preview.author || "Unknown uploader",
      album: null,
      artworkURL: result.preview.thumbnailURL,
      sourceURL: result.preview.sourceURL,
    });
    metadata.artworkURL = preferredYouTubeArtworkURL(metadata.artworkURL, result.preview.thumbnailURL);
    const completedSourceIdentity = normalizeSourceIdentity(sourceIdentity, {
      mediaSourceURL: result.mediaSourceURL,
    });
    assertNotAborted(signal);
    if (mediaKind === "video") {
      let sourceSha256 = result.download?.sha256 || null;
      if (result.separateStreams) {
        onStage({ stage: "processing", progress: null });
        const { video, audio } = result.separateStreams;
        // Without ffmpeg the streams are joined as they are, untagged.
        if (adapters.tagM4A || hasFFmpeg()) await runFFmpeg(mp4MuxArguments(video.path, audio.path, sourcePath, metadata), signal);
        else await joinMP4([video.path, audio.path], sourcePath, signal);
        sourceSha256 = await fileHash(sourcePath);
      }
      if (!sourceSha256) throw localImportError("processing", "VIDEO_HASH_FAILED", "The completed video could not be verified.");
      const existingDuplicate = duplicateTrack(input.existing, sourceSha256);
      if (existingDuplicate) return { kind: "duplicate", track: existingDuplicate, sourceIdentity: completedSourceIdentity };
      // The sound as YouTube sent it (its own stream, when picture and sound came apart).
      const analysis = await analyze(result.separateStreams?.audio?.path || sourcePath);
      assertNotAborted(signal);
      onStage({ stage: "saving_local" });
      const artworkPath = await artworkFetch(metadata.artworkURL, temporary, signal).catch((error) => {
        if (error?.name === "AbortError") throw error;
        return null;
      });
      const artwork = await artworkFileDataURL(artworkPath).catch(() => null);
      await fs.mkdir(input.destinationDirectory, { recursive: true });
      const preferred = `${safeFilename(`${metadata.artist} - ${metadata.title}`) || `Video-${randomUUID()}`}.mp4`;
      savedPath = await uniqueDestination(input.destinationDirectory, preferred);
      await fileMove(sourcePath, savedPath);
      assertNotAborted(signal);
      const information = await fs.stat(savedPath);
      assertNotAborted(signal);
      return {
        kind: "created",
        mediaKind,
        filePath: savedPath,
        size: information.size,
        sourceSha256,
        contentSha256: sourceSha256,
        sourceURL: metadata.sourceURL,
        sourceIdentity: completedSourceIdentity,
        artwork,
        metadata,
        analysis,
      };
    }
    const existingDuplicate = duplicateTrack(input.existing, result.download.sha256);
    if (existingDuplicate) return { kind: "duplicate", track: existingDuplicate, sourceIdentity: completedSourceIdentity };
    onStage({ stage: "processing", progress: null });
    // Studied while it is tagged: both only read the download.
    const analysisTask = analyze(sourcePath);
    const artwork = await artworkFetch(metadata.artworkURL, temporary, signal).catch((error) => {
      if (error?.name === "AbortError") throw error;
      return null;
    });
    // Without ffmpeg the download goes untagged (the library holds its details and artwork). A
    // fragmented M4A, as YouTube sends, is rewritten as a plain one, which iOS times correctly.
    const tags = Boolean(adapters.tagM4A) || hasFFmpeg();
    let finalPath = tags ? outputPath : sourcePath;
    if (!tags && path.extname(sourcePath).toLowerCase() === ".m4a") {
      try {
        await joinMP4([sourcePath], outputPath, signal);
        finalPath = outputPath;
      } catch (error) {
        if (error?.name === "AbortError") throw error;
        await fs.rm(outputPath, { force: true }).catch(() => undefined);
      }
    }
    if (tags) {
      try {
        await m4aTag(sourcePath, outputPath, metadata, artwork, signal);
      } catch (error) {
        if (!artwork || error?.name === "AbortError") throw error;
        await fs.rm(outputPath, { force: true }).catch(() => undefined);
        await m4aTag(sourcePath, outputPath, metadata, null, signal);
      }
    }
    const contentSha256 = await fileHash(finalPath);
    const processedDuplicate = duplicateTrack(input.existing, result.download.sha256, contentSha256);
    if (processedDuplicate) return { kind: "duplicate", track: processedDuplicate, sourceIdentity: completedSourceIdentity };
    const analysis = await analysisTask;
    assertNotAborted(signal);
    onStage({ stage: "saving_local" });
    await fs.mkdir(input.destinationDirectory, { recursive: true });
    const extension = tags ? ".m4a" : path.extname(sourcePath);
    const preferred = `${safeFilename(`${metadata.artist} - ${metadata.title}`) || `Track-${randomUUID()}`}${extension}`;
    savedPath = await uniqueDestination(input.destinationDirectory, preferred);
    await fileMove(finalPath, savedPath);
    assertNotAborted(signal);
    const information = await fs.stat(savedPath);
    assertNotAborted(signal);
    return {
      kind: "created",
      mediaKind,
      filePath: savedPath,
      size: information.size,
      sourceSha256: result.download.sha256,
      contentSha256,
      sourceURL: metadata.sourceURL,
      sourceIdentity: completedSourceIdentity,
      metadata,
      analysis,
    };
  } catch (error) {
    if (savedPath) await fs.rm(savedPath, { force: true }).catch(() => undefined);
    throw error;
  } finally {
    // A study still reading the download finishes (or stops, if cancelled) before its folder goes.
    await pendingAnalysis?.catch(() => undefined);
    await fs.rm(temporary, { recursive: true, force: true }).catch(() => undefined);
  }
}

module.exports = {
  PREPARED_SOUNDCLOUD_AUDIO_TTL_MS,
  artworkFileDataURL,
  completedSoundCloudDownload,
  createPreparedSoundCloudAudioHandoff,
  duplicateTrack,
  fetchArtwork,
  ffmpegExecutable,
  hasFFmpeg,
  importConfirmedSource,
  m4aTagArguments,
  mp4MuxArguments,
  normalizedMetadata,
  resolveLocalImportDownloadSource,
  resolveLocalImportMetadata,
  resolveLocalImportSource,
  runFFmpeg,
  safeArtworkURL,
  tagM4A,
};
