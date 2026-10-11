const { readResponseBytes } = require("./response-body.cjs");
const SPOTIFY_ID = /^[A-Za-z0-9]{22}$/;
const SPOTIFY_HOSTS = new Set([
  "open.spotify.com",
  "www.open.spotify.com",
  "spotify.link",
  "www.spotify.link",
]);
const SPOTIFY_ARTWORK_HOST = /(^|\.)((spotifycdn\.com)|(scdn\.co))$/i;
const YOUTUBE_VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;
const YOUTUBE_PLAYLIST_ID = /^[A-Za-z0-9_-]{10,150}$/;
const YOUTUBE_HOSTS = new Set([
  "youtube.com",
  "www.youtube.com",
  "m.youtube.com",
  "music.youtube.com",
]);
const YOUTUBE_EMBED_HOSTS = new Set([
  "youtube-nocookie.com",
  "www.youtube-nocookie.com",
]);
const MAX_SOURCE_LENGTH = 8_192;
const MAX_SPOTIFY_RESPONSE_BYTES = 6 * 1024 * 1024;
const MAX_SEARCH_DOCUMENT_BYTES = 6 * 1024 * 1024;
const MAX_RESULTS = 8;
const MAX_PLAYLIST_ITEMS = 500;
const MAX_PLAYLIST_CONTINUATIONS = 10;
const MAX_PLAYLIST_POSITION = 10_000;
const SEARCH_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) " +
  "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36";
const VERSION_WORDS =
  /\b(cover|instrumental|karaoke|live|nightcore|remaster(?:ed)?|remix|reverb|slowed|sped up|tribute)\b/i;

class LocalImportError extends Error {
  constructor(stage, code, message, options = {}) {
    super(message);
    this.name = "LocalImportError";
    this.stage = stage;
    this.code = code;
    this.retryAfter = options.retryAfter || null;
  }
}

function importError(stage, code, message, options) {
  return new LocalImportError(stage, code, message, options);
}

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function cleanText(value, maxLength = 500) {
  if (typeof value !== "string") return null;
  const cleaned = value.replace(/\s+/g, " ").trim();
  return cleaned ? cleaned.slice(0, maxLength) : null;
}

function safeNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function spotifyArtworkURL(value) {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    if (url.protocol === "https:" && SPOTIFY_ARTWORK_HOST.test(url.hostname)) return url.toString();
  } catch {
    // Invalid provider artwork is ignored without discarding usable audio metadata.
  }
  return null;
}

function parseURL(value, stage, message) {
  if (typeof value !== "string" || !value.trim() || value.length > MAX_SOURCE_LENGTH) {
    throw importError(stage, "INVALID_SOURCE", message);
  }
  try {
    return new URL(value.trim());
  } catch {
    throw importError(stage, "INVALID_SOURCE", message);
  }
}

function spotifySourceURL(value) {
  const url = parseURL(value, "resolving_metadata", "Enter a Spotify track or YouTube video URL.");
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    !SPOTIFY_HOSTS.has(url.hostname.toLowerCase())
  ) {
    throw importError("resolving_metadata", "INVALID_SPOTIFY_URL", "Source must be a Spotify track URL.");
  }
  return url;
}

function spotifyTrackURL(value) {
  const url = spotifySourceURL(value);
  if (!["open.spotify.com", "www.open.spotify.com"].includes(url.hostname.toLowerCase())) return null;
  const segments = url.pathname.split("/").filter(Boolean);
  if (segments[0]?.startsWith("intl-")) segments.shift();
  if (segments[0] === "playlist") return null;
  if (segments[0] !== "track" || !segments[1] || !SPOTIFY_ID.test(segments[1])) {
    throw importError(
      "resolving_metadata",
      "UNSUPPORTED_SPOTIFY_RESOURCE",
      "Only Spotify track and playlist links are supported.",
    );
  }
  url.protocol = "https:";
  url.hostname = "open.spotify.com";
  url.pathname = `/track/${segments[1]}`;
  url.search = "";
  url.hash = "";
  return { url, trackID: segments[1] };
}

function spotifyPlaylistURL(value) {
  const url = spotifySourceURL(value);
  if (!["open.spotify.com", "www.open.spotify.com"].includes(url.hostname.toLowerCase())) return null;
  const segments = url.pathname.split("/").filter(Boolean);
  if (segments[0]?.startsWith("intl-")) segments.shift();
  if (segments[0] === "track") return null;
  if (segments[0] !== "playlist" || !segments[1] || !SPOTIFY_ID.test(segments[1])) {
    throw importError(
      "resolving_metadata",
      "UNSUPPORTED_SPOTIFY_RESOURCE",
      "Only Spotify track and playlist links are supported.",
    );
  }
  url.protocol = "https:";
  url.hostname = "open.spotify.com";
  url.pathname = `/playlist/${segments[1]}`;
  url.search = "";
  url.hash = "";
  return { url, playlistID: segments[1] };
}

function isSpotifyURL(value) {
  try {
    return SPOTIFY_HOSTS.has(new URL(value).hostname.toLowerCase());
  } catch {
    return false;
  }
}

function youtubePlaylistID(source) {
  const url = parseURL(source, "resolving_metadata", "Enter a Spotify track or YouTube URL.");
  if (url.protocol !== "https:") return null;
  if (url.username || url.password) {
    throw importError("resolving_metadata", "SOURCE_HAS_CREDENTIALS", "Source URLs cannot contain credentials.");
  }
  const hostname = url.hostname.toLowerCase();
  if (![...YOUTUBE_HOSTS, "youtu.be", "www.youtu.be"].includes(hostname)) return null;
  const playlistID = url.searchParams.get("list");
  if (!playlistID) return null;
  if (!YOUTUBE_PLAYLIST_ID.test(playlistID)) {
    throw importError("resolving_metadata", "INVALID_YOUTUBE_PLAYLIST", "The YouTube playlist URL is invalid.");
  }
  return playlistID;
}

function youtubeVideoID(source) {
  const url = parseURL(source, "inspecting_source", "Enter a Spotify track or YouTube URL.");
  if (url.protocol !== "https:") return null;
  if (url.username || url.password) {
    throw importError("inspecting_source", "SOURCE_HAS_CREDENTIALS", "Source URLs cannot contain credentials.");
  }
  const hostname = url.hostname.toLowerCase();
  let candidate = null;
  if (hostname === "youtu.be" || hostname === "www.youtu.be") {
    candidate = url.pathname.split("/").filter(Boolean)[0] || null;
  } else if (YOUTUBE_HOSTS.has(hostname)) {
    if (url.pathname === "/watch") candidate = url.searchParams.get("v");
    else {
      const segments = url.pathname.split("/").filter(Boolean);
      if (["embed", "live", "shorts"].includes(segments[0] || "")) candidate = segments[1] || null;
    }
  } else if (YOUTUBE_EMBED_HOSTS.has(hostname)) {
    const segments = url.pathname.split("/").filter(Boolean);
    if (segments[0] === "embed") candidate = segments[1] || null;
  } else {
    return null;
  }
  if (!candidate || !YOUTUBE_VIDEO_ID.test(candidate)) {
    throw importError(
      "inspecting_source",
      "INVALID_YOUTUBE_VIDEO",
      "Source must identify one YouTube video; playlists and channel URLs are not supported.",
    );
  }
  return candidate;
}

