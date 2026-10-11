const { readResponseBytes } = require("./response-body.cjs");
const {
  LocalImportError,
  parseYouTubeMusicSearch,
  parseYouTubeWebSearch,
  scoreAudioSource,
  spotifyArtworkURL,
} = require("./local-import-core.cjs");
const {
  directSoundCloudCandidate,
  parseSoundCloudHydration,
  parseSoundCloudTrack,
} = require("./local-soundcloud.cjs");

const SEARCH_PROVIDERS = ["spotify", "soundcloud", "youtube"];
const MAX_QUERY_LENGTH = 200;
const MAX_DOCUMENT_BYTES = 8 * 1024 * 1024;
const MAX_RESULTS_PER_PROVIDER = 6;
const WEB_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) " +
  "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36";

function searchError(code, message) {
  return new LocalImportError("searching_candidates", code, message);
}

function cleanText(value, maximum = 500) {
  if (typeof value !== "string") return null;
  const cleaned = value.replace(/[\u0000-\u001f]+/g, " ").replace(/\s+/g, " ").trim();
  return cleaned ? cleaned.slice(0, maximum) : null;
}

function looksLikeLink(value) {
  const input = String(value || "").trim();
  if (!input || /\s/.test(input)) return /^[a-z][a-z0-9+.-]*:\/\//i.test(input);
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(input)
    || /^www\./i.test(input)
    || /^[^/?#]+\.[a-z]{2,}(?:[/?#:]|$)/i.test(input);
}

function normalizedSearchText(value) {
  return String(value || "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLocaleLowerCase("en-US")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

function queryRelevance(query, track) {
  const expected = normalizedSearchText(query);
  const actual = normalizedSearchText(`${track.title || ""} ${track.artist || ""}`);
  if (!expected || !actual) return 0;
  if (actual === expected) return 3;
  const expectedTokens = new Set(expected.split(" ").filter(Boolean));
  const actualTokens = new Set(actual.split(" ").filter(Boolean));
  const matched = [...expectedTokens].filter((token) => actualTokens.has(token)).length;
  return matched / Math.max(expectedTokens.size, 1) + (actual.includes(expected) ? 1 : 0);
}

function safeInteger(value) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= 0 ? number : null;
}

function parseSpotifySearch(payload) {
  const values = payload?.data?.tracks;
  if (!Array.isArray(values)) return [];
  const seen = new Set();
  return values.flatMap((value) => {
    const trackID = cleanText(value?.id, 22);
    const title = cleanText(value?.title);
    const artist = cleanText(value?.artist);
    const album = cleanText(value?.album);
    if (!trackID || !/^[A-Za-z0-9]{22}$/.test(trackID) || !title || !artist || seen.has(trackID)) return [];
    seen.add(trackID);
    const rawDuration = Number(value?.duration);
    const durationSeconds = Number.isFinite(rawDuration) && rawDuration > 0
      ? Math.round(rawDuration > 86_400 ? rawDuration / 1000 : rawDuration)
      : null;
    return [{
      provider: "spotify",
      type: "track",
      trackID,
      title,
      artist,
      album,
      trackNumber: safeInteger(value?.trackNumber),
      durationSeconds,
      artworkURL: spotifyArtworkURL(value?.artworkURL),
      embedURL: `https://open.spotify.com/embed/track/${trackID}`,
      sourceURL: `https://open.spotify.com/track/${trackID}`,
    }];
  });
}

function allowedResponseURL(value, allowedHosts) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password && allowedHosts.has(url.hostname.toLowerCase());
  } catch {
    return false;
  }
}

function boundedBody(response, limit = MAX_DOCUMENT_BYTES) {
  return readResponseBytes(response, limit,
    searchError("SEARCH_RESPONSE_TOO_LARGE", "A provider search response was too large."));
}

async function providerResponse(url, signal, fetchImpl, allowedHosts, accept) {
  const response = await fetchImpl(url, {
    headers: { Accept: accept, "Accept-Language": "en-US,en;q=0.8", "User-Agent": WEB_USER_AGENT },
    redirect: "error",
    signal,
  });
  const responseURL = response.url || url.toString();
  if (!response.ok || !allowedResponseURL(responseURL, allowedHosts)) {
    await response.body?.cancel().catch(() => undefined);
    throw searchError("SEARCH_PROVIDER_FAILED", `A music search provider returned HTTP ${response.status}.`);
  }
  return response;
}

