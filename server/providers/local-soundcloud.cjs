const { readResponseBytes } = require("./response-body.cjs");
const { createHash } = require("node:crypto");
const fs = require("node:fs/promises");
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
    Boolean(cleanText(record.track_authorization, 2_048)) && Boolean(progressiveTranscoding(record));
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
    embedURL: "",
    sourceURL,
    directlyImportable,
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
    contentType: "audio/mpeg",
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

async function downloadResolvedSoundCloudAudio(resolved, destination, signal, onProgress = () => {}, fetchImpl = fetch) {
  const response = await fetchWithValidatedRedirects(resolved.streamingURL, {
    headers: STREAM_HEADERS,
    signal,
  }, safeMediaURL, fetchImpl, "downloading");
  if (!response.ok || !safeMediaURL(response.url || resolved.streamingURL) || !response.body) {
    throw providerFailure(response, "audio stream", "downloading");
  }
  const declared = Number(response.headers.get("content-length") || 0);
  if (declared !== resolved.contentLength) {
    await response.body.cancel().catch(() => undefined);
    throw soundCloudError("SOUNDCLOUD_SIZE_MISMATCH", "SoundCloud returned an unverifiable audio size.", { stage: "downloading" });
  }
  const file = await fs.open(destination, "wx");
  const hash = createHash("sha256");
  let completed = 0;
  try {
    const reader = response.body.getReader();
    while (true) {
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
    return { sha256: hash.digest("hex"), bytesWritten: completed };
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

module.exports = {
  directSoundCloudCandidate,
  downloadResolvedSoundCloudAudio,
  downloadSoundCloudAudio,
  isSoundCloudURL,
  parseSoundCloudHydration,
  parseSoundCloudTrack,
  resolveSoundCloudAudio,
  resolveSoundCloudSource,
  soundCloudArtworkURL,
  soundCloudSourceURL,
};
