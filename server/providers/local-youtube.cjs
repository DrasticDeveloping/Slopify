const { readResponseBytes } = require("./response-body.cjs");
const { createHash } = require("node:crypto");
const fs = require("node:fs/promises");
const { LocalImportError, youtubeVideoID } = require("./local-import-core.cjs");

const YOUTUBE_VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;
const GOOGLEVIDEO_HOST = /(^|\.)googlevideo\.com$/i;
const YOUTUBE_PAGE_HOST = /(^|\.)(youtube\.com|youtube-nocookie\.com)$/i;
const AUDIO_CONTENT_TYPE = "audio/mp4";
const VIDEO_CONTENT_TYPE = "video/mp4";
const AUDIO_CHUNK_SIZE = 10 * 1024 * 1024;
const MAX_AUDIO_BYTES = 256 * 1024 * 1024;
const MAX_VIDEO_BYTES = 2 * 1024 * 1024 * 1024;
const MAX_VISITOR_PAGE_BYTES = 6 * 1024 * 1024;
const WEB_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) " +
  "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36";
const PLAYER_ORIGINS = ["https://www.youtube.com", "https://youtubei.googleapis.com"];
const VISIONOS_USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 15_7_3) " +
  "AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Safari/605.1.15";
const VISIONOS_CLIENT = {
  clientName: "VISIONOS",
  clientVersion: "1.02",
  deviceMake: "Apple",
  deviceModel: "RealityDevice17,1",
  userAgent: VISIONOS_USER_AGENT,
  osName: "visionOS",
  osVersion: "26.5.23O471",
  hl: "en",
  timeZone: "UTC",
  utcOffsetMinutes: 0,
};
const ANDROID_VR_USER_AGENT =
  "com.google.android.apps.youtube.vr.oculus/1.65.10 " +
  "(Linux; U; Android 12L; eureka-user Build/SQ3A.220605.009.A1) gzip";
const ANDROID_VR_CLIENT = {
  clientName: "ANDROID_VR",
  clientVersion: "1.65.10",
  deviceMake: "Oculus",
  deviceModel: "Quest 3",
  androidSdkVersion: 32,
  userAgent: ANDROID_VR_USER_AGENT,
  osName: "Android",
  osVersion: "12L",
  hl: "en",
  timeZone: "UTC",
  utcOffsetMinutes: 0,
};
const ANONYMOUS_COOKIE_NAMES = new Set([
  "GPS",
  "VISITOR_INFO1_LIVE",
  "VISITOR_PRIVACY_METADATA",
  "YSC",
  "__Secure-ROLLOUT_TOKEN",
  "__Secure-YEC",
  "__Secure-YNID",
]);

function youtubeError(code, message, options = {}) {
  return new LocalImportError(options.stage || "inspecting_source", code, message, options);
}

function cleanLabel(value, fallback) {
  if (typeof value !== "string") return fallback;
  const cleaned = value.replace(/\s+/g, " ").trim();
  return cleaned ? cleaned.slice(0, 500) : fallback;
}

function numericValue(value) {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function safeStreamingURL(value, mediaKind = "audio") {
  const media = mediaKind === "video" ? "video" : "audio";
  let url;
  try { url = new URL(value); } catch {
    throw youtubeError("YOUTUBE_INVALID_STREAM", `YouTube returned an invalid ${media} stream.`);
  }
  if (url.protocol !== "https:" || url.username || url.password || !GOOGLEVIDEO_HOST.test(url.hostname)) {
    throw youtubeError("YOUTUBE_UNSAFE_STREAM", `YouTube returned an unsafe ${media} stream.`);
  }
  return url.toString();
}

function safePageURL(value) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password && YOUTUBE_PAGE_HOST.test(url.hostname);
  } catch {
    return false;
  }
}

async function fetchWithValidatedRedirects(source, options, isAllowed, fetchImpl, unsafeMessage) {
  const { stage, ...requestOptions } = options;
  let current = new URL(source);
  if (!isAllowed(current.toString())) throw youtubeError("YOUTUBE_UNSAFE_REDIRECT", unsafeMessage, { stage });
  for (let redirects = 0; redirects <= 5; redirects += 1) {
    const response = await fetchImpl(current, { ...requestOptions, redirect: "manual" });
    if (![301, 302, 303, 307, 308].includes(response.status)) return response;
    const location = response.headers.get("location");
    await response.body?.cancel().catch(() => undefined);
    if (!location) throw youtubeError("YOUTUBE_UNSAFE_REDIRECT", unsafeMessage, { stage });
    try { current = new URL(location, current); }
    catch { throw youtubeError("YOUTUBE_UNSAFE_REDIRECT", unsafeMessage, { stage }); }
    if (!isAllowed(current.toString())) throw youtubeError("YOUTUBE_UNSAFE_REDIRECT", unsafeMessage, { stage });
  }
  throw youtubeError("YOUTUBE_TOO_MANY_REDIRECTS", "YouTube redirected the request too many times.", { stage });
}

async function responseTextWithLimit(response, limit) {
  return new TextDecoder().decode(await readResponseBytes(response, limit,
    youtubeError("YOUTUBE_RESPONSE_TOO_LARGE", "YouTube returned an oversized playback response.")));
}