function spotifyEmbedURL(html, expectedTrackID) {
  if (typeof html !== "string" || html.length > 8_192) {
    throw importError("resolving_metadata", "SPOTIFY_INVALID_PREVIEW", "Spotify did not return a track preview.");
  }
  const match = /\bsrc="([^"]+)"/i.exec(html);
  if (!match?.[1]) {
    throw importError("resolving_metadata", "SPOTIFY_INVALID_PREVIEW", "Spotify did not return a track preview.");
  }
  let url;
  try {
    url = new URL(match[1].replaceAll("&amp;", "&"));
  } catch {
    throw importError("resolving_metadata", "SPOTIFY_INVALID_PREVIEW", "Spotify returned an invalid track preview.");
  }
  const segments = url.pathname.split("/").filter(Boolean);
  const embedIndex = segments.indexOf("embed");
  if (
    url.protocol !== "https:" ||
    url.hostname !== "open.spotify.com" ||
    segments[embedIndex + 1] !== "track" ||
    segments[embedIndex + 2] !== expectedTrackID
  ) {
    throw importError("resolving_metadata", "SPOTIFY_MISMATCH", "Spotify returned a mismatched track preview.");
  }
  url.search = "";
  url.hash = "";
  return url.toString();
}

function parseSpotifyOEmbed(value, expectedTrackID) {
  if (!isRecord(value) || value.provider_name !== "Spotify" || value.type !== "rich") {
    throw importError("resolving_metadata", "SPOTIFY_INVALID_PREVIEW", "Spotify returned an invalid track preview.");
  }
  const title = cleanText(value.title);
  if (!title) {
    throw importError("resolving_metadata", "SPOTIFY_INCOMPLETE_METADATA", "Spotify returned incomplete track metadata.");
  }
  return {
    title,
    artworkURL: spotifyArtworkURL(value.thumbnail_url),
    embedURL: spotifyEmbedURL(value.html, expectedTrackID),
  };
}

function parseSpotifyPlaylistOEmbed(value, expectedPlaylistID) {
  if (!isRecord(value) || value.provider_name !== "Spotify" || value.type !== "rich") {
    throw importError("resolving_metadata", "SPOTIFY_INVALID_PREVIEW", "Spotify returned an invalid playlist preview.");
  }
  const title = cleanText(value.title);
  const html = typeof value.html === "string" ? value.html : "";
  const match = /\bsrc="([^"]+)"/i.exec(html);
  let embedURL;
  try { embedURL = new URL(match?.[1]?.replaceAll("&amp;", "&") || ""); }
  catch {
    throw importError("resolving_metadata", "SPOTIFY_INVALID_PREVIEW", "Spotify returned an invalid playlist preview.");
  }
  const segments = embedURL.pathname.split("/").filter(Boolean);
  const embedIndex = segments.indexOf("embed");
  if (
    !title || embedURL.protocol !== "https:" || embedURL.hostname !== "open.spotify.com"
    || segments[embedIndex + 1] !== "playlist" || segments[embedIndex + 2] !== expectedPlaylistID
  ) {
    throw importError("resolving_metadata", "SPOTIFY_MISMATCH", "Spotify returned a mismatched playlist preview.");
  }
  embedURL.search = "";
  embedURL.hash = "";
  return {
    title,
    artworkURL: spotifyArtworkURL(value.thumbnail_url),
    embedURL: embedURL.toString(),
  };
}

function balancedJSONObject(source, start) {
  let depth = 0;
  let quoted = false;
  let escaped = false;
  for (let index = start; index < source.length; index += 1) {
    const character = source[index];
    if (quoted) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') quoted = false;
      continue;
    }
    if (character === '"') quoted = true;
    else if (character === "{") depth += 1;
    else if (character === "}" && --depth === 0) return source.slice(start, index + 1);
  }
  return null;
}

function nextData(html) {
  const match = /<script[^>]+id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/i.exec(html);
  if (!match?.[1]) {
    throw importError("resolving_metadata", "SPOTIFY_INCOMPLETE_METADATA", "Spotify returned incomplete track metadata.");
  }
  try {
    return JSON.parse(match[1]);
  } catch {
    throw importError("resolving_metadata", "SPOTIFY_INVALID_METADATA", "Spotify returned invalid track metadata.");
  }
}

function nestedValue(value, keys) {
  let current = value;
  for (const key of keys) {
    if (!isRecord(current)) return undefined;
    current = current[key];
  }
  return current;
}

function parseSpotifyEmbedEntity(html, expectedTrackID) {
  const entity = nestedValue(nextData(html), ["props", "pageProps", "state", "data", "entity"]);
  if (!isRecord(entity)) {
    throw importError("resolving_metadata", "SPOTIFY_INCOMPLETE_METADATA", "Spotify returned incomplete track metadata.");
  }
  if (entity.type !== "track" || entity.id !== expectedTrackID || !SPOTIFY_ID.test(expectedTrackID)) {
    throw importError("resolving_metadata", "SPOTIFY_MISMATCH", "Spotify returned mismatched track metadata.");
  }
  const title = cleanText(entity.title);
  const artists = Array.isArray(entity.artists)
    ? entity.artists.map((artist) => isRecord(artist) ? cleanText(artist.name) : null).filter(Boolean)
    : [];
  if (!title || !artists.length) {
    throw importError("resolving_metadata", "SPOTIFY_INCOMPLETE_METADATA", "Spotify returned incomplete track metadata.");
  }
  const images = nestedValue(entity.visualIdentity, ["image"]);
  const artworkURL = Array.isArray(images)
    ? images.slice().sort((left, right) =>
      (isRecord(right) ? safeNumber(right.maxWidth) || 0 : 0) -
      (isRecord(left) ? safeNumber(left.maxWidth) || 0 : 0))
      .map((image) => isRecord(image) ? spotifyArtworkURL(image.url) : null)
      .find(Boolean) || null
    : null;
  const durationMilliseconds = safeNumber(entity.duration);
  return {
    title,
    artist: artists.join(", "),
    durationSeconds: durationMilliseconds === null ? null : Math.round(durationMilliseconds / 1000),
    artworkURL,
  };
}

