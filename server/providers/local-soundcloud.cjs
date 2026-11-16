const { readResponseBytes } = require("./response-body.cjs");
const { createHash } = require("node:crypto");
const fs = require("node:fs/promises");
const { constants: fsConstants } = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { LocalImportError } = require("./local-import-core.cjs");

const SOUNDCLOUD_SOURCE_HOSTS = new Set([
  "soundcloud.com",
  "www.soundcloud.com",
  "m.soundcloud.com",
  "on.soundcloud.com",
]);
const SOUNDCLOUD_API_HOST = "api-v2.soundcloud.com";
const SOUNDCLOUD_MEDIA_HOST = /(^|\.)sndcdn\.com$/i;
const SOUNDCLOUD_ARTWORK_HOST = /(^|\.)sndcdn\.com$/i;
const MAX_SOURCE_LENGTH = 8_192;
const MAX_PAGE_BYTES = 8 * 1024 * 1024;
const MAX_API_BYTES = 8 * 1024 * 1024;
const MAX_AUDIO_BYTES = 256 * 1024 * 1024;
const MAX_PLAYLIST_ITEMS = 500;
const WEB_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) " +
  "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36";
const STREAM_HEADERS = Object.freeze({
  Accept: "audio/mpeg,*/*;q=0.5",
  "Accept-Encoding": "identity",
  "User-Agent": WEB_USER_AGENT,
});

function soundCloudError(code, message, options = {}) {
  return new LocalImportError(options.stage || "resolving_metadata", code, message, options);
}

function cleanText(value, maximum = 500) {
  if (typeof value !== "string") return null;
  const cleaned = value.replace(/[\u0000-\u001f]+/g, " ").replace(/\s+/g, " ").trim();
  return cleaned ? cleaned.slice(0, maximum) : null;
}

function safeInteger(value) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= 0 ? number : null;
}

function soundCloudSourceURL(value) {
  if (typeof value !== "string" || !value.trim() || value.length > MAX_SOURCE_LENGTH) {
    throw soundCloudError("INVALID_SOUNDCLOUD_URL", "Source must be a SoundCloud track or playlist URL.");
  }
  let url;
  try { url = new URL(value.trim()); }
  catch { throw soundCloudError("INVALID_SOUNDCLOUD_URL", "Source must be a SoundCloud track or playlist URL."); }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    !SOUNDCLOUD_SOURCE_HOSTS.has(url.hostname.toLowerCase()) ||
    !url.pathname.split("/").filter(Boolean).length
  ) {
    throw soundCloudError("INVALID_SOUNDCLOUD_URL", "Source must be a SoundCloud track or playlist URL.");
  }
  return url;
}

function isSoundCloudURL(value) {
  try {
    soundCloudSourceURL(value);
    return true;
  } catch {
    return false;
  }
}

function soundCloudArtworkURL(value) {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    if (url.protocol === "https:" && !url.username && !url.password && SOUNDCLOUD_ARTWORK_HOST.test(url.hostname)) {
      return url.toString();
    }
  } catch {
    // Artwork is optional and malformed artwork does not invalidate metadata.
  }
  return null;
}

function safePageURL(value) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password && SOUNDCLOUD_SOURCE_HOSTS.has(url.hostname.toLowerCase());
  } catch {
    return false;
  }
}

function safeAPIURL(value) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password && url.hostname.toLowerCase() === SOUNDCLOUD_API_HOST;
  } catch {
    return false;
  }
}

function safeMediaURL(value) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password && SOUNDCLOUD_MEDIA_HOST.test(url.hostname);
  } catch {
    return false;
  }
}

async function fetchWithValidatedRedirects(source, options, isAllowed, fetchImpl, stage = "resolving_metadata") {
  let current;
  try { current = new URL(source); }
  catch { throw soundCloudError("SOUNDCLOUD_UNSAFE_REDIRECT", "SoundCloud returned an unsafe redirect.", { stage }); }
  if (!isAllowed(current.toString())) {
    throw soundCloudError("SOUNDCLOUD_UNSAFE_REDIRECT", "SoundCloud returned an unsafe redirect.", { stage });
  }
  for (let redirects = 0; redirects <= 5; redirects += 1) {
    let response;
    try { response = await fetchImpl(current, { ...options, redirect: "manual" }); }
    catch (error) {
      if (error?.name === "AbortError") throw error;
      throw soundCloudError("SOUNDCLOUD_UNREACHABLE", "SoundCloud could not be reached.", { stage });
    }
    if (![301, 302, 303, 307, 308].includes(response.status)) return response;
    const location = response.headers.get("location");
    await response.body?.cancel().catch(() => undefined);
    if (!location) throw soundCloudError("SOUNDCLOUD_UNSAFE_REDIRECT", "SoundCloud returned an unsafe redirect.", { stage });
    try { current = new URL(location, current); }
    catch { throw soundCloudError("SOUNDCLOUD_UNSAFE_REDIRECT", "SoundCloud returned an unsafe redirect.", { stage }); }
    if (!isAllowed(current.toString())) {
      throw soundCloudError("SOUNDCLOUD_UNSAFE_REDIRECT", "SoundCloud returned an unsafe redirect.", { stage });
    }
  }
  throw soundCloudError("SOUNDCLOUD_TOO_MANY_REDIRECTS", "SoundCloud redirected the request too many times.", { stage });
}