async function writeAll(file, bytes) {
  let offset = 0;
  while (offset < bytes.length) {
    const { bytesWritten } = await file.write(bytes, offset, bytes.length - offset);
    if (!bytesWritten) throw youtubeError("LOCAL_WRITE_FAILED", "The temporary media file could not be written.", { stage: "downloading" });
    offset += bytesWritten;
  }
}

function playabilityReasons(value, output = []) {
  if (output.length >= 100) return output;
  if (typeof value === "string") {
    const cleaned = value.replace(/\s+/g, " ").trim();
    if (cleaned) output.push(cleaned);
    return output;
  }
  if (!value || typeof value !== "object") return output;
  for (const nested of Object.values(value)) {
    playabilityReasons(nested, output);
    if (output.length >= 100) break;
  }
  return output;
}

function youtubePlaybackFailure(reasons) {
  const message = reasons.join(" ");
  if (/rate.?limit|too many requests|\b429\b/i.test(message)) {
    return youtubeError("YOUTUBE_RATE_LIMITED", "YouTube rate-limited this request.");
  }
  if (/private/i.test(message)) return youtubeError("YOUTUBE_PRIVATE", "This YouTube video is private and cannot be imported.");
  if (/members?[- ]only|membership/i.test(message)) {
    return youtubeError("YOUTUBE_MEMBERS_ONLY", "This members-only YouTube video cannot be imported anonymously.");
  }
  if (/proof of origin|po.?token|confirm.*not a bot|automated traffic/i.test(message)) {
    return youtubeError(
      "YOUTUBE_PLAYBACK_VERIFICATION_REQUIRED",
      "YouTube requires playback verification for this video. Try another candidate.",
    );
  }
  if (/age|sign[ -]?in|login|required.*account/i.test(message)) {
    return youtubeError("YOUTUBE_SIGN_IN_REQUIRED", "YouTube requires sign-in or age verification for this video.");
  }
  if (/not available in your country|country.*unavailable|geo.?restrict/i.test(message)) {
    return youtubeError("YOUTUBE_REGION_BLOCKED", "This YouTube video is not available from this device's region.");
  }
  if (/unavailable|not available|does not exist|removed/i.test(message)) {
    return youtubeError("YOUTUBE_UNAVAILABLE", "YouTube says this video is unavailable. Check the URL or try another candidate.");
  }
  return youtubeError("YOUTUBE_RESOLVE_FAILED", "YouTube could not resolve this video.");
}

function extractYouTubeVisitorData(html) {
  const expression = /"(?:VISITOR_DATA|visitorData)"\s*:\s*"((?:\\.|[^"\\])+)"/g;
  for (const match of html.matchAll(expression)) {
    try {
      const value = JSON.parse(`"${match[1]}"`);
      if (typeof value === "string" && value.length > 0 && value.length <= 1_000) return value;
    } catch {
      // Continue to the next provider value.
    }
  }
  return null;
}