function spotifyEntityArtwork(entity) {
  const images = nestedValue(entity.coverArt, ["sources"])
    || nestedValue(entity.visualIdentity, ["image"]);
  return Array.isArray(images)
    ? images.slice().sort((left, right) =>
      (safeNumber(right?.width) || safeNumber(right?.maxWidth) || 0)
      - (safeNumber(left?.width) || safeNumber(left?.maxWidth) || 0))
      .map((image) => isRecord(image) ? spotifyArtworkURL(image.url) : null)
      .find(Boolean) || null
    : null;
}

function parseSpotifyPlaylistEmbed(html, expectedPlaylistID) {
  const entity = nestedValue(nextData(html), ["props", "pageProps", "state", "data", "entity"]);
  if (!isRecord(entity) || entity.type !== "playlist" || entity.id !== expectedPlaylistID || !SPOTIFY_ID.test(expectedPlaylistID)) {
    throw importError("resolving_metadata", "SPOTIFY_MISMATCH", "Spotify returned mismatched playlist metadata.");
  }
  const title = cleanText(entity.title) || cleanText(entity.name);
  const author = cleanText(entity.subtitle) || "Spotify";
  if (!title || !Array.isArray(entity.trackList)) {
    throw importError("resolving_metadata", "SPOTIFY_INCOMPLETE_METADATA", "Spotify returned incomplete playlist metadata.");
  }
  const artworkURL = spotifyEntityArtwork(entity);
  const items = [];
  let unavailableCount = 0;
  let truncated = false;
  // Keep provider responses bounded just like YouTube and SoundCloud. Spotify
  // can expose very large playlists in one embed document; rendering and
  // resolving more than the shared playlist item limit would make the Windows
  // dialog unresponsive. Filter the provider rows first so skipped entries do
  // not consume the limit or hide playable tracks later in the playlist.
  for (const [index, item] of entity.trackList.entries()) {
    const uriMatch = /^spotify:track:([A-Za-z0-9]{22})$/.exec(cleanText(item?.uri, 128) || "");
    const itemTitle = cleanText(item?.title);
    const artist = cleanText(item?.subtitle);
    if (!isRecord(item) || item.entityType !== "track" || item.isPlayable === false || !uriMatch || !itemTitle || !artist) {
      unavailableCount += 1;
      continue;
    }
    const trackID = uriMatch[1];
    const durationMilliseconds = safeNumber(item.duration);
    const playableItem = {
      provider: "spotify",
      type: "track",
      trackID,
      title: itemTitle,
      artist,
      album: null,
      trackNumber: index + 1,
      durationSeconds: durationMilliseconds === null ? null : Math.round(durationMilliseconds / 1000),
      artworkURL: null,
      embedURL: `https://open.spotify.com/embed/track/${trackID}`,
      sourceURL: `https://open.spotify.com/track/${trackID}`,
    };
    if (items.length < MAX_PLAYLIST_ITEMS) items.push(playableItem);
    else truncated = true;
  }
  if (!items.length) {
    throw importError("resolving_metadata", "SPOTIFY_PLAYLIST_EMPTY", "This Spotify playlist has no public, playable tracks.");
  }
  return {
    title,
    author,
    artworkURL,
    items,
    unavailableCount,
    truncated,
  };
}

async function responseTextWithLimit(response, limit, error) {
  return new TextDecoder().decode(await readResponseBytes(response, limit, error));
}

function spotifyProviderFailure(response) {
  if (response.status === 404) return importError("resolving_metadata", "SPOTIFY_NOT_FOUND", "Spotify could not find that track.");
  if (response.status === 429) {
    return importError("resolving_metadata", "SPOTIFY_RATE_LIMITED", "Spotify rate-limited the track request.", {
      retryAfter: response.headers.get("retry-after"),
    });
  }
  return importError("resolving_metadata", "SPOTIFY_PROVIDER_FAILED", "Spotify could not load that track.");
}

async function canonicalSpotifySource(value, kind, signal, fetchImpl) {
  const parseURL = kind === "playlist" ? spotifyPlaylistURL : spotifyTrackURL;
  const direct = parseURL(value);
  if (direct) return direct;
  let current = spotifySourceURL(value);
  for (let redirects = 0; redirects <= 5; redirects += 1) {
    let response;
    try {
      response = await fetchImpl(current, { method: "HEAD", redirect: "manual", signal });
    } catch (error) {
      if (error?.name === "AbortError") throw error;
      throw importError("resolving_metadata", "SPOTIFY_UNREACHABLE", "Spotify could not resolve that short link.");
    }
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get("location");
      await response.body?.cancel().catch(() => undefined);
      if (!location) {
        throw importError("resolving_metadata", "SPOTIFY_INVALID_REDIRECT", `Spotify returned an invalid ${kind} link.`);
      }
      try { current = spotifySourceURL(new URL(location, current).toString()); }
      catch {
        throw importError("resolving_metadata", "SPOTIFY_INVALID_REDIRECT", `Spotify returned an unsafe ${kind} redirect.`);
      }
      continue;
    }
    if (!response.ok) throw spotifyProviderFailure(response);
    const resolved = parseURL(response.url || current.toString());
    if (!resolved) throw importError("resolving_metadata", "SPOTIFY_INVALID_REDIRECT", `Spotify returned an invalid ${kind} link.`);
    return resolved;
  }
  throw importError("resolving_metadata", "SPOTIFY_TOO_MANY_REDIRECTS", `Spotify redirected the ${kind} link too many times.`);
}