function responseBytesWithLimit(response, limit, stage = "resolving_metadata") {
  return readResponseBytes(response, limit,
    soundCloudError("SOUNDCLOUD_RESPONSE_TOO_LARGE", "SoundCloud returned an oversized response.", { stage }));
}

function providerFailure(response, resource = "source", stage = "resolving_metadata") {
  if (response.status === 404) {
    return soundCloudError("SOUNDCLOUD_NOT_FOUND", `SoundCloud could not find that ${resource}.`, { stage });
  }
  if (response.status === 429) {
    return soundCloudError("SOUNDCLOUD_RATE_LIMITED", "SoundCloud rate-limited this request. Try again shortly.", {
      stage,
      retryAfter: response.headers.get("retry-after"),
    });
  }
  return soundCloudError("SOUNDCLOUD_PROVIDER_FAILED", `SoundCloud could not load that ${resource}.`, { stage });
}

function soundCloudProbeTotal(value) {
  const match = typeof value === "string" ? /^bytes\s+0-0\/(\d+)$/i.exec(value.trim()) : null;
  if (!match) return null;
  const total = Number(match[1]);
  return Number.isSafeInteger(total) && total > 0 && total <= MAX_AUDIO_BYTES ? total : null;
}

function balancedJSONArray(source, start) {
  let depth = 0;
  let quoted = false;
  let escaped = false;
  for (let index = start; index < source.length; index += 1) {
    const character = source[index];
    if (quoted) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') quoted = false;
    } else if (character === '"') {
      quoted = true;
    } else if (character === "[") {
      depth += 1;
    } else if (character === "]") {
      depth -= 1;
      if (depth === 0) return source.slice(start, index + 1);
    }
  }
  return null;
}

function parseSoundCloudHydration(html) {
  if (typeof html !== "string" || html.length > MAX_PAGE_BYTES) {
    throw soundCloudError("SOUNDCLOUD_INVALID_RESPONSE", "SoundCloud returned invalid page metadata.");
  }
  const marker = "window.__sc_hydration";
  const markerIndex = html.indexOf(marker);
  const start = markerIndex >= 0 ? html.indexOf("[", markerIndex + marker.length) : -1;
  const json = start >= 0 ? balancedJSONArray(html, start) : null;
  let values;
  try { values = json ? JSON.parse(json) : null; }
  catch { values = null; }
  if (!Array.isArray(values)) {
    throw soundCloudError("SOUNDCLOUD_INVALID_RESPONSE", "SoundCloud returned invalid page metadata.");
  }
  const hydration = new Map();
  for (const value of values) {
    if (value && typeof value.hydratable === "string" && value.data && typeof value.data === "object") {
      hydration.set(value.hydratable, value.data);
    }
  }
  return hydration;
}

function normalizedPermalink(value) {
  try {
    const url = soundCloudSourceURL(value);
    if (url.hostname === "www.soundcloud.com" || url.hostname === "m.soundcloud.com") url.hostname = "soundcloud.com";
    url.search = "";
    url.hash = "";
    url.pathname = url.pathname.replace(/\/+$/, "") || "/";
    return url.toString();
  } catch {
    return null;
  }
}

function progressiveTranscoding(record) {
  const values = Array.isArray(record?.media?.transcodings) ? record.media.transcodings : [];
  return values.find((value) =>
    value && value.snipped !== true && value.format?.protocol === "progressive" &&
    typeof value.format?.mime_type === "string" && value.format.mime_type.toLowerCase().startsWith("audio/mpeg") &&
    safeAPIURL(value.url)) || null;
}

/**
 * The full song as HLS (AAC in MP4 segments), which is all SoundCloud offers for many tracks now. Joined into one
 * file by ffmpeg (see materializeHLS), so only usable where ffmpeg is. Never a preview cut ("snipped").
 */
function hlsTranscoding(record) {
  if (!hasFFmpeg()) return null;
  const values = Array.isArray(record?.media?.transcodings) ? record.media.transcodings : [];
  const usable = values.filter((value) =>
    value && value.snipped !== true && value.format?.protocol === "hls" && typeof value.format?.mime_type === "string" &&
    safeAPIURL(value.url));
  // The best AAC first; the "abr" (adaptive) playlist and MP3 segments are left out, as ffmpeg can't copy those as one AAC stream.
  const aac = usable.filter((value) => /^audio\/mp4/i.test(value.format.mime_type))
    .sort((left, right) => (Number(/(\d+)k/.exec(right.preset || "")?.[1]) || 0) - (Number(/(\d+)k/.exec(left.preset || "")?.[1]) || 0));
  return aac[0] || null;
}

function ffmpegExecutable() {
  try {
    const executable = require("ffmpeg-static");
    return typeof executable === "string" && executable ? executable.replace(/app\.asar([\\/])/i, "app.asar.unpacked$1") : null;
  } catch {
    return null;
  }
}

const hasFFmpeg = () => Boolean(ffmpegExecutable());