function extractYouTubeCookieHeader(headers) {
  const values = headers.getSetCookie?.() || [headers.get("set-cookie") || ""];
  const cookies = new Map();
  for (const value of values) {
    for (const match of value.matchAll(/(?:^|,\s*)([!#$%&'*+\-.^_`|~0-9A-Za-z]+)=([^;,\r\n]*)/g)) {
      const name = match[1];
      const cookieValue = match[2]?.trim() || "";
      if (ANONYMOUS_COOKIE_NAMES.has(name) && cookieValue && cookieValue.length <= 2_048) cookies.set(name, cookieValue);
    }
  }
  return [...cookies].map(([name, value]) => `${name}=${value}`).join("; ") || null;
}

function visitorPages(videoID) {
  const watch = (origin) => {
    const url = new URL("/watch", origin);
    url.searchParams.set("v", videoID);
    url.searchParams.set("bpctr", "9999999999");
    url.searchParams.set("has_verified", "1");
    return url;
  };
  return [
    watch("https://www.youtube.com"),
    watch("https://m.youtube.com"),
    watch("https://music.youtube.com"),
    new URL(`/embed/${videoID}`, "https://www.youtube.com"),
    new URL(`/embed/${videoID}`, "https://www.youtube-nocookie.com"),
  ];
}

async function fetchVisitorSession(videoID, signal, fetchImpl) {
  let reached = false;
  let rateLimited = false;
  let retryAfter = null;
  for (const pageURL of visitorPages(videoID)) {
    let response;
    try {
      response = await fetchWithValidatedRedirects(pageURL, {
        headers: {
          "User-Agent": WEB_USER_AGENT,
          Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          "Accept-Language": "en-us,en;q=0.5",
          "Sec-Fetch-Mode": "navigate",
        },
        signal,
      }, safePageURL, fetchImpl, "YouTube returned an unsafe page redirect.");
    } catch (error) {
      if (error?.name === "AbortError") throw error;
      continue;
    }
    reached = true;
    if (!safePageURL(response.url || pageURL.toString())) {
      await response.body?.cancel().catch(() => undefined);
      continue;
    }
    if (response.status === 429) {
      rateLimited = true;
      retryAfter ||= response.headers.get("retry-after");
      await response.body?.cancel().catch(() => undefined);
      continue;
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      continue;
    }
    const cookieHeader = extractYouTubeCookieHeader(response.headers);
    const visitorData = extractYouTubeVisitorData(await responseTextWithLimit(response, MAX_VISITOR_PAGE_BYTES));
    if (visitorData) return { visitorData, cookieHeader };
  }
  if (rateLimited) throw youtubeError("YOUTUBE_RATE_LIMITED", "YouTube rate-limited this request.", { retryAfter });
  throw youtubeError(
    reached ? "YOUTUBE_SESSION_FAILED" : "YOUTUBE_UNREACHABLE",
    reached ? "YouTube did not provide an anonymous playback session." : "YouTube could not be reached.",
  );
}

async function fetchDirectPlayer(videoID, client, session, signal, fetchImpl) {
  let rateLimited = false;
  let retryAfter = null;
  let lastError = null;
  for (const origin of PLAYER_ORIGINS) {
    let response;
    try {
      response = await fetchImpl(`${origin}/youtubei/v1/player?prettyPrint=false`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-YouTube-Client-Name": client.clientNumber,
          "X-YouTube-Client-Version": String(client.client.clientVersion),
          "X-Goog-Visitor-Id": session.visitorData,
          Origin: client.origin,
          "User-Agent": client.userAgent,
          ...(session.cookieHeader ? { Cookie: session.cookieHeader } : {}),
        },
        body: JSON.stringify({
          context: { client: { ...client.client, visitorData: session.visitorData } },
          videoId: videoID,
          playbackContext: { contentPlaybackContext: { html5Preference: "HTML5_PREF_WANTS" } },
          contentCheckOk: true,
          racyCheckOk: true,
        }),
        redirect: "error",
        signal,
      });
    } catch (error) {
      if (error?.name === "AbortError") throw error;
      lastError = youtubeError("YOUTUBE_RESOLVE_FAILED", "YouTube could not resolve this video.");
      continue;
    }
    if (response.status === 429) {
      rateLimited = true;
      retryAfter ||= response.headers.get("retry-after");
      await response.body?.cancel().catch(() => undefined);
      continue;
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      lastError = youtubeError("YOUTUBE_RESOLVE_FAILED", "YouTube could not resolve this video.");
      continue;
    }
    let player;
    try { player = JSON.parse(await responseTextWithLimit(response, 4 * 1024 * 1024)); }
    catch (error) {
      if (error?.name === "AbortError") throw error;
      if (error instanceof LocalImportError) throw error;
      lastError = youtubeError("YOUTUBE_INVALID_PLAYER", "YouTube returned an invalid player response.");
      continue;
    }
    const status = player?.playabilityStatus?.status;
    if (status === "OK") return player;
    lastError = youtubePlaybackFailure(playabilityReasons(player?.playabilityStatus, [typeof status === "string" ? status : ""]));
  }
  if (rateLimited) throw youtubeError("YOUTUBE_RATE_LIMITED", "YouTube rate-limited this request.", { retryAfter });
  throw lastError || youtubeError("YOUTUBE_RESOLVE_FAILED", "YouTube could not resolve this video.");
}

async function fetchYouTubePlayer(videoID, signal, fetchImpl, validatePlayer = async () => {}) {
  const session = await fetchVisitorSession(videoID, signal, fetchImpl);
  const clients = [
    { client: VISIONOS_CLIENT, clientNumber: "101", userAgent: VISIONOS_USER_AGENT, origin: "https://www.youtube.com" },
    { client: ANDROID_VR_CLIENT, clientNumber: "28", userAgent: ANDROID_VR_USER_AGENT, origin: "https://www.youtube.com" },
  ];
  let verificationError = null;
  let lastError = null;
  for (const client of clients) {
    try {
      const player = await fetchDirectPlayer(videoID, client, session, signal, fetchImpl);
      const streamingHeaders = { "User-Agent": client.userAgent, Origin: client.origin };
      await validatePlayer(player, streamingHeaders);
      return {
        player,
        streamingHeaders,
      };
    } catch (error) {
      if (!(error instanceof LocalImportError)) throw error;
      if (error.code === "YOUTUBE_PLAYBACK_VERIFICATION_REQUIRED") verificationError = error;
      else lastError = error;
    }
  }
  throw verificationError || lastError || youtubeError("YOUTUBE_RESOLVE_FAILED", "YouTube could not resolve this video.");
}

function originalAudioPreference(format) {
  const displayName = typeof format?.audioTrack?.displayName === "string" ? format.audioTrack.displayName : "";
  if (/\boriginal\b/i.test(displayName)) return 10;
  if (format?.audioTrack?.audioIsDefault === true) return 5;
  return 0;
}

function directM4A(format) {
  const contentLength = numericValue(format?.contentLength);
  return Number.isSafeInteger(numericValue(format?.itag)) && Number.isSafeInteger(contentLength) && contentLength > 0 &&
    typeof format?.url === "string" && /^audio\/mp4(?:;|$)/i.test(typeof format.mimeType === "string" ? format.mimeType : "") &&
    !format.qualityLabel && !format.drmFamilies && format.type !== "FORMAT_STREAM_TYPE_OTF";
}

function chooseM4AFormat(player) {
  const adaptive = Array.isArray(player?.streamingData?.adaptiveFormats) ? player.streamingData.adaptiveFormats : [];
  const formats = Array.isArray(player?.streamingData?.formats) ? player.streamingData.formats : [];
  return [...adaptive, ...formats].filter((value) => value && typeof value === "object").filter(directM4A).sort((left, right) => {
    const language = originalAudioPreference(right) - originalAudioPreference(left);
    return language || numericValue(right.averageBitrate || right.bitrate) - numericValue(left.averageBitrate || left.bitrate);
  })[0] || null;
}

function directMP4Video(format) {
  const contentLength = numericValue(format?.contentLength);
  const hasAudio = typeof format?.audioQuality === "string" || numericValue(format?.audioChannels) > 0;
  return Number.isSafeInteger(numericValue(format?.itag)) && Number.isSafeInteger(contentLength) && contentLength > 0 &&
    typeof format?.url === "string" && /^video\/mp4(?:;|$)/i.test(typeof format.mimeType === "string" ? format.mimeType : "") &&
    typeof format?.qualityLabel === "string" && hasAudio && !format.drmFamilies && format.type !== "FORMAT_STREAM_TYPE_OTF";
}

function chooseMP4VideoFormat(player) {
  const formats = Array.isArray(player?.streamingData?.formats) ? player.streamingData.formats : [];
  return formats.filter((value) => value && typeof value === "object").filter(directMP4Video).sort((left, right) => {
    const height = numericValue(right.height) - numericValue(left.height);
    const frameRate = numericValue(right.fps) - numericValue(left.fps);
    return height || frameRate || numericValue(right.bitrate) - numericValue(left.bitrate);
  })[0] || null;
}

function directMP4VideoOnly(format) {
  const contentLength = numericValue(format?.contentLength);
  const hasAudio = typeof format?.audioQuality === "string" || numericValue(format?.audioChannels) > 0;
  return Number.isSafeInteger(numericValue(format?.itag)) && Number.isSafeInteger(contentLength) && contentLength > 0 &&
    typeof format?.url === "string" && /^video\/mp4(?:;|$)/i.test(typeof format.mimeType === "string" ? format.mimeType : "") &&
    typeof format?.qualityLabel === "string" && !hasAudio && !format.drmFamilies && format.type !== "FORMAT_STREAM_TYPE_OTF";
}

function chooseMP4VideoOnlyFormat(player) {
  const adaptive = Array.isArray(player?.streamingData?.adaptiveFormats) ? player.streamingData.adaptiveFormats : [];
  return adaptive.filter((value) => value && typeof value === "object").filter(directMP4VideoOnly).sort((left, right) => {
    const height = numericValue(right.height) - numericValue(left.height);
    const frameRate = numericValue(right.fps) - numericValue(left.fps);
    return height || frameRate || numericValue(right.bitrate) - numericValue(left.bitrate);
  })[0] || null;
}

function chooseMP4VideoStreams(player) {
  const combinedFormat = chooseMP4VideoFormat(player);
  const adaptiveFormat = chooseMP4VideoOnlyFormat(player);
  const useAdaptive = Boolean(adaptiveFormat
    && (!combinedFormat || numericValue(adaptiveFormat.height) > numericValue(combinedFormat.height)));
  return {
    format: useAdaptive ? adaptiveFormat : combinedFormat,
    audioFormat: useAdaptive ? chooseM4AFormat(player) : null,
    useAdaptive,
  };
}

async function probeResolvedStream(stream, signal, fetchImpl, mediaKind = "audio") {
  const media = mediaKind === "video" ? "video" : "audio";
  let response;
  try {
    response = await fetchWithValidatedRedirects(safeStreamingURL(stream.streamingURL, media), {
      headers: { ...stream.streamingHeaders, "Accept-Encoding": "identity", Range: "bytes=0-0" },
      signal,
      stage: "inspecting_source",
    }, (value) => {
      try { safeStreamingURL(value, media); return true; } catch { return false; }
    }, fetchImpl, `YouTube returned an unsafe ${media} redirect.`);
  } catch (error) {
    if (error?.name === "AbortError" || error instanceof LocalImportError) throw error;
    throw youtubeError("YOUTUBE_STREAM_UNAVAILABLE", `The YouTube ${media} stream could not be verified.`);
  }
  if (response.status === 403) {
    await response.body?.cancel().catch(() => undefined);
    throw youtubeError(
      "YOUTUBE_PLAYBACK_VERIFICATION_REQUIRED",
      "YouTube requires playback verification for this stream. Trying another playback client.",
    );
  }
  if (response.status === 429) {
    await response.body?.cancel().catch(() => undefined);
    throw youtubeError("YOUTUBE_RATE_LIMITED", `YouTube rate-limited the ${media} stream probe.`, {
      retryAfter: response.headers.get("retry-after"),
    });
  }
  if (response.status !== 206
      || verifiedContentRangeForKind(response.headers.get("content-range"), 0, 0, stream.contentLength, media) !== 1
      || Number(response.headers.get("content-length")) !== 1
      || String(response.headers.get("content-type") || "").split(";", 1)[0].trim().toLowerCase()
        !== stream.contentType.toLowerCase()) {
    await response.body?.cancel().catch(() => undefined);
    throw youtubeError("YOUTUBE_STREAM_UNAVAILABLE", `YouTube returned an unverifiable ${media} stream.`);
  }
  const reader = response.body?.getReader();
  if (!reader) throw youtubeError("YOUTUBE_STREAM_UNAVAILABLE", `YouTube returned no ${media} stream data.`);
  const first = await reader.read();
  const second = await reader.read();
  if (first.done || first.value?.byteLength !== 1 || !second.done) {
    await reader.cancel().catch(() => undefined);
    throw youtubeError("YOUTUBE_STREAM_UNAVAILABLE", `YouTube returned an unverifiable ${media} stream body.`);
  }
}

function safeThumbnailURL(value) {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    if (url.protocol === "https:" &&
      (url.hostname === "i.ytimg.com" || url.hostname.endsWith(".ytimg.com") || url.hostname.endsWith(".ggpht.com"))) return url.toString();
  } catch {
    // Ignore unsafe or malformed artwork.
  }
  return null;
}