async function resolveSpotifyTrack(value, signal, fetchImpl = fetch) {
  const canonical = await canonicalSpotifySource(value, "track", signal, fetchImpl);
  const oEmbedURL = new URL("/oembed", canonical.url.origin);
  oEmbedURL.searchParams.set("url", canonical.url.toString());
  let response;
  try {
    response = await fetchImpl(oEmbedURL, { headers: { Accept: "application/json" }, redirect: "error", signal });
  } catch (error) {
    if (error?.name === "AbortError") throw error;
    throw importError("resolving_metadata", "SPOTIFY_UNREACHABLE", "Spotify could not be reached.");
  }
  if (!response.ok) throw spotifyProviderFailure(response);
  let payload;
  try {
    payload = JSON.parse(await responseTextWithLimit(
      response,
      256 * 1024,
      importError("resolving_metadata", "SPOTIFY_INVALID_PREVIEW", "Spotify returned an invalid track preview."),
    ));
  } catch (error) {
    if (error instanceof LocalImportError) throw error;
    if (error?.name === "AbortError") throw error;
    throw importError("resolving_metadata", "SPOTIFY_INVALID_PREVIEW", "Spotify returned an invalid track preview.");
  }
  const oEmbed = parseSpotifyOEmbed(payload, canonical.trackID);
  let embedResponse;
  try {
    embedResponse = await fetchImpl(oEmbed.embedURL, {
      headers: { Accept: "text/html", "User-Agent": "Slopify/1.0" },
      redirect: "error",
      signal,
    });
  } catch (error) {
    if (error?.name === "AbortError") throw error;
    throw importError("resolving_metadata", "SPOTIFY_UNREACHABLE", "Spotify could not load the track metadata.");
  }
  if (!embedResponse.ok) throw spotifyProviderFailure(embedResponse);
  const embedded = parseSpotifyEmbedEntity(
    await responseTextWithLimit(
      embedResponse,
      MAX_SPOTIFY_RESPONSE_BYTES,
      importError("resolving_metadata", "SPOTIFY_INVALID_METADATA", "Spotify returned invalid track metadata."),
    ),
    canonical.trackID,
  );
  return {
    provider: "spotify",
    type: "track",
    trackID: canonical.trackID,
    title: embedded.title,
    artist: embedded.artist,
    album: null,
    trackNumber: null,
    durationSeconds: embedded.durationSeconds,
    artworkURL: embedded.artworkURL || oEmbed.artworkURL,
    embedURL: oEmbed.embedURL,
    sourceURL: canonical.url.toString(),
  };
}

async function resolveSpotifyPlaylistItemArtwork(item, signal, fetchImpl) {
  const canonical = spotifyTrackURL(item.sourceURL);
  const oEmbedURL = new URL("/oembed", canonical.url.origin);
  oEmbedURL.searchParams.set("url", canonical.url.toString());
  const response = await fetchImpl(oEmbedURL, {
    headers: { Accept: "application/json" },
    redirect: "error",
    signal,
  });
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    return null;
  }
  const payload = JSON.parse(await responseTextWithLimit(
    response,
    256 * 1024,
    importError("resolving_metadata", "SPOTIFY_INVALID_PREVIEW", "Spotify returned an invalid track preview."),
  ));
  return parseSpotifyOEmbed(payload, canonical.trackID).artworkURL;
}

async function resolveSpotifyPlaylist(value, signal, fetchImpl = fetch) {
  const canonical = await canonicalSpotifySource(value, "playlist", signal, fetchImpl);
  const oEmbedURL = new URL("/oembed", canonical.url.origin);
  oEmbedURL.searchParams.set("url", canonical.url.toString());
  let response;
  try {
    response = await fetchImpl(oEmbedURL, { headers: { Accept: "application/json" }, redirect: "error", signal });
  } catch (error) {
    if (error?.name === "AbortError") throw error;
    throw importError("resolving_metadata", "SPOTIFY_UNREACHABLE", "Spotify could not be reached.");
  }
  if (!response.ok) throw spotifyProviderFailure(response);
  let payload;
  try {
    payload = JSON.parse(await responseTextWithLimit(
      response,
      256 * 1024,
      importError("resolving_metadata", "SPOTIFY_INVALID_PREVIEW", "Spotify returned an invalid playlist preview."),
    ));
  } catch (error) {
    if (error instanceof LocalImportError || error?.name === "AbortError") throw error;
    throw importError("resolving_metadata", "SPOTIFY_INVALID_PREVIEW", "Spotify returned an invalid playlist preview.");
  }
  const oEmbed = parseSpotifyPlaylistOEmbed(payload, canonical.playlistID);
  let embedResponse;
  try {
    embedResponse = await fetchImpl(oEmbed.embedURL, {
      headers: { Accept: "text/html", "User-Agent": "Slopify/1.0" },
      redirect: "error",
      signal,
    });
  } catch (error) {
    if (error?.name === "AbortError") throw error;
    throw importError("resolving_metadata", "SPOTIFY_UNREACHABLE", "Spotify could not load the playlist metadata.");
  }
  if (!embedResponse.ok) throw spotifyProviderFailure(embedResponse);
  const embedded = parseSpotifyPlaylistEmbed(
    await responseTextWithLimit(
      embedResponse,
      MAX_SPOTIFY_RESPONSE_BYTES,
      importError("resolving_metadata", "SPOTIFY_INVALID_METADATA", "Spotify returned invalid playlist metadata."),
    ),
    canonical.playlistID,
  );
  const items = [];
  for (let offset = 0; offset < embedded.items.length; offset += 4) {
    const chunk = embedded.items.slice(offset, offset + 4);
    const hydrated = await Promise.all(chunk.map(async (item) => {
      try {
        return {
          ...item,
          artworkURL: await resolveSpotifyPlaylistItemArtwork(item, signal, fetchImpl),
        };
      } catch (error) {
        if (error?.name === "AbortError") throw error;
        return { ...item, artworkURL: null };
      }
    }));
    items.push(...hydrated);
  }
  return {
    playlistID: canonical.playlistID,
    title: embedded.title || oEmbed.title,
    author: embedded.author,
    artworkURL: embedded.artworkURL || oEmbed.artworkURL,
    sourceURL: canonical.url.toString(),
    items,
    unavailableCount: embedded.unavailableCount,
    truncated: Boolean(embedded.truncated),
  };
}

function rendererText(value) {
  if (!isRecord(value)) return null;
  const simple = cleanText(value.simpleText);
  if (simple) return simple;
  if (!Array.isArray(value.runs)) return null;
  return cleanText(value.runs.map((run) => isRecord(run) ? cleanText(run.text) : null).filter(Boolean).join(""));
}

function parseDuration(value) {
  if (!value || !/^\d{1,3}(?::\d{2}){1,2}$/.test(value.trim())) return null;
  const parts = value.split(":").map(Number);
  if (parts.some((part) => !Number.isSafeInteger(part) || part < 0)) return null;
  return parts.reduce((seconds, part) => seconds * 60 + part, 0);
}

function safeThumbnail(value) {
  if (!isRecord(value) || !Array.isArray(value.thumbnails)) return null;
  return value.thumbnails.map((thumbnail, index) => ({ thumbnail, index }))
    .sort((left, right) => {
      const leftWidth = isRecord(left.thumbnail) ? Math.min(safeNumber(left.thumbnail.width) || 0, 1_000_000) : 0;
      const leftHeight = isRecord(left.thumbnail) ? Math.min(safeNumber(left.thumbnail.height) || 0, 1_000_000) : 0;
      const rightWidth = isRecord(right.thumbnail) ? Math.min(safeNumber(right.thumbnail.width) || 0, 1_000_000) : 0;
      const rightHeight = isRecord(right.thumbnail) ? Math.min(safeNumber(right.thumbnail.height) || 0, 1_000_000) : 0;
      const areaDifference = (rightWidth * rightHeight) - (leftWidth * leftHeight);
      if (areaDifference) return areaDifference;
      const edgeDifference = Math.max(rightWidth, rightHeight) - Math.max(leftWidth, leftHeight);
      return edgeDifference || right.index - left.index;
    })
    .map(({ thumbnail }) => isRecord(thumbnail) ? cleanText(thumbnail.url, 2_048) : null).find((candidate) => {
      if (!candidate) return false;
      try {
        const url = new URL(candidate);
        return url.protocol === "https:" &&
          (url.hostname === "i.ytimg.com" || url.hostname.endsWith(".ytimg.com") || url.hostname.endsWith(".ggpht.com") || url.hostname === "yt3.googleusercontent.com");
      } catch {
        return false;
      }
    }) || null;
}

