const { readResponseBytes } = require("./response-body.cjs");
const {
  LocalImportError,
  extractYouTubeInitialData,
  parseYouTubeMusicSearch,
  parseYouTubeSearchData,
  scoreAudioSource,
  spotifyArtworkURL,
  youtubeSearchConfiguration,
  youtubeSearchPage,
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

/*
 * Slopify: each provider is searched with its own deadline, retried once when the
 * failure looks temporary (a dropped connection, HTTP 429 or 5xx), and paused for
 * a few minutes after failing three times running. One slow or broken service
 * (Spotify search goes through a third-party site) then never holds up or breaks
 * the others. Answers are shared for a few minutes, so repeated searches (Home,
 * mixes and radio ask often) don't hit the providers again.
 */
const PROVIDER_DEADLINE_MS = { spotify: 8_000, soundcloud: 12_000, youtube: 15_000 };
const PAUSE_AFTER_FAILURES = 3;
const PAUSE_MS = 5 * 60_000;
const RESULT_CACHE_MS = 3 * 60_000;
const PARTIAL_CACHE_MS = 30_000;
const RESULT_CACHE_SIZE = 150;
/** Per fetch implementation, so tests with their own fetch start fresh. */
const providerState = new WeakMap();

function stateFor(fetchImpl) {
  let state = providerState.get(fetchImpl);
  if (!state) providerState.set(fetchImpl, (state = { health: new Map(), results: new Map(), pages: new Map() }));
  return state;
}

function temporaryFailure(error) {
  if (error?.name === "TimeoutError" || error instanceof TypeError) return true;
  return error?.status === 429 || error?.status >= 500;
}

function wait(ms, signal) {
  return new Promise((resolve, reject) => {
    const done = () => { signal.removeEventListener("abort", stop); resolve(); };
    const timer = setTimeout(done, ms);
    const stop = () => { clearTimeout(timer); reject(signal.reason); };
    signal.addEventListener("abort", stop, { once: true });
  });
}

async function guardedSearch(provider, search, query, signal, fetchImpl) {
  const { health } = stateFor(fetchImpl);
  const state = health.get(provider) ?? { failures: 0, pausedUntil: 0 };
  health.set(provider, state);
  if (state.pausedUntil > Date.now()) throw searchError("SEARCH_PROVIDER_PAUSED", `${provider} search is paused after repeated failures.`);
  for (let attempt = 0; ; attempt++) {
    try {
      const result = await search(query, AbortSignal.any([signal, AbortSignal.timeout(PROVIDER_DEADLINE_MS[provider])]), fetchImpl);
      state.failures = 0;
      return result;
    } catch (error) {
      if (signal.aborted) throw error;
      if (attempt === 0 && temporaryFailure(error)) {
        await wait(300 + Math.random() * 500, signal);
        continue;
      }
      if (++state.failures >= PAUSE_AFTER_FAILURES) {
        state.failures = 0;
        state.pausedUntil = Date.now() + PAUSE_MS;
      }
      // A provider's own deadline isn't the caller giving up.
      if (error?.name === "TimeoutError" || error?.name === "AbortError") throw searchError("SEARCH_PROVIDER_TIMEOUT", `${provider} search took too long.`);
      throw error;
    }
  }
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
    throw Object.assign(searchError("SEARCH_PROVIDER_FAILED", `A music search provider returned HTTP ${response.status}.`), { status: response.status });
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
  return soundCloudPage(query, clientID, 0, signal, fetchImpl);
}

/** One page of SoundCloud results (best match first), and where the next page starts, if there is one. */
async function soundCloudPage(query, clientID, offset, signal, fetchImpl) {
  const apiURL = new URL("https://api-v2.soundcloud.com/search/tracks");
  apiURL.searchParams.set("q", query);
  apiURL.searchParams.set("client_id", clientID);
  apiURL.searchParams.set("limit", String(PAGE_SIZE));
  apiURL.searchParams.set("offset", String(offset));
  apiURL.searchParams.set("linked_partitioning", "1");
  const apiResponse = await providerResponse(apiURL, signal, fetchImpl, new Set(["api-v2.soundcloud.com"]), "application/json");
  const payload = JSON.parse((await boundedBody(apiResponse)).toString("utf8"));
  const values = Array.isArray(payload?.collection) ? payload.collection : [];
  const items = values.map((value) => parseSoundCloudTrack(value)).filter(Boolean)
    .sort((left, right) => queryRelevance(query, right) - queryRelevance(query, left));
  const more = payload?.next_href && values.length && offset + PAGE_SIZE <= MAX_OFFSET ? { clientID, offset: offset + PAGE_SIZE } : null;
  return { items, more };
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
  // Both YouTube pages failing is YouTube failing (so it's retried, reported and paused), not "no results".
  if (settled.every((result) => result.status === "rejected")) throw settled[0].reason;
  const unique = new Map();
  const musicHTML = settled[0].status === "fulfilled" ? settled[0].value : null;
  const webHTML = settled[1].status === "fulfilled" ? settled[1].value : null;
  const web = webHTML ? parseYouTubeSearchData(extractYouTubeInitialData(webHTML)) : { candidates: [], continuation: null };
  const configuration = webHTML ? youtubeSearchConfiguration(webHTML) : null;
  for (const candidate of [
    ...(musicHTML ? parseYouTubeMusicSearch(musicHTML) : []),
    ...web.candidates,
  ]) {
    const existing = unique.get(candidate.videoID);
    if (!existing || candidate.sourceProvider === "youtube_music") unique.set(candidate.videoID, candidate);
    else {
      // YouTube Music's copy is kept, but only the web result has the channel avatar and the video's own thumbnail.
      if (candidate.creatorAvatarURL && !existing.creatorAvatarURL) existing.creatorAvatarURL = candidate.creatorAvatarURL;
      if (candidate.videoThumbnailURL) existing.videoThumbnailURL = candidate.videoThumbnailURL;
    }
  }
  const items = [...unique.values()].sort((left, right) => queryRelevance(query, right) - queryRelevance(query, left));
  return { items, more: web.continuation && configuration ? { token: web.continuation, configuration } : null };
}

async function nextYouTubePage(query, more, signal, fetchImpl) {
  const page = await youtubeSearchPage(more.token, more.configuration, signal, fetchImpl);
  if (!page) throw Object.assign(searchError("SEARCH_PROVIDER_FAILED", "YouTube didn't return more results."), { status: 502 });
  return {
    items: page.candidates.sort((left, right) => queryRelevance(query, right) - queryRelevance(query, left)),
    more: page.continuation && page.continuation !== more.token ? { token: page.continuation, configuration: more.configuration } : null,
  };
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
  signal.throwIfAborted();
  const { results } = stateFor(fetchImpl);
  const cacheKey = `${mediaKind}|${query.toLowerCase()}`;
  const cached = results.get(cacheKey);
  // A cached answer whose next page has since been dropped is searched again, so scrolling still works.
  const pageKept = (answer) => !answer.more || stateFor(fetchImpl).pages.has(answer.more);
  if (cached && cached.until > Date.now() && pageKept(cached.value)) return structuredClone(cached.value);
  const settled = await Promise.allSettled([
    guardedSearch("spotify", searchSpotify, query, signal, fetchImpl),
    guardedSearch("soundcloud", searchSoundCloud, query, signal, fetchImpl),
    guardedSearch("youtube", searchYouTube, query, signal, fetchImpl),
  ]);
  signal.throwIfAborted();
  const rejectedAbort = settled.find((value) => value.status === "rejected" && value.reason?.name === "AbortError");
  if (rejectedAbort) throw rejectedAbort.reason;
  const spotifyTracks = settled[0].status === "fulfilled" ? settled[0].value : [];
  const soundCloud = settled[1].status === "fulfilled" ? settled[1].value : { items: [], more: null };
  const youtubeFound = settled[2].status === "fulfilled" ? settled[2].value : { items: [], more: null };
  const candidates = buildCandidates(query, mediaKind, spotifyTracks, soundCloud.items.slice(0, MAX_RESULTS_PER_PROVIDER), youtubeFound.items.slice(0, MAX_RESULTS_PER_PROVIDER), youtubeFound.items.slice(0, 12));
  if (!candidates.length) throw searchError("NO_SEARCH_RESULTS", "Spotify, SoundCloud, and YouTube returned no previewable results for that search.");
  const unavailableProviders = SEARCH_PROVIDERS.filter((provider, index) => settled[index].status === "rejected");
  const more = savePage(fetchImpl, {
    query,
    mediaKind,
    soundcloud: { left: soundCloud.items.slice(MAX_RESULTS_PER_PROVIDER), more: soundCloud.more },
    youtube: { left: youtubeFound.items.slice(MAX_RESULTS_PER_PROVIDER), more: youtubeFound.more },
  });
  const answer = searchAnswer(query, mediaKind, candidates, unavailableProviders, more);
  // An answer missing a provider is kept only briefly, so that provider is asked again soon.
  results.delete(cacheKey);
  results.set(cacheKey, { value: answer, until: Date.now() + (unavailableProviders.length ? PARTIAL_CACHE_MS : RESULT_CACHE_MS) });
  while (results.size > RESULT_CACHE_SIZE) results.delete(results.keys().next().value);
  return structuredClone(answer);
}

/*
 * Slopify: more results as the list is scrolled. Each answer names the page
 * after it (an id for a short-lived server record, never changed once made, so a
 * cached answer always continues from the same place): results the providers
 * already sent but weren't shown, then SoundCloud's next offset and YouTube's
 * continuation page.
 */
const PAGE_SIZE = 20;
const MAX_OFFSET = 400;
const PAGE_TTL_MS = 15 * 60_000;
const MAX_PAGES = 200;

function savePage(fetchImpl, page) {
  const hasMore = ["soundcloud", "youtube"].some((p) => page[p].left.length || page[p].more);
  if (!hasMore) return null;
  const { pages } = stateFor(fetchImpl);
  const id = require("node:crypto").randomUUID();
  pages.set(id, { page, until: Date.now() + PAGE_TTL_MS });
  for (const [key, entry] of pages) if (entry.until <= Date.now()) pages.delete(key);
  while (pages.size > MAX_PAGES) pages.delete(pages.keys().next().value);
  return id;
}

async function searchMorePlatforms(id, signal, fetchImpl = fetch) {
  signal.throwIfAborted();
  const entry = typeof id === "string" ? stateFor(fetchImpl).pages.get(id) : null;
  if (!entry || entry.until <= Date.now()) throw searchError("SEARCH_PAGE_EXPIRED", "These results have expired. Search again to see more.");
  const { query, mediaKind } = entry.page;
  const unavailable = [];
  const take = async (provider, size, next) => {
    let { left, more } = entry.page[provider];
    if (left.length < size && more) {
      try {
        const page = await guardedSearch(provider, (q, deadline, f) => next(q, more, deadline, f), query, signal, fetchImpl);
        left = [...left, ...page.items];
        more = page.more;
      } catch (error) {
        if (signal.aborted) throw error;
        unavailable.push(provider);
      }
    }
    return { shown: left.slice(0, size), rest: { left: left.slice(size), more } };
  };
  const [soundcloud, youtube] = await Promise.all([
    take("soundcloud", 10, (q, more, s, f) => soundCloudPage(q, more.clientID, more.offset, s, f)),
    take("youtube", 12, nextYouTubePage),
  ]);
  const candidates = buildCandidates(query, mediaKind, [], soundcloud.shown, youtube.shown, youtube.shown);
  if (!candidates.length) {
    // A failed provider is an error the listener can retry (this page stays valid), not an empty page
    // that scrolling would request again and again. Nothing new and nothing failed is the end.
    if (unavailable.length) throw searchError("SEARCH_MORE_UNAVAILABLE", "Couldn't load more results right now.");
    return structuredClone(searchAnswer(query, mediaKind, [], [], null));
  }
  const more = savePage(fetchImpl, { query, mediaKind, soundcloud: soundcloud.rest, youtube: youtube.rest });
  return structuredClone(searchAnswer(query, mediaKind, candidates, unavailable, more));
}

/** Results from each platform as the app shows them, best match first. `matchFrom` are the YouTube videos other platforms' songs can play from. */
function buildCandidates(query, mediaKind, spotifyTracks, soundCloudTracks, youtubeTracks, matchFrom) {
  const spotify = spotifyTracks.map((track) => resultCandidate("spotify", track, matchedCandidates(track, matchFrom))).filter(Boolean);
  const soundcloud = soundCloudTracks.map((soundCloudTrack) => {
    const track = { ...soundCloudTrack };
    delete track.directlyImportable;
    const direct = mediaKind === "audio" && soundCloudTrack.directlyImportable
      ? directSoundCloudCandidate(soundCloudTrack)
      : null;
    const alternatives = matchedCandidates(track, matchFrom);
    return resultCandidate("soundcloud", track, direct ? [direct, ...alternatives] : alternatives);
  }).filter(Boolean);
  const youtube = youtubeTracks.map((candidate) => {
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
      creatorAvatarURL: candidate.creatorAvatarURL || null,
      embedURL: "",
      sourceURL: `https://www.youtube.com/watch?v=${candidate.videoID}`,
    };
    return resultCandidate("youtube", track, [directYouTubeCandidate(candidate)]);
  });
  // Best match first across all platforms (the app features the top one); official YouTube artist uploads win ties.
  const relevance = new Map([...spotify, ...soundcloud, ...youtube].map((c) => [
    c,
    queryRelevance(query, c.importMetadata || c) + (c.officialArtist && c.searchProvider === "youtube" ? 0.05 : 0),
  ]));
  return [...relevance.keys()].sort((left, right) => relevance.get(right) - relevance.get(left));
}

function searchAnswer(query, mediaKind, candidates, unavailableProviders, more) {
  const count = (provider) => candidates.filter((c) => c.searchProvider === provider).length;
  return {
    kind: "search_results",
    mediaKind,
    query,
    providerCounts: { spotify: count("spotify"), soundcloud: count("soundcloud"), youtube: count("youtube") },
    unavailableProviders,
    more,
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
  searchMorePlatforms,
};