function highestQualityThumbnailURL(values) {
  if (!Array.isArray(values)) return null;
  return values.map((thumbnail, index) => ({ thumbnail, index }))
    .sort((left, right) => {
      const leftWidth = Math.min(numericValue(left.thumbnail?.width), 1_000_000);
      const leftHeight = Math.min(numericValue(left.thumbnail?.height), 1_000_000);
      const rightWidth = Math.min(numericValue(right.thumbnail?.width), 1_000_000);
      const rightHeight = Math.min(numericValue(right.thumbnail?.height), 1_000_000);
      const areaDifference = (rightWidth * rightHeight) - (leftWidth * leftHeight);
      if (areaDifference) return areaDifference;
      const edgeDifference = Math.max(rightWidth, rightHeight) - Math.max(leftWidth, leftHeight);
      return edgeDifference || right.index - left.index;
    })
    .map(({ thumbnail }) => safeThumbnailURL(thumbnail?.url))
    .find(Boolean) || null;
}

function preferredYouTubeArtworkURL(metadataURL, resolvedURL) {
  if (safeThumbnailURL(metadataURL)) return safeThumbnailURL(resolvedURL) || metadataURL;
  return metadataURL || safeThumbnailURL(resolvedURL);
}

async function resolveYouTubeMetadata(source, signal, fetchImpl = fetch) {
  const videoID = YOUTUBE_VIDEO_ID.test(source) ? source : youtubeVideoID(source);
  if (!videoID) throw youtubeError("INVALID_YOUTUBE_VIDEO", "Enter a supported YouTube video URL.", { stage: "resolving_metadata" });
  const oEmbedURL = new URL("/oembed", "https://www.youtube.com");
  oEmbedURL.searchParams.set("url", `https://www.youtube.com/watch?v=${videoID}`);
  oEmbedURL.searchParams.set("format", "json");
  let response;
  try {
    response = await fetchImpl(oEmbedURL, {
      headers: { Accept: "application/json", "User-Agent": WEB_USER_AGENT },
      redirect: "error",
      signal,
    });
  } catch (error) {
    if (error?.name === "AbortError") throw error;
    throw youtubeError("YOUTUBE_UNREACHABLE", "YouTube metadata could not be reached.", { stage: "resolving_metadata" });
  }
  if (response.status === 404) {
    throw youtubeError("YOUTUBE_UNAVAILABLE", "YouTube could not find that video.", { stage: "resolving_metadata" });
  }
  if (response.status === 429) {
    throw youtubeError("YOUTUBE_RATE_LIMITED", "YouTube rate-limited this metadata request.", {
      stage: "resolving_metadata",
      retryAfter: response.headers.get("retry-after"),
    });
  }
  let responseURL;
  try { responseURL = new URL(response.url || oEmbedURL); }
  catch { responseURL = null; }
  if (!response.ok || responseURL?.protocol !== "https:"
      || responseURL.hostname !== "www.youtube.com" || responseURL.pathname !== "/oembed") {
    throw youtubeError("YOUTUBE_METADATA_FAILED", "YouTube could not load that video's metadata.", { stage: "resolving_metadata" });
  }
  let payload;
  try {
    payload = JSON.parse(await responseTextWithLimit(response, 256 * 1024));
  } catch (error) {
    if (error?.name === "AbortError") throw error;
    throw youtubeError("YOUTUBE_INVALID_METADATA", "YouTube returned invalid video metadata.", { stage: "resolving_metadata" });
  }
  const title = cleanLabel(payload?.title, "");
  const artist = cleanLabel(payload?.author_name, "");
  if (payload?.type !== "video" || payload?.provider_name !== "YouTube" || !title || !artist) {
    throw youtubeError("YOUTUBE_INVALID_METADATA", "YouTube returned invalid video metadata.", { stage: "resolving_metadata" });
  }
  return {
    provider: "youtube",
    type: "track",
    trackID: videoID,
    title,
    artist,
    album: null,
    trackNumber: null,
    durationSeconds: null,
    artworkURL: safeThumbnailURL(payload.thumbnail_url),
    embedURL: null,
    sourceURL: `https://www.youtube.com/watch?v=${videoID}`,
  };
}