function walk(value, visit) {
  if (Array.isArray(value)) {
    for (const item of value) walk(item, visit);
    return;
  }
  if (!isRecord(value)) return;
  visit(value);
  for (const nested of Object.values(value)) walk(nested, visit);
}

function extractYouTubeInitialData(html) {
  for (const marker of ["var ytInitialData =", 'window["ytInitialData"] =', "ytInitialData ="]) {
    const markerIndex = html.indexOf(marker);
    if (markerIndex < 0) continue;
    const objectStart = html.indexOf("{", markerIndex + marker.length);
    if (objectStart < 0) continue;
    const json = balancedJSONObject(html, objectStart);
    if (!json) continue;
    try { return JSON.parse(json); } catch { /* Try another assignment shape. */ }
  }
  return null;
}

function extractYouTubeWatchDescription(html) {
  const match = /"shortDescription":"((?:\\.|[^"\\])*)"/.exec(html);
  if (!match?.[1]) return null;
  try { return JSON.parse(`"${match[1]}"`); } catch { return null; }
}

function musicColumnText(value) {
  if (!isRecord(value)) return { text: null, runs: [] };
  const column = value.musicResponsiveListItemFlexColumnRenderer;
  if (!isRecord(column) || !isRecord(column.text)) return { text: null, runs: [] };
  const runs = Array.isArray(column.text.runs) ? column.text.runs.filter(isRecord) : [];
  return { text: rendererText(column.text), runs };
}

function musicCandidate(renderer) {
  const data = renderer.playlistItemData;
  const videoID = isRecord(data) ? cleanText(data.videoId, 11) : null;
  if (!videoID || !YOUTUBE_VIDEO_ID.test(videoID)) return null;
  const columns = Array.isArray(renderer.flexColumns) ? renderer.flexColumns : [];
  const primary = musicColumnText(columns[0]);
  const secondary = musicColumnText(columns[1]);
  if (!primary.text) return null;
  let artist = null;
  let album = null;
  let durationSeconds = null;
  const unclassified = [];
  for (const run of secondary.runs) {
    const value = cleanText(run.text);
    if (!value || value === "•") continue;
    const duration = parseDuration(value);
    if (duration !== null) { durationSeconds = duration; continue; }
    const browse = isRecord(run.navigationEndpoint) ? run.navigationEndpoint.browseEndpoint : null;
    const browseID = isRecord(browse) ? cleanText(browse.browseId, 128) : null;
    const config = isRecord(browse?.browseEndpointContextSupportedConfigs)
      ? browse.browseEndpointContextSupportedConfigs.browseEndpointContextMusicConfig
      : null;
    const pageType = isRecord(config) ? cleanText(config.pageType, 128) : null;
    if (browseID?.startsWith("MPRE") || pageType?.includes("ALBUM")) album ||= value;
    else if (browseID?.startsWith("UC") || pageType?.includes("ARTIST")) artist ||= value;
    else unclassified.push(value);
  }
  artist ||= unclassified[0] || null;
  album ||= unclassified[1] || null;
  const thumbnailContainer = isRecord(renderer.thumbnail) ? renderer.thumbnail.musicThumbnailRenderer : null;
  const thumbnailURL = isRecord(thumbnailContainer) ? safeThumbnail(thumbnailContainer.thumbnail) : null;
  return {
    videoID,
    title: primary.text,
    artist,
    album,
    durationSeconds,
    thumbnailURL,
    sourceProvider: "youtube_music",
    officialArtist: Array.isArray(renderer.badges) && renderer.badges.some((badge) => {
      const musicBadge = isRecord(badge) ? badge.musicInlineBadgeRenderer : null;
      const iconType = isRecord(musicBadge?.icon) ? cleanText(musicBadge.icon.iconType, 128) : null;
      return Boolean(iconType?.includes("VERIFIED"));
    }),
  };
}

function webCandidate(renderer) {
  const videoID = cleanText(renderer.videoId, 11);
  const title = rendererText(renderer.title);
  if (!videoID || !YOUTUBE_VIDEO_ID.test(videoID) || !title) return null;
  const badges = [
    ...(Array.isArray(renderer.ownerBadges) ? renderer.ownerBadges : []),
    ...(Array.isArray(renderer.badges) ? renderer.badges : []),
  ];
  const artist = rendererText(renderer.ownerText) || rendererText(renderer.longBylineText) || rendererText(renderer.shortBylineText);
  return {
    videoID,
    title,
    artist,
    album: null,
    durationSeconds: parseDuration(rendererText(renderer.lengthText)),
    thumbnailURL: safeThumbnail(renderer.thumbnail),
    videoThumbnailURL: safeThumbnail(renderer.thumbnail),
    creatorAvatarURL: safeThumbnail(renderer.channelThumbnailSupportedRenderers?.channelThumbnailWithLinkRenderer?.thumbnail),
    sourceProvider: "youtube",
    officialArtist: /\btopic$/i.test(artist || "") || badges.some((badge) => {
      const metadataBadge = isRecord(badge) ? badge.metadataBadgeRenderer : null;
      const style = isRecord(metadataBadge) ? cleanText(metadataBadge.style, 128) : null;
      return Boolean(style?.includes("VERIFIED"));
    }),
  };
}

function playlistVideoIndex(renderer, fallbackIndex = 0) {
  const parsedIndex = Number(rendererText(renderer.index));
  return Number.isSafeInteger(parsedIndex) && parsedIndex > 0 && parsedIndex <= MAX_PLAYLIST_POSITION
    ? parsedIndex
    : fallbackIndex + 1;
}

function playlistVideoCandidate(renderer, fallbackIndex = 0) {
  const videoID = cleanText(renderer.videoId, 11);
  const title = rendererText(renderer.title);
  if (!videoID || !YOUTUBE_VIDEO_ID.test(videoID) || !title || renderer.isPlayable === false) return null;
  return {
    videoID,
    title,
    artist: rendererText(renderer.shortBylineText) || rendererText(renderer.longBylineText) || "Unknown uploader",
    album: null,
    durationSeconds: parseDuration(rendererText(renderer.lengthText)),
    thumbnailURL: safeThumbnail(renderer.thumbnail),
    sourceProvider: "youtube",
    officialArtist: false,
    sourceURL: `https://www.youtube.com/watch?v=${videoID}`,
    playlistIndex: playlistVideoIndex(renderer, fallbackIndex),
    score: 1,
    confidence: "high",
    match: { title: 1, artist: 1, album: null, duration: 1, durationDeltaSeconds: 0 },
  };
}