function parseSoundCloudTrack(record, position = null) {
  if (!record || record.kind !== "track") return null;
  const id = safeInteger(record.id);
  const title = cleanText(record.title);
  const artist = cleanText(record.publisher_metadata?.artist) || cleanText(record.user?.username);
  const sourceURL = normalizedPermalink(record.permalink_url);
  if (id === null || !title || !artist || !sourceURL) return null;
  const durationMilliseconds = safeInteger(record.full_duration) ?? safeInteger(record.duration);
  const album = cleanText(record.publisher_metadata?.album_title)
    || cleanText(record.publisher_metadata?.release_title)
    || cleanText(record.label_name);
  const directlyImportable = record.streamable !== false && record.policy !== "BLOCK" &&
    Boolean(cleanText(record.track_authorization, 2_048)) && Boolean(progressiveTranscoding(record) || hlsTranscoding(record));
  return {
    provider: "soundcloud",
    type: "track",
    trackID: String(id),
    title,
    artist,
    album,
    trackNumber: Number.isSafeInteger(position) ? position : null,
    durationSeconds: durationMilliseconds ? Math.round(durationMilliseconds / 1_000) : null,
    artworkURL: soundCloudArtworkURL(record.artwork_url) || soundCloudArtworkURL(record.user?.avatar_url),
    creatorAvatarURL: soundCloudArtworkURL(record.user?.avatar_url),
    embedURL: "",
    sourceURL,
    directlyImportable,
    // Who posted it, which `artist` (the credited artist, when given) doesn't say: a fan's upload credits the artist too.
    uploader: cleanText(record.user?.username),
  };
}

function directSoundCloudCandidate(track) {
  return {
    videoID: `soundcloud:${track.trackID}`,
    title: track.title,
    artist: track.artist,
    album: track.album,
    durationSeconds: track.durationSeconds,
    thumbnailURL: track.artworkURL,
    sourceProvider: "soundcloud",
    officialArtist: true,
    sourceURL: track.sourceURL,
    score: 1,
    confidence: "direct",
    match: { title: 1, artist: 1, album: track.album ? 1 : null, duration: track.durationSeconds ? 1 : null, durationDeltaSeconds: 0 },
  };
}

async function loadSoundCloudPage(source, signal, fetchImpl) {
  const input = soundCloudSourceURL(source);
  const response = await fetchWithValidatedRedirects(input, {
    headers: { Accept: "text/html", "User-Agent": WEB_USER_AGENT },
    signal,
  }, safePageURL, fetchImpl);
  if (!response.ok) throw providerFailure(response);
  const finalURL = response.url && safePageURL(response.url) ? new URL(response.url) : input;
  const bytes = await responseBytesWithLimit(response, MAX_PAGE_BYTES);
  const html = new TextDecoder().decode(bytes);
  return { finalURL, hydration: parseSoundCloudHydration(html) };
}

function clientIDFromHydration(hydration) {
  const value = hydration.get("apiClient")?.id;
  return typeof value === "string" && /^[A-Za-z0-9_-]{20,80}$/.test(value) ? value : null;
}

async function fetchSoundCloudTracks(ids, clientID, signal, fetchImpl) {
  if (!ids.length || !clientID) return [];
  const components = new URL("https://api-v2.soundcloud.com/tracks");
  components.searchParams.set("ids", ids.join(","));
  components.searchParams.set("client_id", clientID);
  let response;
  try {
    response = await fetchImpl(components, {
      headers: { Accept: "application/json", "User-Agent": WEB_USER_AGENT },
      redirect: "error",
      signal,
    });
  } catch (error) {
    if (error?.name === "AbortError") throw error;
    return [];
  }
  if (!response.ok || !safeAPIURL(response.url || components.toString())) {
    await response.body?.cancel().catch(() => undefined);
    return [];
  }
  try {
    const bytes = await responseBytesWithLimit(response, MAX_API_BYTES);
    const values = JSON.parse(bytes.toString("utf8"));
    return Array.isArray(values) ? values : [];
  } catch (error) {
    if (error?.name === "AbortError") throw error;
    return [];
  }
}

async function resolveSoundCloudPlaylist(record, hydration, signal, fetchImpl) {
  const playlistID = safeInteger(record?.id);
  const title = cleanText(record?.title);
  const author = cleanText(record?.user?.username) || "SoundCloud";
  const sourceURL = normalizedPermalink(record?.permalink_url);
  if (record?.kind !== "playlist" || playlistID === null || !title || !sourceURL || !Array.isArray(record.tracks)) {
    throw soundCloudError("SOUNDCLOUD_INVALID_PLAYLIST", "SoundCloud returned invalid playlist metadata.");
  }
  const limited = record.tracks.slice(0, MAX_PLAYLIST_ITEMS);
  const recordsByID = new Map(limited.map((item) => [safeInteger(item?.id), item]).filter(([id]) => id !== null));
  const missingIDs = limited
    .filter((item) => !parseSoundCloudTrack(item))
    .map((item) => safeInteger(item?.id))
    .filter((id) => id !== null);
  const clientID = clientIDFromHydration(hydration);
  for (let offset = 0; offset < missingIDs.length; offset += 50) {
    const hydrated = await fetchSoundCloudTracks(missingIDs.slice(offset, offset + 50), clientID, signal, fetchImpl);
    for (const item of hydrated) {
      const id = safeInteger(item?.id);
      if (id !== null) recordsByID.set(id, item);
    }
  }
  const items = [];
  for (let index = 0; index < limited.length; index += 1) {
    const id = safeInteger(limited[index]?.id);
    const track = id === null ? null : parseSoundCloudTrack(recordsByID.get(id), index + 1);
    if (track) items.push(clientID ? track : { ...track, directlyImportable: false });
  }
  if (!items.length) {
    throw soundCloudError("SOUNDCLOUD_PLAYLIST_EMPTY", "This SoundCloud playlist has no public tracks that can be imported.");
  }
  const trackCount = safeInteger(record.track_count) ?? record.tracks.length;
  return {
    playlistID: String(playlistID),
    title,
    author,
    artworkURL: soundCloudArtworkURL(record.artwork_url) || soundCloudArtworkURL(record.user?.avatar_url),
    sourceURL,
    items,
    unavailableCount: Math.max(trackCount - items.length, 0),
    truncated: trackCount > MAX_PLAYLIST_ITEMS,
  };
}