async function searchSpotify(query, signal, fetchImpl) {
  const url = new URL("https://debridvault.elfhosted.com/api/search");
  url.searchParams.set("q", query);
  url.searchParams.set("provider", "spotify");
  const response = await providerResponse(url, signal, fetchImpl, new Set(["debridvault.elfhosted.com"]), "application/json");
  const payload = JSON.parse((await boundedBody(response, 2 * 1024 * 1024)).toString("utf8"));
  return parseSpotifySearch(payload)
    .sort((left, right) => queryRelevance(query, right) - queryRelevance(query, left))
    .slice(0, MAX_RESULTS_PER_PROVIDER);
}

async function searchSoundCloud(query, signal, fetchImpl) {
  const pageURL = new URL("https://soundcloud.com/search/sounds");
  pageURL.searchParams.set("q", query);
  const pageResponse = await providerResponse(
    pageURL,
    signal,
    fetchImpl,
    new Set(["soundcloud.com", "www.soundcloud.com", "m.soundcloud.com"]),
    "text/html,application/xhtml+xml",
  );
  const hydration = parseSoundCloudHydration((await boundedBody(pageResponse)).toString("utf8"));
  const clientID = hydration.get("apiClient")?.id;
  if (typeof clientID !== "string" || !/^[A-Za-z0-9_-]{20,80}$/.test(clientID)) {
    throw searchError("SOUNDCLOUD_SEARCH_UNAVAILABLE", "SoundCloud did not provide an anonymous search session.");
  }
  const apiURL = new URL("https://api-v2.soundcloud.com/search/tracks");
  apiURL.searchParams.set("q", query);
  apiURL.searchParams.set("client_id", clientID);
  apiURL.searchParams.set("limit", "20");
  apiURL.searchParams.set("offset", "0");
  apiURL.searchParams.set("linked_partitioning", "1");
  const apiResponse = await providerResponse(apiURL, signal, fetchImpl, new Set(["api-v2.soundcloud.com"]), "application/json");
  const payload = JSON.parse((await boundedBody(apiResponse)).toString("utf8"));
  const values = Array.isArray(payload?.collection) ? payload.collection : [];
  return values.map((value) => parseSoundCloudTrack(value)).filter(Boolean)
    .sort((left, right) => queryRelevance(query, right) - queryRelevance(query, left))
    .slice(0, MAX_RESULTS_PER_PROVIDER);
}

async function searchYouTube(query, signal, fetchImpl) {
  const musicURL = new URL("https://music.youtube.com/search");
  musicURL.searchParams.set("q", query);
  const webURL = new URL("https://www.youtube.com/results");
  webURL.searchParams.set("search_query", query);
  webURL.searchParams.set("sp", "EgIQAQ%3D%3D");
  const hosts = new Set(["music.youtube.com", "www.youtube.com", "m.youtube.com", "youtube.com"]);
  const settled = await Promise.allSettled([musicURL, webURL].map(async (url) => {
    const response = await providerResponse(url, signal, fetchImpl, hosts, "text/html,application/xhtml+xml");
    return (await boundedBody(response)).toString("utf8");
  }));
  signal.throwIfAborted();
  const unique = new Map();
  const musicHTML = settled[0].status === "fulfilled" ? settled[0].value : null;
  const webHTML = settled[1].status === "fulfilled" ? settled[1].value : null;
  for (const candidate of [
    ...(musicHTML ? parseYouTubeMusicSearch(musicHTML) : []),
    ...(webHTML ? parseYouTubeWebSearch(webHTML) : []),
  ]) {
    const existing = unique.get(candidate.videoID);
    if (!existing || candidate.sourceProvider === "youtube_music") unique.set(candidate.videoID, candidate);
  }
  return [...unique.values()]
    .sort((left, right) => queryRelevance(query, right) - queryRelevance(query, left))
    .slice(0, 12);
}

function directYouTubeCandidate(candidate) {
  return {
    ...candidate,
    sourceURL: `https://www.youtube.com/watch?v=${candidate.videoID}`,
    score: 1,
    confidence: "search",
    match: { title: 1, artist: 1, album: candidate.album ? 1 : null, duration: candidate.durationSeconds ? 1 : null, durationDeltaSeconds: 0 },
  };
}