function safeImageSources(value) {
  if (!isRecord(value) || !Array.isArray(value.sources)) return null;
  return value.sources.slice().sort((left, right) => safeNumber(right?.width) - safeNumber(left?.width))
    .map((source) => cleanText(source?.url, 2_048)).find((candidate) => {
      if (!candidate) return false;
      try {
        const url = new URL(candidate);
        return url.protocol === "https:" &&
          (url.hostname === "i.ytimg.com" || url.hostname.endsWith(".ytimg.com") || url.hostname.endsWith(".ggpht.com"));
      } catch {
        return false;
      }
    }) || null;
}

function lockupPlaylistCandidate(renderer, fallbackIndex = 0) {
  const videoID = cleanText(renderer.contentId, 11);
  if (renderer.contentType !== "LOCKUP_CONTENT_TYPE_VIDEO" || !videoID || !YOUTUBE_VIDEO_ID.test(videoID)) return null;
  const metadata = renderer.metadata?.lockupMetadataViewModel;
  const title = cleanText(metadata?.title?.content);
  if (!title) return null;
  const rows = metadata?.metadata?.contentMetadataViewModel?.metadataRows;
  const artist = Array.isArray(rows?.[0]?.metadataParts)
    ? cleanText(rows[0].metadataParts.map((part) => cleanText(part?.text?.content)).filter(Boolean).join(" • "))
    : null;
  const overlays = renderer.contentImage?.thumbnailViewModel?.overlays;
  let durationSeconds = null;
  if (Array.isArray(overlays)) {
    for (const overlay of overlays) {
      const badges = overlay?.thumbnailBottomOverlayViewModel?.badges;
      if (!Array.isArray(badges)) continue;
      for (const badge of badges) {
        const duration = parseDuration(cleanText(badge?.thumbnailBadgeViewModel?.text));
        if (duration !== null) { durationSeconds = duration; break; }
      }
      if (durationSeconds !== null) break;
    }
  }
  return {
    videoID,
    title,
    artist: artist || "Unknown uploader",
    album: null,
    durationSeconds,
    thumbnailURL: safeImageSources(renderer.contentImage?.thumbnailViewModel?.image),
    sourceProvider: "youtube",
    officialArtist: false,
    sourceURL: `https://www.youtube.com/watch?v=${videoID}`,
    playlistIndex: fallbackIndex + 1,
    score: 1,
    confidence: "high",
    match: { title: 1, artist: 1, album: null, duration: 1, durationDeltaSeconds: 0 },
  };
}

function youtubePlaylistThumbnail(record) {
  const renderer = record.playlistSidebarPrimaryInfoRenderer;
  if (!isRecord(renderer?.thumbnailRenderer)) return null;
  const thumbnail = renderer.thumbnailRenderer.playlistVideoThumbnailRenderer?.thumbnail
    || renderer.thumbnailRenderer.playlistCustomThumbnailRenderer?.thumbnail;
  return safeThumbnail(thumbnail);
}

function parseYouTubePlaylistData(value, expectedPlaylistID = null, fallbackIndexOffset = 0) {
  const items = [];
  let title = null;
  let author = null;
  let artworkURL = null;
  let continuation = null;
  let unavailableCount = 0;
  let lastPlaylistIndex = Number.isSafeInteger(fallbackIndexOffset) && fallbackIndexOffset >= 0
    ? fallbackIndexOffset
    : 0;
  walk(value, (record) => {
    const metadata = record.playlistMetadataRenderer;
    if (isRecord(metadata)) {
      const metadataID = cleanText(metadata.playlistId, 150);
      if (expectedPlaylistID && metadataID && metadataID !== expectedPlaylistID) {
        throw importError("resolving_metadata", "YOUTUBE_PLAYLIST_MISMATCH", "YouTube returned the wrong playlist.");
      }
      title ||= cleanText(metadata.title);
    }
    const header = record.playlistHeaderRenderer;
    if (isRecord(header)) {
      title ||= rendererText(header.title);
      author ||= rendererText(header.ownerText);
    }
    artworkURL ||= youtubePlaylistThumbnail(record);
    const renderer = record.playlistVideoRenderer;
    if (isRecord(renderer)) {
      const fallbackIndex = lastPlaylistIndex + 1;
      const playlistIndex = playlistVideoIndex(renderer, lastPlaylistIndex);
      const parsed = playlistVideoCandidate(renderer, lastPlaylistIndex);
      lastPlaylistIndex = Math.max(fallbackIndex, playlistIndex);
      const item = parsed ? { ...parsed, playlistIndex: lastPlaylistIndex } : null;
      if (item) items.push(item);
      else unavailableCount += 1;
    }
    const lockup = record.lockupViewModel;
    if (isRecord(lockup)) {
      if (lockup.contentType === "LOCKUP_CONTENT_TYPE_VIDEO") {
        const fallbackIndex = lastPlaylistIndex + 1;
        const item = lockupPlaylistCandidate(lockup, lastPlaylistIndex);
        lastPlaylistIndex = fallbackIndex;
        if (item) items.push({ ...item, playlistIndex: fallbackIndex });
        else unavailableCount += 1;
      }
    }
    const token = record.continuationItemRenderer?.continuationEndpoint?.continuationCommand?.token;
    if (typeof token === "string" && token.length > 0 && token.length <= 8_192) continuation = token;
  });
  return { title, author, artworkURL, items, continuation, unavailableCount, lastPlaylistIndex };
}

function youtubeConfigurationValue(html, key, maximum = 2_048) {
  const expression = new RegExp(`"${key}"\\s*:\\s*"((?:\\\\.|[^"\\\\])*)"`);
  const match = expression.exec(html);
  if (!match?.[1]) return null;
  try {
    const value = JSON.parse(`"${match[1]}"`);
    return typeof value === "string" && value.length <= maximum ? value : null;
  } catch {
    return null;
  }
}