async function resolveSoundCloudSource(source, signal, fetchImpl = fetch) {
  const { hydration } = await loadSoundCloudPage(source, signal, fetchImpl);
  const sound = hydration.get("sound");
  if (sound?.kind === "track") {
    const track = parseSoundCloudTrack(sound);
    if (!track) throw soundCloudError("SOUNDCLOUD_INVALID_TRACK", "SoundCloud returned invalid track metadata.");
    return {
      kind: "track",
      track: clientIDFromHydration(hydration) ? track : { ...track, directlyImportable: false },
    };
  }
  const playlistRecord = hydration.get("playlist");
  if (playlistRecord?.kind === "playlist") {
    const playlist = await resolveSoundCloudPlaylist(playlistRecord, hydration, signal, fetchImpl);
    return { kind: "playlist", playlist };
  }
  throw soundCloudError(
    "UNSUPPORTED_SOUNDCLOUD_RESOURCE",
    "Only individual SoundCloud tracks and public SoundCloud playlists are supported.",
  );
}

async function resolveSoundCloudAudio(source, signal, fetchImpl = fetch) {
  const { hydration } = await loadSoundCloudPage(source, signal, fetchImpl);
  const record = hydration.get("sound");
  const track = parseSoundCloudTrack(record);
  const clientID = clientIDFromHydration(hydration);
  const transcoding = progressiveTranscoding(record);
  const trackAuthorization = cleanText(record?.track_authorization, 2_048);
  const hls = !transcoding ? hlsTranscoding(record) : null;
  if (track && clientID && hls && trackAuthorization) return resolveSoundCloudHLS(track, hls, clientID, trackAuthorization, signal, fetchImpl);
  if (!track || !clientID || !transcoding || !trackAuthorization) {
    throw soundCloudError(
      "SOUNDCLOUD_STREAM_UNAVAILABLE",
      "This SoundCloud track does not provide a direct public audio rendition. Try another offered source.",
      { stage: "inspecting_source" },
    );
  }
  const endpoint = new URL(transcoding.url);
  endpoint.searchParams.set("client_id", clientID);
  endpoint.searchParams.set("track_authorization", trackAuthorization);
  let response;
  try {
    response = await fetchImpl(endpoint, {
      headers: { Accept: "application/json", "User-Agent": WEB_USER_AGENT },
      redirect: "error",
      signal,
    });
  } catch (error) {
    if (error?.name === "AbortError") throw error;
    throw soundCloudError("SOUNDCLOUD_STREAM_UNAVAILABLE", "SoundCloud could not prepare this audio stream.", { stage: "inspecting_source" });
  }
  if (!response.ok || !safeAPIURL(response.url || endpoint.toString())) {
    throw providerFailure(response, "audio stream", "inspecting_source");
  }
  const bytes = await responseBytesWithLimit(response, 64 * 1_024, "inspecting_source");
  let payload;
  try { payload = JSON.parse(bytes.toString("utf8")); }
  catch { payload = null; }
  if (!safeMediaURL(payload?.url)) {
    throw soundCloudError("SOUNDCLOUD_UNSAFE_STREAM", "SoundCloud returned an unsafe audio stream.", { stage: "inspecting_source" });
  }
  const probe = await fetchWithValidatedRedirects(payload.url, {
    headers: { ...STREAM_HEADERS, Range: "bytes=0-0" },
    signal,
  }, safeMediaURL, fetchImpl, "inspecting_source");
  if (probe.status === 403) {
    await probe.body?.cancel().catch(() => undefined);
    throw soundCloudError("SOUNDCLOUD_STREAM_EXPIRED", "SoundCloud rejected this audio rendition. Refresh the source and try again.", { stage: "inspecting_source" });
  }
  if (probe.status === 429) {
    await probe.body?.cancel().catch(() => undefined);
    throw providerFailure(probe, "audio stream", "inspecting_source");
  }
  const contentLength = soundCloudProbeTotal(probe.headers.get("content-range"));
  const responseLength = Number(probe.headers.get("content-length") || 0);
  const contentType = (probe.headers.get("content-type") || "").split(";", 1)[0].trim().toLowerCase();
  if (probe.status !== 206 || !safeMediaURL(probe.url || payload.url) || responseLength !== 1 || !contentLength) {
    await probe.body?.cancel().catch(() => undefined);
    throw soundCloudError("SOUNDCLOUD_INVALID_STREAM", "SoundCloud returned an unverifiable audio stream.", { stage: "inspecting_source" });
  }
  if (contentType && contentType !== "audio/mpeg" && contentType !== "application/octet-stream") {
    await probe.body?.cancel().catch(() => undefined);
    throw soundCloudError("SOUNDCLOUD_INVALID_STREAM", "SoundCloud returned an invalid audio stream.", { stage: "inspecting_source" });
  }
  const reader = probe.body?.getReader();
  if (!reader) {
    throw soundCloudError("SOUNDCLOUD_INVALID_STREAM", "SoundCloud returned no audio stream data.", { stage: "inspecting_source" });
  }
  const first = await reader.read();
  const second = await reader.read();
  if (first.done || first.value?.byteLength !== 1 || !second.done) {
    await reader.cancel().catch(() => undefined);
    throw soundCloudError("SOUNDCLOUD_INVALID_STREAM", "SoundCloud returned an unverifiable audio stream.", { stage: "inspecting_source" });
  }
  return {
    track,
    streamingURL: probe.url || payload.url,
    contentLength,
    // Its storage's ETag, usually the file's MD5, which names its exact bytes (duplicate checks compare it).
    etag: probe.headers.get("etag") || null,
    contentType: "audio/mpeg",
    durationSeconds: track.durationSeconds,
    sourceURL: track.sourceURL,
  };
}

