const { createHash, randomUUID } = require("node:crypto");
const { createReadStream } = require("node:fs");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { sanitizeWindowsFilename, windowsCollisionFilename } = require("./filename-policy.cjs");
const { normalizeSourceIdentity } = require("./provenance.cjs");
const {
  LocalImportError,
  isSpotifyURL,
  spotifyPlaylistURL,
  resolveSpotifyPlaylist,
  resolveSpotifyTrack,
  resolveYouTubePlaylist,
  searchYouTubeAudioSources,
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
  const album = cleanMetadata(value?.album, cleanMetadata(fallback.album, "Imported"));
  const sourceURL = typeof value?.sourceURL === "string" ? value.sourceURL.slice(0, 8_192) : fallback.sourceURL || null;
  const artworkURL = typeof value?.artworkURL === "string" ? value.artworkURL.slice(0, 2_048) : fallback.artworkURL || null;
  return { title, artist, album, sourceURL, artworkURL };
}

function safeFilename(value) {
  return sanitizeWindowsFilename(value, { pathInput: false });
}

async function uniqueDestination(directory, preferred) {
  const clean = safeFilename(preferred) || `Track-${Date.now()}.m4a`;
  const extension = path.extname(clean) || ".m4a";
  const base = path.basename(clean, path.extname(clean));
  let candidate = path.join(directory, `${base}${extension}`);
  for (let counter = 2; ; counter += 1) {
    try { await fs.access(candidate); }
    catch { return candidate; }
    candidate = path.join(directory, windowsCollisionFilename(`${base}${extension}`, counter));
  }
}