async function youtubePlaylistContinuation(token, configuration, signal, fetchImpl) {
  const endpoint = new URL("/youtubei/v1/browse", "https://www.youtube.com");
  endpoint.searchParams.set("prettyPrint", "false");
  endpoint.searchParams.set("key", configuration.apiKey);
  let response;
  try {
    response = await fetchImpl(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "User-Agent": SEARCH_USER_AGENT,
        "X-YouTube-Client-Name": "1",
        "X-YouTube-Client-Version": configuration.clientVersion,
        ...(configuration.visitorData ? { "X-Goog-Visitor-Id": configuration.visitorData } : {}),
      },
      body: JSON.stringify({
        context: {
          client: {
            clientName: "WEB",
            clientVersion: configuration.clientVersion,
            hl: "en",
            gl: "US",
            ...(configuration.visitorData ? { visitorData: configuration.visitorData } : {}),
          },
        },
        continuation: token,
      }),
      redirect: "error",
      signal,
    });
  } catch (error) {
    if (error?.name === "AbortError") throw error;
    return null;
  }
  if (!response.ok || !allowedYouTubeDocumentURL(response.url || endpoint.toString())) {
    await response.body?.cancel().catch(() => undefined);
    return null;
  }
  try {
    return JSON.parse(await responseTextWithLimit(
      response,
      MAX_SEARCH_DOCUMENT_BYTES,
      importError("resolving_metadata", "YOUTUBE_PLAYLIST_RESPONSE_TOO_LARGE", "YouTube returned an oversized playlist response."),
    ));
  } catch (error) {
    if (error?.name === "AbortError") throw error;
    return null;
  }
}

async function resolveYouTubePlaylist(source, signal, fetchImpl = fetch) {
  const playlistID = youtubePlaylistID(source);
  if (!playlistID) throw importError("resolving_metadata", "INVALID_YOUTUBE_PLAYLIST", "Enter a supported YouTube playlist URL.");
  const playlistURL = new URL("/playlist", "https://www.youtube.com");
  playlistURL.searchParams.set("list", playlistID);
  const html = await searchDocument(playlistURL, signal, fetchImpl);
  if (!html) throw importError("resolving_metadata", "YOUTUBE_PLAYLIST_UNREACHABLE", "YouTube could not load that playlist.");
  const initialData = extractYouTubeInitialData(html);
  if (!initialData) throw importError("resolving_metadata", "YOUTUBE_PLAYLIST_INVALID", "YouTube returned invalid playlist metadata.");
  const firstPage = parseYouTubePlaylistData(initialData, playlistID);
  const result = { ...firstPage, items: firstPage.items.slice(0, MAX_PLAYLIST_ITEMS) };
  let fallbackIndexOffset = firstPage.lastPlaylistIndex;
  let truncated = firstPage.items.length > MAX_PLAYLIST_ITEMS;
  const configuration = {
    apiKey: youtubeConfigurationValue(html, "INNERTUBE_API_KEY", 256),
    clientVersion: youtubeConfigurationValue(html, "INNERTUBE_CLIENT_VERSION", 128),
    visitorData: youtubeConfigurationValue(html, "VISITOR_DATA", 2_048),
  };
  let continuation = firstPage.continuation;
  let continuationCount = 0;
  const seenTokens = new Set();
  while (
    continuation && configuration.apiKey && configuration.clientVersion
    && result.items.length < MAX_PLAYLIST_ITEMS && continuationCount < MAX_PLAYLIST_CONTINUATIONS
    && !seenTokens.has(continuation)
  ) {
    seenTokens.add(continuation);
    const response = await youtubePlaylistContinuation(continuation, configuration, signal, fetchImpl);
    if (!response) break;
    const page = parseYouTubePlaylistData(response, playlistID, fallbackIndexOffset);
    const remaining = MAX_PLAYLIST_ITEMS - result.items.length;
    if (page.items.length > remaining) truncated = true;
    result.items.push(...page.items.slice(0, remaining));
    result.unavailableCount += page.unavailableCount;
    fallbackIndexOffset = page.lastPlaylistIndex;
    continuation = page.continuation;
    continuationCount += 1;
  }
  if (!result.items.length) {
    throw importError("resolving_metadata", "YOUTUBE_PLAYLIST_EMPTY", "This playlist has no public, downloadable videos.");
  }
  return {
    playlistID,
    title: result.title || "YouTube Playlist",
    author: result.author,
    artworkURL: result.artworkURL || result.items[0]?.thumbnailURL || null,
    sourceURL: playlistURL.toString(),
    items: result.items,
    unavailableCount: result.unavailableCount,
    truncated: truncated || Boolean(continuation),
  };
}

function parseYouTubeMusicSearch(html) {
  const results = [];
  walk(extractYouTubeInitialData(html), (record) => {
    const renderer = record.musicResponsiveListItemRenderer;
    if (!isRecord(renderer)) return;
    const candidate = musicCandidate(renderer);
    if (candidate) results.push(candidate);
  });
  return results;
}

function parseYouTubeWebSearch(html) {
  const results = [];
  walk(extractYouTubeInitialData(html), (record) => {
    const renderer = record.videoRenderer;
    if (!isRecord(renderer)) return;
    const candidate = webCandidate(renderer);
    if (candidate) results.push(candidate);
  });
  return results;
}

function normalizeMatchText(value) {
  return (value || "").normalize("NFKD").replace(/\p{Diacritic}/gu, "").toLocaleLowerCase()
    .replace(/&/g, " and ")
    .replace(/\b(official|audio|video|visualizer|lyrics?|hd|hq|topic|provided to youtube by)\b/g, " ")
    .replace(/[^\p{Letter}\p{Number}]+/gu, " ").replace(/\s+/g, " ").trim();
}

function tokenScore(expected, actual) {
  const left = normalizeMatchText(expected);
  const right = normalizeMatchText(actual);
  if (!left || !right) return 0;
  if (left === right) return 1;
  if (right.includes(left) || left.includes(right)) return 0.92;
  const leftTokens = new Set(left.split(" "));
  const rightTokens = new Set(right.split(" "));
  let shared = 0;
  for (const token of leftTokens) if (rightTokens.has(token)) shared += 1;
  return 2 * shared / (leftTokens.size + rightTokens.size);
}

function durationScore(expected, actual) {
  if (!expected || !actual) return { score: null, delta: null };
  const delta = Math.abs(expected - actual);
  if (delta <= 2) return { score: 1, delta };
  if (delta <= 5) return { score: 0.88, delta };
  if (delta <= 10) return { score: 0.62, delta };
  if (delta <= 20) return { score: 0.24, delta };
  return { score: 0, delta };
}

function hasUnmatchedQualifier(expected, candidate) {
  const expectedText = normalizeMatchText(expected);
  for (const match of candidate.matchAll(/(?:\(([^)]{1,120})\)|\[([^\]]{1,120})\])/g)) {
    const qualifier = normalizeMatchText(match[1] || match[2]);
    if (qualifier && !expectedText.includes(qualifier)) return true;
  }
  return false;
}