/*
 * HLS-only tracks are joined into one local M4A (AAC copied as it is, moov first so its start decodes on its own)
 * and kept a little while, so the preview, the duplicate check and the save of one song share one fetch. The rest
 * of the app then treats it like any resolved stream: `localFile` stands in for the streaming URL.
 */
const HLS_CACHE_MS = 30 * 60_000;
/** At most this many joined tracks are kept at once (a playlist's worth of previews), oldest dropped first. */
const MAX_HLS_FILES = 30;
const hlsFiles = new Map();
/** One folder for these files, so ones left by an earlier run (stopped mid-join, or before they aged out) are found. */
const HLS_DIRECTORY = path.join(os.tmpdir(), "slopify-soundcloud");
let hlsSwept = false;
let hlsSweepTimer = null;

/**
 * Removes joined files no longer wanted: past their time, beyond the count, and (once a run) any in the folder this
 * run doesn't know that are past their time, which earlier runs left. Another running copy's recent files stay.
 */
async function sweepHLS() {
  const now = Date.now();
  const done = [...hlsFiles].filter(([, entry]) => !entry.pending);
  const extra = done.length - MAX_HLS_FILES;
  for (const [index, [id, entry]] of done.entries()) {
    if (now - entry.at > HLS_CACHE_MS || index < extra) {
      hlsFiles.delete(id);
      await fs.rm(entry.file, { force: true }).catch(() => undefined);
    }
  }
  if (hlsSwept) return;
  hlsSwept = true;
  const known = new Set([...hlsFiles.values()].map((entry) => entry.file));
  for (const name of await fs.readdir(HLS_DIRECTORY).catch(() => [])) {
    const file = path.join(HLS_DIRECTORY, name);
    if (known.has(file)) continue;
    const stat = await fs.stat(file).catch(() => null);
    if (stat && now - stat.mtimeMs > HLS_CACHE_MS) await fs.rm(file, { force: true }).catch(() => undefined);
  }
}

async function materializeHLS(trackID, playlistURL, signal, fetchImpl = fetch) {
  const known = hlsFiles.get(trackID);
  if (known?.pending) return known.pending;
  if (known && Date.now() - known.at < HLS_CACHE_MS) {
    const stat = await fs.stat(known.file).catch(() => null);
    if (stat?.size) return { file: known.file, size: stat.size };
  }
  // Files nobody asks for again still age out while the app runs.
  hlsSweepTimer ??= setInterval(() => void sweepHLS().catch(() => undefined), HLS_CACHE_MS);
  hlsSweepTimer.unref?.();
  const work = (async () => {
    await fs.mkdir(HLS_DIRECTORY, { recursive: true });
    await sweepHLS();
    const stamp = `${trackID}-${Date.now()}-${process.pid}`;
    const file = path.join(HLS_DIRECTORY, `${stamp}.m4a`);
    const listFile = path.join(HLS_DIRECTORY, `${stamp}.m3u8`);
    try {
      // The playlist is read here and every address in it checked (SoundCloud's media hosts, HTTPS), then handed to
      // ffmpeg as a local copy with absolute addresses, so ffmpeg fetches nothing else.
      await fs.writeFile(listFile, await fetchHLSPlaylist(playlistURL, signal, fetchImpl));
      await runFFmpeg([
        "-y", "-nostdin", "-loglevel", "error",
        "-protocol_whitelist", "file,https,tls,tcp,crypto",
        "-i", listFile, "-map", "0:a:0", "-vn", "-c:a", "copy", "-movflags", "+faststart", "-f", "mp4", file,
      ], signal);
      const stat = await fs.stat(file);
      if (!stat.size || stat.size > MAX_AUDIO_BYTES) {
        throw soundCloudError("SOUNDCLOUD_INVALID_STREAM", "SoundCloud returned an unusable audio stream.", { stage: "inspecting_source" });
      }
      return { file, size: stat.size };
    } catch (error) {
      // A failed or stopped join leaves nothing behind.
      await fs.rm(file, { force: true }).catch(() => undefined);
      throw error;
    } finally {
      await fs.rm(listFile, { force: true }).catch(() => undefined);
    }
  })();
  hlsFiles.set(trackID, { pending: work, at: 0 });
  try {
    const result = await work;
    if (hlsFiles.get(trackID)?.pending === work) {
      hlsFiles.delete(trackID);
      hlsFiles.set(trackID, { file: result.file, at: Date.now() });
    }
    if (known?.file && known.file !== result.file) await fs.rm(known.file, { force: true }).catch(() => undefined);
    return result;
  } catch (error) {
    if (hlsFiles.get(trackID)?.pending === work) hlsFiles.delete(trackID);
    throw error;
  }
}

/** SoundCloud's HLS hosts: its CDN and its newer media-streaming service. */
const SOUNDCLOUD_HLS_HOST = /(^|\.)(sndcdn\.com|media-streaming\.soundcloud\.cloud)$/i;
function safeHLSURL(value) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password && SOUNDCLOUD_HLS_HOST.test(url.hostname);
  } catch {
    return false;
  }
}