async function resolveYouTubeAudio(source, signal, fetchImpl = fetch) {
  const videoID = YOUTUBE_VIDEO_ID.test(source) ? source : youtubeVideoID(source);
  if (!videoID) throw youtubeError("INVALID_YOUTUBE_VIDEO", "Enter a supported YouTube video URL.");
  let format = null;
  const { player, streamingHeaders } = await fetchYouTubePlayer(videoID, signal, fetchImpl, async (candidatePlayer, headers) => {
    format = chooseM4AFormat(candidatePlayer);
    if (!format) {
      throw youtubeError("YOUTUBE_NO_VERIFIED_M4A", "YouTube did not provide a direct, verifiable M4A audio stream for this video.");
    }
    await probeResolvedStream({
      streamingURL: safeStreamingURL(format.url),
      streamingHeaders: headers,
      contentLength: numericValue(format.contentLength),
      contentType: AUDIO_CONTENT_TYPE,
    }, signal, fetchImpl);
  });
  const details = player.videoDetails;
  if (details?.videoId && details.videoId !== videoID) throw youtubeError("YOUTUBE_MISMATCH", "YouTube returned the wrong video.");
  if (details?.isLive || details?.isLiveContent || details?.isUpcoming) {
    throw youtubeError("YOUTUBE_LIVE_UNSUPPORTED", "Live and upcoming YouTube videos are not supported.");
  }
  if (!format) {
    throw youtubeError("YOUTUBE_NO_VERIFIED_M4A", "YouTube did not provide a direct, verifiable M4A audio stream for this video.");
  }
  const contentLength = numericValue(format.contentLength);
  if (!Number.isSafeInteger(contentLength) || contentLength <= 0 || contentLength > MAX_AUDIO_BYTES) {
    throw youtubeError("YOUTUBE_AUDIO_TOO_LARGE", "The selected audio is too large to import on this device.");
  }
  const duration = numericValue(details?.lengthSeconds);
  if (duration > 24 * 60 * 60) throw youtubeError("YOUTUBE_DURATION_TOO_LONG", "The selected audio is too long to import.");
  const thumbnails = Array.isArray(details?.thumbnail?.thumbnails) ? details.thumbnail.thumbnails : [];
  const thumbnailURL = highestQualityThumbnailURL(thumbnails);
  return {
    videoID,
    title: cleanLabel(details?.title, videoID),
    author: details?.author ? cleanLabel(details.author, "Unknown uploader") : null,
    durationSeconds: duration > 0 ? duration : null,
    thumbnailURL,
    itag: numericValue(format.itag),
    contentLength,
    contentType: AUDIO_CONTENT_TYPE,
    streamingURL: safeStreamingURL(format.url),
    streamingHeaders,
    sourceURL: `https://www.youtube.com/watch?v=${videoID}`,
  };
}