async function hashFile(filePath) {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(filePath);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", () => resolve(hash.digest("hex")));
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

async function moveFile(source, destination) {
  try { await fs.rename(source, destination); }
  catch (error) {
    if (error?.code !== "EXDEV") throw error;
    await fs.copyFile(source, destination);
    await fs.rm(source, { force: true });
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
    onStage({ stage: "searching_candidates", completed: 0, total: playlist.items.length });
    const matched = [];
    let completed = 0;
    for (let offset = 0; offset < playlist.items.length; offset += 4) {
      const chunk = playlist.items.slice(offset, offset + 4);
      const results = await Promise.all(chunk.map(async (sourceTrack) => {
        const track = publicSoundCloudMetadata(sourceTrack);
        const direct = sourceTrack.directlyImportable ? directSoundCloudCandidate(sourceTrack) : null;
        if (direct) {
          return { ...direct, importMetadata: track, playlistIndex: track.trackNumber, fallbackCandidates: [] };
        }
        let alternatives = [];
        try {
          alternatives = await candidateSearch(track, signal, undefined, { maxResults: 3, enrich: false });
        } catch (error) {
          if (error?.name === "AbortError") throw error;
        }
        const candidate = alternatives[0] || null;
        if (!candidate) return null;
        return {
          ...candidate,
          importMetadata: track,
          playlistIndex: track.trackNumber,
          fallbackCandidates: alternatives.slice(1)
            .filter((value) => value && typeof value.sourceURL === "string")
            .slice(0, 2),
        };
      }));
      matched.push(...results.filter(Boolean));
      completed += chunk.length;
      onStage({ stage: "searching_candidates", completed, total: playlist.items.length });
    }
    if (!matched.length) {
      throw localImportError("searching_candidates", "NO_AUDIO_MATCH", "No public audio source could be imported from this SoundCloud playlist.");
    }
    const durationSeconds = playlist.items.reduce((total, item) => total + (item.durationSeconds || 0), 0) || null;
    const unavailableCount = playlist.unavailableCount + playlist.items.length - matched.length;
    return {
      kind: "soundcloud_playlist",
      mediaKind: "audio",
      playlist: { ...playlist, unavailableCount },
      track: {
        provider: "soundcloud",
        type: "playlist",
        trackID: playlist.playlistID,
        title: playlist.title,
        artist: playlist.author || "SoundCloud",
        album: null,
        trackNumber: null,
        durationSeconds,
        artworkURL: playlist.artworkURL,
        embedURL: null,
        sourceURL: playlist.sourceURL,
      },
      candidates: matched,
    };
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
    if (playlist) {
      onStage({ stage: "searching_candidates", completed: 0, total: playlist.items.length });
      const matched = [];
      let completed = 0;
      for (let offset = 0; offset < playlist.items.length; offset += 4) {
        const chunk = playlist.items.slice(offset, offset + 4);
        const results = await Promise.all(chunk.map(async (track) => {
          try {
            // Keep a small ordered fallback set for each item. A metadata
            // match can fail during the later byte-transfer probe even when a
            // second provider candidate is usable; dropping it here turns one
            // bad match into an avoidable playlist failure.
            const candidates = await candidateSearch(track, signal, undefined, { maxResults: 3, enrich: false });
            const [candidate, ...fallbackCandidates] = Array.isArray(candidates) ? candidates : [];
            return candidate
              ? {
                ...candidate,
                importMetadata: track,
                playlistIndex: track.trackNumber,
                fallbackCandidates: fallbackCandidates.filter((value) => value && typeof value.sourceURL === "string").slice(0, 2),
              }
              : null;
          } catch (error) {
            if (error?.name === "AbortError") throw error;
            return null;
          }
        }));
        matched.push(...results.filter(Boolean));
        completed += chunk.length;
        onStage({ stage: "searching_candidates", completed, total: playlist.items.length });
      }
      if (!matched.length) {
        throw localImportError("searching_candidates", "NO_AUDIO_MATCH", "No file-backed audio source matched the public tracks in this Spotify playlist.");
      }
      const durationSeconds = playlist.items.reduce((total, item) => total + (item.durationSeconds || 0), 0) || null;
      const unavailableCount = playlist.unavailableCount + playlist.items.length - matched.length;
      return {
        kind: "spotify_playlist",
        mediaKind: "audio",
        playlist: { ...playlist, unavailableCount },
        track: {
          provider: "spotify",
          type: "playlist",
          trackID: playlist.playlistID,
          title: playlist.title,
          artist: playlist.author || "Spotify",
          album: null,
          trackNumber: null,
          durationSeconds,
          artworkURL: playlist.artworkURL,
          embedURL: null,
          sourceURL: playlist.sourceURL,
        },
        candidates: matched,
      };
    }
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
  const sourcePath = path.join(temporary, mediaKind === "video" ? "source.mp4" : soundCloudSource ? "source.mp3" : "source.m4a");
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
    } else {
      result = await youtubeDownload(input.sourceURL, sourcePath, signal, downloadProgress);
    }
    assertNotAborted(signal);
    const enrichedMetadata = metadataSnapshot.settled ? metadataSnapshot.metadata : null;
    const metadata = normalizedMetadata({ ...input.metadata, ...(enrichedMetadata || {}) }, {
      title: result.preview.title,
      artist: result.preview.author || "Unknown uploader",
      album: "Imported",
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
        await runFFmpeg(mp4MuxArguments(
          result.separateStreams.video.path,
          result.separateStreams.audio.path,
          sourcePath,
          metadata,
        ), signal);
        sourceSha256 = await fileHash(sourcePath);
      }
      if (!sourceSha256) throw localImportError("processing", "VIDEO_HASH_FAILED", "The completed video could not be verified.");
      const existingDuplicate = duplicateTrack(input.existing, sourceSha256);
      if (existingDuplicate) return { kind: "duplicate", track: existingDuplicate, sourceIdentity: completedSourceIdentity };
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
      };
    }
    const existingDuplicate = duplicateTrack(input.existing, result.download.sha256);
    if (existingDuplicate) return { kind: "duplicate", track: existingDuplicate, sourceIdentity: completedSourceIdentity };
    onStage({ stage: "processing", progress: null });
    const artwork = await artworkFetch(metadata.artworkURL, temporary, signal).catch((error) => {
      if (error?.name === "AbortError") throw error;
      return null;
    });
    try {
      await m4aTag(sourcePath, outputPath, metadata, artwork, signal);
    } catch (error) {
      if (!artwork || error?.name === "AbortError") throw error;
      await fs.rm(outputPath, { force: true }).catch(() => undefined);
      await m4aTag(sourcePath, outputPath, metadata, null, signal);
    }
    const contentSha256 = await fileHash(outputPath);
    const processedDuplicate = duplicateTrack(input.existing, result.download.sha256, contentSha256);
    if (processedDuplicate) return { kind: "duplicate", track: processedDuplicate, sourceIdentity: completedSourceIdentity };
    assertNotAborted(signal);
    onStage({ stage: "saving_local" });
    await fs.mkdir(input.destinationDirectory, { recursive: true });
    const preferred = `${safeFilename(`${metadata.artist} - ${metadata.title}`) || `Track-${randomUUID()}`}.m4a`;
    savedPath = await uniqueDestination(input.destinationDirectory, preferred);
    await fileMove(outputPath, savedPath);
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
    };
  } catch (error) {
    if (savedPath) await fs.rm(savedPath, { force: true }).catch(() => undefined);
    throw error;
  } finally {
    await fs.rm(temporary, { recursive: true, force: true }).catch(() => undefined);
  }
}

module.exports = {
  PREPARED_SOUNDCLOUD_AUDIO_TTL_MS,
  artworkFileDataURL,
  createPreparedSoundCloudAudioHandoff,
  duplicateTrack,
  fetchArtwork,
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