/** An HLS playlist with every address made absolute, after checking each is on SoundCloud's media hosts. */
async function fetchHLSPlaylist(playlistURL, signal, fetchImpl = fetch) {
  const response = await fetchWithValidatedRedirects(playlistURL, { headers: { "User-Agent": WEB_USER_AGENT }, signal }, safeHLSURL, fetchImpl, "inspecting_source");
  if (!response.ok) throw providerFailure(response, "audio stream", "inspecting_source");
  const base = response.url && safeHLSURL(response.url) ? response.url : playlistURL;
  const text = (await responseBytesWithLimit(response, 1024 * 1024, "inspecting_source")).toString("utf8");
  if (!text.startsWith("#EXTM3U")) throw soundCloudError("SOUNDCLOUD_INVALID_STREAM", "SoundCloud returned an invalid audio playlist.", { stage: "inspecting_source" });
  const absolute = (value) => {
    const url = new URL(value, base).toString();
    if (!safeHLSURL(url)) throw soundCloudError("SOUNDCLOUD_UNSAFE_STREAM", "SoundCloud returned an unsafe audio stream.", { stage: "inspecting_source" });
    return url;
  };
  let segments = 0;
  const lines = text.split(/\r?\n/).map((line) => {
    if (!line) return line;
    // Tags carrying an address (the init segment, keys).
    if (line.startsWith("#")) return line.replace(/URI="([^"]+)"/g, (_, uri) => `URI="${absolute(uri)}"`);
    segments += 1;
    return absolute(line.trim());
  });
  if (!segments) throw soundCloudError("SOUNDCLOUD_INVALID_STREAM", "SoundCloud returned an empty audio playlist.", { stage: "inspecting_source" });
  return lines.join("\n");
}

function runFFmpeg(args, signal) {
  const executable = ffmpegExecutable();
  if (!executable) {
    return Promise.reject(soundCloudError("SOUNDCLOUD_STREAM_UNAVAILABLE", "This SoundCloud track needs the local media processor, which this build lacks.", { stage: "inspecting_source" }));
  }
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
    const child = spawn(executable, args, { stdio: ["ignore", "ignore", "pipe"], windowsHide: true });
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
      finish(reject, new DOMException("Aborted", "AbortError"));
    };
    signal?.addEventListener("abort", cancel, { once: true });
    child.stderr.on("data", (chunk) => { stderr = `${stderr}${chunk}`.slice(-4_096); });
    child.on("error", () => finish(reject, soundCloudError("SOUNDCLOUD_STREAM_UNAVAILABLE", "The local media processor could not start.", { stage: "inspecting_source" })));
    child.on("close", (code) => {
      if (code === 0) finish(resolve, true);
      else finish(reject, soundCloudError("SOUNDCLOUD_STREAM_UNAVAILABLE", `SoundCloud's audio couldn't be fetched${stderr ? ` (${cleanText(stderr, 300)})` : ""}.`, { stage: "inspecting_source" }));
    });
  });
}

/** A resolved HLS-only track: its full audio joined into a local M4A (see materializeHLS). */
async function resolveSoundCloudHLS(track, transcoding, clientID, trackAuthorization, signal, fetchImpl) {
  const endpoint = new URL(transcoding.url);
  endpoint.searchParams.set("client_id", clientID);
  endpoint.searchParams.set("track_authorization", trackAuthorization);
  let response;
  try {
    response = await fetchImpl(endpoint, { headers: { Accept: "application/json", "User-Agent": WEB_USER_AGENT }, redirect: "error", signal });
  } catch (error) {
    if (error?.name === "AbortError") throw error;
    throw soundCloudError("SOUNDCLOUD_STREAM_UNAVAILABLE", "SoundCloud could not prepare this audio stream.", { stage: "inspecting_source" });
  }
  if (!response.ok || !safeAPIURL(response.url || endpoint.toString())) throw providerFailure(response, "audio stream", "inspecting_source");
  let payload;
  try { payload = JSON.parse((await responseBytesWithLimit(response, 64 * 1_024, "inspecting_source")).toString("utf8")); }
  catch { payload = null; }
  if (!safeHLSURL(payload?.url)) {
    throw soundCloudError("SOUNDCLOUD_UNSAFE_STREAM", "SoundCloud returned an unsafe audio stream.", { stage: "inspecting_source" });
  }
  const { file, size } = await materializeHLS(track.trackID, payload.url, signal, fetchImpl);
  return {
    track,
    streamingURL: payload.url,
    localFile: file,
    contentLength: size,
    etag: null,
    contentType: "audio/mp4",
    format: "m4a",
    durationSeconds: track.durationSeconds,
    sourceURL: track.sourceURL,
  };
}

async function writeAll(file, bytes) {
  let offset = 0;
  while (offset < bytes.length) {
    const { bytesWritten } = await file.write(bytes, offset, bytes.length - offset);
    if (!bytesWritten) {
      throw soundCloudError("LOCAL_WRITE_FAILED", "The temporary SoundCloud audio file could not be written.", { stage: "downloading" });
    }
    offset += bytesWritten;
  }
}

/** The verified length of a `Content-Range: bytes start-end/total` answer, or 0 when it isn't the range asked for. */
function verifiedSoundCloudRange(value, start, end, total) {
  const match = typeof value === "string" ? /^bytes\s+(\d+)-(\d+)\/(\d+)$/i.exec(value.trim()) : null;
  if (!match || Number(match[1]) !== start || Number(match[2]) !== end || Number(match[3]) !== total) return 0;
  return end - start + 1;
}