function matchedCandidates(track, youtubeCandidates) {
  return youtubeCandidates.map((candidate) => scoreAudioSource(track, candidate)).filter(Boolean)
    .sort((left, right) => right.score - left.score).slice(0, 3);
}

function resultCandidate(provider, track, candidates) {
  const [candidate, ...fallbackCandidates] = candidates;
  if (!candidate) return null;
  return {
    ...candidate,
    searchProvider: provider,
    importMetadata: track,
    fallbackCandidates,
  };
}

async function searchAllPlatforms(value, signal, fetchImpl = fetch, options = {}) {
  const query = cleanText(value, MAX_QUERY_LENGTH);
  const mediaKind = options?.mediaKind === "video" ? "video" : "audio";
  if (!query) throw searchError("MISSING_SEARCH_QUERY", "Enter a song, artist, or album to search.");
  if (looksLikeLink(value)) throw searchError("SEARCH_QUERY_IS_LINK", "Links are inspected directly instead of being sent to music search providers.");
  const settled = await Promise.allSettled([
    searchSpotify(query, signal, fetchImpl),
    searchSoundCloud(query, signal, fetchImpl),
    searchYouTube(query, signal, fetchImpl),
  ]);
  signal.throwIfAborted();
  const rejectedAbort = settled.find((value) => value.status === "rejected" && value.reason?.name === "AbortError");
  if (rejectedAbort) throw rejectedAbort.reason;
  const spotifyTracks = settled[0].status === "fulfilled" ? settled[0].value : [];
  const soundCloudTracks = settled[1].status === "fulfilled" ? settled[1].value : [];
  const youtubeTracks = settled[2].status === "fulfilled" ? settled[2].value : [];

  const spotify = spotifyTracks.map((track) => resultCandidate("spotify", track, matchedCandidates(track, youtubeTracks))).filter(Boolean);
  const soundcloud = soundCloudTracks.map((soundCloudTrack) => {
    const track = { ...soundCloudTrack };
    delete track.directlyImportable;
    const direct = mediaKind === "audio" && soundCloudTrack.directlyImportable
      ? directSoundCloudCandidate(soundCloudTrack)
      : null;
    const alternatives = matchedCandidates(track, youtubeTracks);
    return resultCandidate("soundcloud", track, direct ? [direct, ...alternatives] : alternatives);
  }).filter(Boolean);
  const youtube = youtubeTracks.slice(0, MAX_RESULTS_PER_PROVIDER).map((candidate) => {
    const track = {
      provider: candidate.sourceProvider,
      type: "track",
      trackID: candidate.videoID,
      title: candidate.title,
      artist: candidate.artist || "Unknown uploader",
      album: candidate.album || null,
      trackNumber: null,
      durationSeconds: candidate.durationSeconds || null,
      artworkURL: candidate.thumbnailURL || null,
      embedURL: "",
      sourceURL: `https://www.youtube.com/watch?v=${candidate.videoID}`,
    };
    return resultCandidate("youtube", track, [directYouTubeCandidate(candidate)]);
  });
  const candidates = [...spotify, ...soundcloud, ...youtube];
  if (!candidates.length) throw searchError("NO_SEARCH_RESULTS", "Spotify, SoundCloud, and YouTube returned no previewable results for that search.");
  const providerCounts = {
    spotify: spotify.length,
    soundcloud: soundcloud.length,
    youtube: youtube.length,
  };
  const unavailableProviders = SEARCH_PROVIDERS.filter((provider, index) => settled[index].status === "rejected");
  return {
    kind: "search_results",
    mediaKind,
    query,
    providerCounts,
    unavailableProviders,
    track: {
      provider: "search",
      type: "search",
      trackID: query,
      title: `Results for “${query}”`,
      artist: `${candidates.length} ${mediaKind === "video" ? "downloadable video" : "previewable result"}${candidates.length === 1 ? "" : "s"}`,
      album: "Spotify • SoundCloud • YouTube",
      trackNumber: null,
      durationSeconds: null,
      artworkURL: null,
      embedURL: "",
      sourceURL: "",
    },
    candidates,
  };
}

module.exports = {
  looksLikeLink,
  parseSpotifySearch,
  searchAllPlatforms,
};