async function resolveYouTubeVideo(source, signal, fetchImpl = fetch) {
  const videoID = YOUTUBE_VIDEO_ID.test(source) ? source : youtubeVideoID(source);
  if (!videoID) throw youtubeError("INVALID_YOUTUBE_VIDEO", "Enter a supported YouTube video URL.");
  let selected = null;
  const { player, streamingHeaders } = await fetchYouTubePlayer(videoID, signal, fetchImpl, async (candidatePlayer, headers) => {
    selected = chooseMP4VideoStreams(candidatePlayer);
    if (!selected.format || (selected.useAdaptive && !selected.audioFormat)) {
      throw youtubeError("YOUTUBE_NO_VERIFIED_MP4", "YouTube did not provide verifiable MP4 video and M4A audio streams for this video.");
    }
    await probeResolvedStream({
      streamingURL: safeStreamingURL(selected.format.url, "video"),
      streamingHeaders: headers,
      contentLength: numericValue(selected.format.contentLength),
      contentType: VIDEO_CONTENT_TYPE,
    }, signal, fetchImpl, "video");
    if (selected.audioFormat) {
      await probeResolvedStream({
        streamingURL: safeStreamingURL(selected.audioFormat.url),
        streamingHeaders: headers,
        contentLength: numericValue(selected.audioFormat.contentLength),
        contentType: AUDIO_CONTENT_TYPE,
      }, signal, fetchImpl);
    }
  });
  const details = player.videoDetails;
  if (details?.videoId && details.videoId !== videoID) throw youtubeError("YOUTUBE_MISMATCH", "YouTube returned the wrong video.");
  if (details?.isLive || details?.isLiveContent || details?.isUpcoming) {
    throw youtubeError("YOUTUBE_LIVE_UNSUPPORTED", "Live and upcoming YouTube videos are not supported.");
  }
  const { format, audioFormat, useAdaptive } = selected || {};
  if (!format || (useAdaptive && !audioFormat)) {
    throw youtubeError("YOUTUBE_NO_VERIFIED_MP4", "YouTube did not provide verifiable MP4 video and M4A audio streams for this video.");
  }
  const videoContentLength = numericValue(format.contentLength);
  const audioContentLength = audioFormat ? numericValue(audioFormat.contentLength) : 0;
  const contentLength = videoContentLength + audioContentLength;
  if (!Number.isSafeInteger(contentLength) || contentLength <= 0 || contentLength > MAX_VIDEO_BYTES) {
    throw youtubeError("YOUTUBE_VIDEO_TOO_LARGE", "The selected video is too large to import on this device.");
  }
  const duration = numericValue(details?.lengthSeconds);
  if (duration > 24 * 60 * 60) throw youtubeError("YOUTUBE_DURATION_TOO_LONG", "The selected video is too long to import.");
  const thumbnails = Array.isArray(details?.thumbnail?.thumbnails) ? details.thumbnail.thumbnails : [];
  const thumbnailURL = highestQualityThumbnailURL(thumbnails);
  return {
    videoID,
    title: cleanLabel(details?.title, videoID),
    author: details?.author ? cleanLabel(details.author, "Unknown uploader") : null,
    durationSeconds: duration > 0 ? duration : null,
    thumbnailURL,
    itag: numericValue(format.itag),
    contentLength,
    contentType: VIDEO_CONTENT_TYPE,
    qualityLabel: cleanLabel(format.qualityLabel, "MP4"),
    width: numericValue(format.width) || null,
    height: numericValue(format.height) || null,
    fps: numericValue(format.fps) || null,
    ...(useAdaptive ? {
      separateStreams: true,
      videoStream: {
        contentLength: videoContentLength,
        streamingURL: safeStreamingURL(format.url, "video"),
        streamingHeaders,
      },
      audioStream: {
        contentLength: audioContentLength,
        streamingURL: safeStreamingURL(audioFormat.url, "audio"),
        streamingHeaders,
      },
    } : {
      separateStreams: false,
      streamingURL: safeStreamingURL(format.url, "video"),
      streamingHeaders,
    }),
    sourceURL: `https://www.youtube.com/watch?v=${videoID}`,
  };
}