/** Bytes `start` up to (not including) `end` of a resolved stream, without downloading the rest (see the duplicate check). */
async function fetchResolvedSoundCloudRange(resolved, start, end, signal, fetchImpl = fetch) {
  const last = Math.min(end, resolved.contentLength) - 1;
  if (!Number.isSafeInteger(start) || start < 0 || last < start) return Buffer.alloc(0);
  if (resolved.localFile) {
    const handle = await fs.open(resolved.localFile, "r");
    try {
      const bytes = Buffer.alloc(last - start + 1);
      const { bytesRead } = await handle.read(bytes, 0, bytes.length, start);
      return bytes.subarray(0, bytesRead);
    } finally {
      await handle.close().catch(() => undefined);
    }
  }
  const response = await fetchWithValidatedRedirects(resolved.streamingURL, {
    headers: { ...STREAM_HEADERS, Range: `bytes=${start}-${last}` },
    signal,
  }, safeMediaURL, fetchImpl, "inspecting_source");
  const expected = response.status === 206 && safeMediaURL(response.url || resolved.streamingURL)
    ? verifiedSoundCloudRange(response.headers.get("content-range"), start, last, resolved.contentLength)
    : 0;
  if (!expected || !response.body) {
    await response.body?.cancel().catch(() => undefined);
    throw soundCloudError("SOUNDCLOUD_INVALID_STREAM", "SoundCloud returned an unverifiable audio range.", { stage: "inspecting_source" });
  }
  const bytes = await readResponseBytes(response, expected, soundCloudError("SOUNDCLOUD_SIZE_MISMATCH", "SoundCloud returned more audio than asked for.", { stage: "inspecting_source" }));
  if (bytes.length !== expected) throw soundCloudError("SOUNDCLOUD_SIZE_MISMATCH", "SoundCloud ended an audio range early.", { stage: "inspecting_source" });
  return bytes;
}

/**
 * `prefix`: the stream's first bytes, already fetched (by the duplicate check), so only the rest
 * is downloaded. They are written and hashed as if they had just arrived.
 */
async function downloadResolvedSoundCloudAudio(resolved, destination, signal, onProgress = () => {}, fetchImpl = fetch, { prefix = null } = {}) {
  if (resolved.localFile) {
    // Already fetched whole (an HLS track): copied, and hashed as it is.
    await fs.copyFile(resolved.localFile, destination, fsConstants.COPYFILE_EXCL);
    const bytes = await fs.readFile(destination);
    onProgress(bytes.length, bytes.length);
    return { sha256: createHash("sha256").update(bytes).digest("hex"), bytesWritten: bytes.length, format: resolved.format || "m4a" };
  }
  if (prefix && (!Buffer.isBuffer(prefix) || prefix.length > resolved.contentLength)) prefix = null;
  const skip = prefix?.length || 0;
  const rest = resolved.contentLength - skip;
  let response = null;
  if (rest > 0) {
    response = await fetchWithValidatedRedirects(resolved.streamingURL, {
      headers: skip ? { ...STREAM_HEADERS, Range: `bytes=${skip}-${resolved.contentLength - 1}` } : STREAM_HEADERS,
      signal,
    }, safeMediaURL, fetchImpl, "downloading");
    if (!response.ok || !safeMediaURL(response.url || resolved.streamingURL) || !response.body) {
      throw providerFailure(response, "audio stream", "downloading");
    }
    const declared = Number(response.headers.get("content-length") || 0);
    const rangeOK = !skip || (response.status === 206
      && verifiedSoundCloudRange(response.headers.get("content-range"), skip, resolved.contentLength - 1, resolved.contentLength) === rest);
    if (declared !== rest || !rangeOK) {
      await response.body.cancel().catch(() => undefined);
      throw soundCloudError("SOUNDCLOUD_SIZE_MISMATCH", "SoundCloud returned an unverifiable audio size.", { stage: "downloading" });
    }
  }
  const file = await fs.open(destination, "wx");
  const hash = createHash("sha256");
  let completed = 0;
  try {
    if (skip) {
      hash.update(prefix);
      await writeAll(file, prefix);
      completed = skip;
      onProgress(completed, resolved.contentLength);
    }
    const reader = response ? response.body.getReader() : null;
    while (reader) {
      const { done, value } = await reader.read();
      if (done) break;
      completed += value.byteLength;
      if (completed > resolved.contentLength || completed > MAX_AUDIO_BYTES) {
        await reader.cancel().catch(() => undefined);
        throw soundCloudError("SOUNDCLOUD_SIZE_MISMATCH", "SoundCloud returned more audio than expected.", { stage: "downloading" });
      }
      const chunk = Buffer.from(value);
      hash.update(chunk);
      await writeAll(file, chunk);
      onProgress(completed, resolved.contentLength);
    }
    if (completed !== resolved.contentLength) {
      throw soundCloudError("SOUNDCLOUD_SIZE_MISMATCH", "SoundCloud ended the audio download before it was complete.", { stage: "downloading" });
    }
    return { sha256: hash.digest("hex"), bytesWritten: completed, format: "mp3" };
  } catch (error) {
    await fs.rm(destination, { force: true }).catch(() => undefined);
    if (error?.name === "AbortError") throw error;
    throw error;
  } finally {
    await file.close().catch(() => undefined);
  }
}