function scoreAudioSource(track, candidate) {
  const title = tokenScore(track.title, candidate.title);
  const artist = Math.max(tokenScore(track.artist, candidate.artist), tokenScore(track.artist, candidate.title) * 0.75);
  const album = track.album && candidate.album ? tokenScore(track.album, candidate.album) : null;
  const duration = durationScore(track.durationSeconds, candidate.durationSeconds);
  const weighted = [[0.46, title], [0.25, artist], [0.11, album], [0.18, duration.score]];
  let total = 0;
  let weight = 0;
  for (const [candidateWeight, value] of weighted) {
    if (value === null) continue;
    total += candidateWeight * value;
    weight += candidateWeight;
  }
  let score = weight ? total / weight : 0;
  if (VERSION_WORDS.test(candidate.title) && !VERSION_WORDS.test(track.title)) score -= 0.18;
  if (hasUnmatchedQualifier(track.title, candidate.title)) score -= 0.18;
  if (candidate.officialArtist) score += 0.07;
  const targetNonLatin = (track.title.match(/[^\x00-\x7F]/g) || []).length;
  const candidateNonLatin = (candidate.title.match(/[^\x00-\x7F]/g) || []).length;
  if (targetNonLatin === 0 && candidateNonLatin >= 3) score -= 0.14;
  if (/\b(topic|official artist channel)\b/i.test(candidate.artist || "")) score += 0.035;
  score = Math.max(0, Math.min(1, score));
  if (title < 0.48 || artist < 0.28 || (duration.delta !== null && duration.delta > 24) || score < 0.56) return null;
  return {
    ...candidate,
    sourceURL: `https://www.youtube.com/watch?v=${candidate.videoID}`,
    score: Number(score.toFixed(4)),
    // These candidates are inferred from public metadata rather than verified
    // against the source audio. Keep them useful for human review, but never
    // let a high text score silently become an automatic library association.
    confidence: "possible",
    evidenceStrength: "metadata_only",
    requiresReview: true,
    autoSelectable: false,
    actionable: false,
    match: {
      title: Number(title.toFixed(4)),
      artist: Number(artist.toFixed(4)),
      album: album === null ? null : Number(album.toFixed(4)),
      duration: duration.score === null ? null : Number(duration.score.toFixed(4)),
      durationDeltaSeconds: duration.delta,
    },
  };
}

function allowedYouTubeDocumentURL(value) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && YOUTUBE_HOSTS.has(url.hostname.toLowerCase());
  } catch {
    return false;
  }
}

async function searchDocument(url, signal, fetchImpl) {
  let current = url;
  let response = null;
  for (let redirects = 0; redirects <= 5; redirects += 1) {
    try {
      response = await fetchImpl(current, {
        headers: { Accept: "text/html,application/xhtml+xml", "Accept-Language": "en-US,en;q=0.8", "User-Agent": SEARCH_USER_AGENT },
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
      if (!allowedYouTubeDocumentURL(current)) return null;
      continue;
    }
    break;
  }
  if (!response?.ok || !allowedYouTubeDocumentURL(response.url || current.toString())) {
    await response?.body?.cancel().catch(() => undefined);
    return null;
  }
  try {
    return await responseTextWithLimit(
      response,
      MAX_SEARCH_DOCUMENT_BYTES,
      importError("searching_candidates", "SEARCH_RESPONSE_TOO_LARGE", "A provider search response was too large."),
    );
  } catch (error) {
    if (error?.name === "AbortError") throw error;
    return null;
  }
}

async function enrichCandidate(track, candidate, signal, fetchImpl) {
  const watchURL = new URL("/watch", "https://www.youtube.com");
  watchURL.searchParams.set("v", candidate.videoID);
  const html = await searchDocument(watchURL, signal, fetchImpl);
  const description = html ? extractYouTubeWatchDescription(html) : null;
  if (!description) return candidate;
  const normalizedDescription = normalizeMatchText(description);
  const normalizedAlbum = normalizeMatchText(track.album);
  const normalizedArtist = normalizeMatchText(track.artist);
  return {
    ...candidate,
    album: normalizedAlbum && normalizedDescription.includes(normalizedAlbum) ? track.album : candidate.album,
    artist: normalizedArtist && normalizedDescription.includes(normalizedArtist) ? track.artist : candidate.artist,
  };
}

async function searchYouTubeAudioSources(track, signal, fetchImpl = fetch, options = {}) {
  const maximumResults = Math.max(1, Math.min(MAX_RESULTS, Number(options.maxResults) || MAX_RESULTS));
  const shouldEnrich = options.enrich !== false;
  const query = [track.artist, track.title, track.album].filter(Boolean).join(" ");
  const musicURL = new URL("/search", "https://music.youtube.com");
  musicURL.searchParams.set("q", query);
  const webURL = new URL("/results", "https://www.youtube.com");
  webURL.searchParams.set("search_query", `${track.artist} ${track.title} official audio`);
  webURL.searchParams.set("sp", "EgIQAQ%3D%3D");
  const [musicHTML, webHTML] = await Promise.all([
    searchDocument(musicURL, signal, fetchImpl),
    searchDocument(webURL, signal, fetchImpl),
  ]);
  const unique = new Map();
  for (const candidate of [
    ...(musicHTML ? parseYouTubeMusicSearch(musicHTML) : []),
    ...(webHTML ? parseYouTubeWebSearch(webHTML) : []),
  ]) {
    const existing = unique.get(candidate.videoID);
    if (!existing || candidate.sourceProvider === "youtube_music") unique.set(candidate.videoID, candidate);
  }
  const preliminary = [...unique.values()].map((candidate) => scoreAudioSource(track, candidate))
    .filter(Boolean).sort((left, right) => right.score - left.score).slice(0, maximumResults);
  if (!shouldEnrich) return preliminary;
  const enriched = await Promise.all(preliminary.map((candidate) => enrichCandidate(track, candidate, signal, fetchImpl)));
  return enriched.map((candidate) => scoreAudioSource(track, candidate)).filter(Boolean)
    .sort((left, right) => right.score - left.score).slice(0, maximumResults);
}

module.exports = {
  LocalImportError,
  extractYouTubeInitialData,
  extractYouTubeWatchDescription,
  isSpotifyURL,
  normalizeMatchText,
  parseSpotifyEmbedEntity,
  parseSpotifyOEmbed,
  parseSpotifyPlaylistEmbed,
  parseSpotifyPlaylistOEmbed,
  parseYouTubeMusicSearch,
  parseYouTubePlaylistData,
  parseYouTubeWebSearch,
  resolveYouTubePlaylist,
  resolveSpotifyTrack,
  resolveSpotifyPlaylist,
  scoreAudioSource,
  searchYouTubeAudioSources,
  spotifyArtworkURL,
  spotifyPlaylistURL,
  youtubePlaylistID,
  youtubeVideoID,
};