function verifiedContentRangeForKind(value, expectedStart, expectedEnd, expectedTotal, mediaKind) {
  const media = mediaKind === "video" ? "video" : "audio";
  const match = /^bytes\s+(\d+)-(\d+)\/(\d+)$/i.exec(value || "");
  if (!match || Number(match[1]) !== expectedStart || Number(match[2]) !== expectedEnd || Number(match[3]) !== expectedTotal) {
    throw youtubeError("YOUTUBE_RANGE_MISMATCH", `YouTube returned an unverifiable ${media} range.`, { stage: "downloading" });
  }
  return expectedEnd - expectedStart + 1;
}

async function downloadResolvedMedia(resolved, destination, signal, onProgress = () => {}, fetchImpl = fetch, mediaKind = "audio") {
  const media = mediaKind === "video" ? "video" : "audio";
  const file = await fs.open(destination, "wx");
  const hash = createHash("sha256");
  let completed = 0;
  try {
    for (let start = 0; start < resolved.contentLength; start += AUDIO_CHUNK_SIZE) {
      if (signal?.aborted) throw signal.reason || new DOMException("Cancelled", "AbortError");
      const end = Math.min(resolved.contentLength - 1, start + AUDIO_CHUNK_SIZE - 1);
      let response;
      try {
        response = await fetchWithValidatedRedirects(safeStreamingURL(resolved.streamingURL, media), {
          headers: { ...resolved.streamingHeaders, "Accept-Encoding": "identity", Range: `bytes=${start}-${end}` },
          signal,
          stage: "downloading",
        }, (value) => {
          try { safeStreamingURL(value, media); return true; } catch { return false; }
        }, fetchImpl, `YouTube returned an unsafe ${media} redirect.`);
      } catch (error) {
        if (error?.name === "AbortError") throw error;
        if (error instanceof LocalImportError) throw error;
        throw youtubeError("YOUTUBE_DOWNLOAD_UNREACHABLE", `The YouTube ${media} stream could not be reached.`, { stage: "downloading" });
      }
      try { safeStreamingURL(response.url || resolved.streamingURL, media); }
      catch (error) { await response.body?.cancel().catch(() => undefined); throw error; }
      if (response.status === 429) {
        await response.body?.cancel().catch(() => undefined);
        throw youtubeError("YOUTUBE_RATE_LIMITED", `YouTube rate-limited the ${media} import.`, {
          stage: "downloading",
          retryAfter: response.headers.get("retry-after"),
        });
      }
      const expectedLength = response.status === 206
        ? verifiedContentRangeForKind(response.headers.get("content-range"), start, end, resolved.contentLength, media)
        : response.status === 200 && start === 0 && end === resolved.contentLength - 1
          ? resolved.contentLength
          : 0;
      if (!expectedLength || !response.body) {
        await response.body?.cancel().catch(() => undefined);
        throw youtubeError("YOUTUBE_DOWNLOAD_FAILED", `The YouTube ${media} stream could not be read.`, { stage: "downloading" });
      }
      const declared = Number(response.headers.get("content-length") || expectedLength);
      if (declared !== expectedLength) {
        await response.body.cancel().catch(() => undefined);
        throw youtubeError("YOUTUBE_SIZE_MISMATCH", `YouTube returned an unverifiable ${media} size.`, { stage: "downloading" });
      }
      const reader = response.body.getReader();
      let remaining = expectedLength;
      while (remaining > 0) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!value?.byteLength) continue;
        if (value.byteLength > remaining) {
          await reader.cancel().catch(() => undefined);
          throw youtubeError("YOUTUBE_RANGE_OVERFLOW", `YouTube returned more ${media} data than requested.`, { stage: "downloading" });
        }
        const bytes = Buffer.from(value);
        await writeAll(file, bytes);
        hash.update(bytes);
        completed += bytes.length;
        remaining -= bytes.length;
        onProgress(completed, resolved.contentLength);
      }
      if (remaining !== 0) {
        throw youtubeError("YOUTUBE_RANGE_TRUNCATED", `YouTube ended a ${media} range before it was complete.`, { stage: "downloading" });
      }
    }
    if (completed !== resolved.contentLength) {
      throw youtubeError("YOUTUBE_SIZE_MISMATCH", `The downloaded ${media} size could not be verified.`, { stage: "downloading" });
    }
    await file.sync();
    return { path: destination, sha256: hash.digest("hex"), size: completed };
  } catch (error) {
    await file.close().catch(() => undefined);
    await fs.rm(destination, { force: true }).catch(() => undefined);
    throw error;
  } finally {
    await file.close().catch(() => undefined);
  }
}