async function downloadSoundCloudAudio(source, destination, signal, onProgress = () => {}, fetchImpl = fetch) {
  const resolved = await resolveSoundCloudAudio(source, signal, fetchImpl);
  const download = await downloadResolvedSoundCloudAudio(resolved, destination, signal, onProgress, fetchImpl);
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

/*
 * Finding a song (from a Spotify playlist) on SoundCloud, where many producers post their own uploads. Scored like
 * YouTube matches (local-import-core.cjs scoreUnderNames), and only full tracks the app can fetch are offered.
 * `strong`: the best is the artist's own upload and scores well, good enough not to look on YouTube too.
 */
let searchSession = null;
const SEARCH_SESSION_MS = 30 * 60_000;

async function soundCloudSearchClientID(signal, fetchImpl, fresh = false) {
  if (!fresh && searchSession && Date.now() - searchSession.at < SEARCH_SESSION_MS) return searchSession.clientID;
  const { hydration } = await loadSoundCloudPage("https://soundcloud.com/search/sounds?q=music", signal, fetchImpl);
  const clientID = clientIDFromHydration(hydration);
  if (!clientID) throw Object.assign(soundCloudError("SOUNDCLOUD_SEARCH_UNAVAILABLE", "SoundCloud did not provide a search session.", { stage: "searching_candidates" }), { retryable: true });
  searchSession = { clientID, at: Date.now() };
  return clientID;
}

async function searchSoundCloudAudioSources(track, signal, fetchImpl = fetch, options = {}) {
  const { artistsOwnChannel, ownUploadByLength, scoreUnderNames, withoutCredit } = require("./local-import-core.cjs");
  const maximumResults = Math.max(1, Math.min(8, Number(options.maxResults) || 3));
  const artist = (track.artist || "").split(/\s*,\s*/)[0];
  const query = `${artist} ${withoutCredit(track.title || "")}`.trim();
  let records = null;
  for (let attempt = 0; attempt < 2 && !records; attempt++) {
    const url = new URL("https://api-v2.soundcloud.com/search/tracks");
    url.searchParams.set("q", query);
    url.searchParams.set("client_id", await soundCloudSearchClientID(signal, fetchImpl, attempt > 0));
    url.searchParams.set("limit", "20");
    let response;
    try {
      response = await fetchImpl(url, { headers: { Accept: "application/json", "User-Agent": WEB_USER_AGENT }, redirect: "error", signal });
    } catch (error) {
      if (error?.name === "AbortError") throw error;
      throw Object.assign(soundCloudError("SOUNDCLOUD_SEARCH_UNAVAILABLE", "SoundCloud search could not be reached.", { stage: "searching_candidates" }), { retryable: true });
    }
    // An expired search session: asked for a new one, once.
    if ((response.status === 401 || response.status === 403) && attempt === 0) {
      await response.body?.cancel().catch(() => undefined);
      continue;
    }
    if (response.status === 429 || response.status >= 500) {
      await response.body?.cancel().catch(() => undefined);
      throw Object.assign(soundCloudError("SOUNDCLOUD_SEARCH_BUSY", "SoundCloud is turning searches away for a moment.", { stage: "searching_candidates" }), { retryable: true });
    }
    if (!response.ok) throw providerFailure(response, "search", "searching_candidates");
    const payload = JSON.parse((await responseBytesWithLimit(response, MAX_API_BYTES, "searching_candidates")).toString("utf8"));
    records = Array.isArray(payload?.collection) ? payload.collection : [];
  }
  const tracks = (records || []).map((record) => parseSoundCloudTrack(record)).filter((value) => value?.directlyImportable);
  // Scored as YouTube uploads are; `videoID` here is only the result's place, to find it again.
  // `artist` (the credited artist) is compared as text; `channel` (who posted it) decides whether it's the artist's own.
  const scoring = tracks.map((value, at) => ({ title: value.title, artist: value.artist, channel: value.uploader || "", durationSeconds: value.durationSeconds, videoID: String(at) }));
  let scored = scoring.map((candidate) => scoreUnderNames(track, candidate)).filter(Boolean).sort((left, right) => right.score - left.score);
  if (!scored.length) {
    // Only the uploader's own account can stand in for a title that can't be compared.
    const own = ownUploadByLength(track, scoring);
    scored = own ? [own] : [];
  }
  const candidates = scored.slice(0, maximumResults).map((result) => {
    const found = tracks[Number(result.videoID)];
    return {
      ...directSoundCloudCandidate(found),
      // The account that posted it, not the artist it credits (a fan's re-upload credits the artist too).
      officialArtist: artistsOwnChannel(track.artist, found.uploader) || artistsOwnChannel(track.alternateArtist || "", found.uploader),
      score: result.score,
      confidence: "possible",
      evidenceStrength: "metadata_only",
      requiresReview: true,
      autoSelectable: false,
      actionable: false,
      match: result.match,
    };
  });
  const best = candidates[0];
  return { candidates, strong: Boolean(best && best.officialArtist && best.score >= 0.8 && !best.match?.byArtistAndLength) };
}

module.exports = {
  searchSoundCloudAudioSources,
  directSoundCloudCandidate,
  downloadResolvedSoundCloudAudio,
  downloadSoundCloudAudio,
  fetchResolvedSoundCloudRange,
  isSoundCloudURL,
  parseSoundCloudHydration,
  parseSoundCloudTrack,
  resolveSoundCloudAudio,
  resolveSoundCloudSource,
  soundCloudArtworkURL,
  soundCloudSourceURL,
};