async function downloadResolvedAudio(resolved, destination, signal, onProgress = () => {}, fetchImpl = fetch) {
  return downloadResolvedMedia(resolved, destination, signal, onProgress, fetchImpl, "audio");
}

async function downloadResolvedVideo(resolved, destination, signal, onProgress = () => {}, fetchImpl = fetch) {
  return downloadResolvedMedia(resolved, destination, signal, onProgress, fetchImpl, "video");
}

async function inspectYouTubeAudio(source, signal, fetchImpl = fetch) {
  const resolved = await resolveYouTubeAudio(source, signal, fetchImpl);
  const { streamingURL, streamingHeaders, ...preview } = resolved;
  return preview;
}

async function downloadYouTubeAudio(source, destination, signal, onProgress, fetchImpl = fetch) {
  const resolved = await resolveYouTubeAudio(source, signal, fetchImpl);
  return {
    preview: (({ streamingURL, streamingHeaders, ...preview }) => preview)(resolved),
    mediaSourceURL: resolved.streamingURL,
    download: await downloadResolvedAudio(resolved, destination, signal, onProgress, fetchImpl),
  };
}

async function inspectYouTubeVideo(source, signal, fetchImpl = fetch) {
  const resolved = await resolveYouTubeVideo(source, signal, fetchImpl);
  const { streamingURL, streamingHeaders, videoStream, audioStream, ...preview } = resolved;
  return preview;
}

async function downloadYouTubeVideo(source, destination, signal, onProgress, fetchImpl = fetch) {
  const resolved = await resolveYouTubeVideo(source, signal, fetchImpl);
  const preview = (({ streamingURL, streamingHeaders, videoStream, audioStream, ...value }) => value)(resolved);
  if (resolved.separateStreams) {
    const videoDestination = `${destination}.video.mp4`;
    const audioDestination = `${destination}.audio.m4a`;
    const videoDownload = await downloadResolvedVideo(
      resolved.videoStream,
      videoDestination,
      signal,
      (completed) => onProgress?.(completed, resolved.contentLength),
      fetchImpl,
    );
    const audioDownload = await downloadResolvedAudio(
      resolved.audioStream,
      audioDestination,
      signal,
      (completed) => onProgress?.(resolved.videoStream.contentLength + completed, resolved.contentLength),
      fetchImpl,
    );
    return {
      preview,
      mediaSourceURL: null,
      separateStreams: { video: videoDownload, audio: audioDownload },
    };
  }
  return {
    preview,
    mediaSourceURL: resolved.streamingURL,
    download: await downloadResolvedVideo(resolved, destination, signal, onProgress, fetchImpl),
  };
}

module.exports = {
  chooseMP4VideoFormat,
  chooseMP4VideoOnlyFormat,
  downloadResolvedAudio,
  downloadResolvedVideo,
  downloadYouTubeAudio,
  downloadYouTubeVideo,
  extractYouTubeCookieHeader,
  extractYouTubeVisitorData,
  inspectYouTubeAudio,
  inspectYouTubeVideo,
  highestQualityThumbnailURL,
  preferredYouTubeArtworkURL,
  resolveYouTubeMetadata,
  resolveYouTubeAudio,
  resolveYouTubeVideo,
  safeStreamingURL,
  writeAll,
  youtubePlaybackFailure,
};
