import { setTimeout as delay } from "node:timers/promises";

/*
 * Public "listeners of this also play that" relationships for discovery, from
 * ListenBrainz (aggregate listening sessions) with MusicBrainz for artist
 * identity. Only artist names and song titles are sent; no listening history,
 * timestamps or ids. Results are cached in memory.
 */

const MBID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const ARTIST_ALGORITHM = "session_based_days_1825_session_300_contribution_3_threshold_10_limit_100_filter_True_skip_30";
const RECORDING_ALGORITHM = "session_based_days_7500_session_300_contribution_sqrt_threshold_15_limit_50_skip_30_top_n_listeners_1000";
const USER_AGENT = process.env.SLOPIFY_METADATA_USER_AGENT || "Slopify/2.0 (https://github.com/DrasticDeveloping/Slopify)";
/** MusicBrainz throttles hard (one request per second at best), so it is only a fallback; ListenBrainz Labs is more generous. */
const SPACING = { "musicbrainz.org": 1500, "labs.api.listenbrainz.org": 350 };
const MAX_BYTES = 1024 * 1024;

const normalize = (s) => s.normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim();
const meaningful = (s) => typeof s === "string" && s.trim() && s.length <= 180 && !["unknown", "unknown artist", "unknown uploader", "local files", "various artists"].includes(normalize(s));
const quote = (s) => `"${s.replace(/[\\"]/g, "\\$&")}"`;
/** The lead artist of a multi-artist credit ("Calvin Harris, Pharrell Williams & Katy Perry" → "Calvin Harris"). */
const leadArtist = (s) => s.split(/\s*(?:,|&|\bfeat\.?|\bft\.?|\bfeaturing\b|\bwith\b|\bx\b)\s*/iu)[0].trim();
/** Featured-artist notes are credits, not part of the title: "Feels (feat. Pharrell Williams)" is "Feels". */
const songTitle = (s) => normalize(s.replace(/\s*[([](?:feat|ft|featuring|with)\b\.?[^)\]]*[)\]]/giu, " "));
const sameArtist = (a, b) => normalize(a) === normalize(b) || (meaningful(leadArtist(a)) && normalize(leadArtist(a)) === normalize(leadArtist(b)));
const badRequest = (message) => Object.assign(new Error(message), { status: 400 });

/** Rejects when `signal` aborts even if `promise` ignores it, running `cancel` to clean up. */
function abortable(promise, signal, cancel = () => {}) {
  return new Promise((resolve, reject) => {
    const aborted = () => { cancel(); reject(signal.reason); };
    signal.addEventListener("abort", aborted, { once: true });
    if (signal.aborted) aborted();
    Promise.resolve(promise).then(resolve, reject).finally(() => signal.removeEventListener("abort", aborted));
  });
}

async function readJSON(response, signal) {
  if (Number(response.headers.get("content-length")) > MAX_BYTES) {
    void response.body?.cancel().catch(() => {});
    throw new Error("Music relationships are too large.");
  }
  if (!response.body) throw new Error("Missing music relationships.");
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await abortable(reader.read(), signal, () => void reader.cancel().catch(() => {}));
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BYTES) throw new Error("Music relationships are too large.");
      chunks.push(Buffer.from(value));
    }
    return JSON.parse(Buffer.concat(chunks, size).toString("utf8"));
  } catch (error) {
    void reader.cancel().catch(() => {});
    throw error;
  } finally {
    reader.releaseLock();
  }
}

/** Ranked, de-duplicated edges with rank-based affinity (1/sqrt(rank)); provider scores are not probabilities. */
function rankEdges(rows, idOf) {
  const seen = new Set();
  return rows
    .sort((a, b) => b.score - a.score || idOf(a).localeCompare(idOf(b)))
    .filter((r) => !seen.has(idOf(r)) && seen.add(idOf(r)))
    .slice(0, 50)
    .map((r, i) => ({ row: r, affinity: 1 / Math.sqrt(i + 1) }));
}

export function createRecommendations({ fetchImpl = fetch, now = Date.now, wait = delay, requestTimeoutMs = 5000, deadlineMs = 25_000 } = {}) {
  const cache = new Map();
  const hosts = new Map();
  const identifying = new Map();

  const cached = (key) => {
    const entry = cache.get(key);
    if (entry && entry.until > now()) return entry.value;
    cache.delete(key);
    return undefined;
  };
  const remember = (key, value, ttl) => {
    cache.delete(key);
    cache.set(key, { value, until: now() + ttl });
    while (cache.size > 256) cache.delete(cache.keys().next().value);
    return value;
  };

  async function fetchJSON(url, signal) {
    signal = AbortSignal.any([signal, AbortSignal.timeout(requestTimeoutMs)]);
    signal.throwIfAborted();
    const host = hosts.get(url.hostname);
    if (host.coolUntil > now()) throw new Error("The metadata service asked us to slow down.");
    const response = await abortable(fetchImpl(url, { headers: { Accept: "application/json", "User-Agent": USER_AGENT }, redirect: "error", signal }), signal);
    if (!response.ok) {
      if (response.status === 429 || response.status === 503) {
        const retry = response.headers.get("retry-after");
        const seconds = Number(retry);
        const date = Date.parse(retry ?? "");
        // Honour Retry-After; without one, back off briefly rather than shutting the service out for a minute.
        const ms = retry && Number.isFinite(seconds) ? seconds * 1000 : Number.isFinite(date) ? date - now() : 10_000;
        host.coolUntil = now() + Math.min(86_400_000, Math.max(5_000, ms));
      }
      void response.body?.cancel().catch(() => {});
      throw new Error(`The metadata service answered HTTP ${response.status}.`);
    }
    return readJSON(response, signal);
  }

  /** One queue per host, spaced to its rate limit. */
  function request(url, signal) {
    if (!hosts.has(url.hostname)) hosts.set(url.hostname, { queue: Promise.resolve(), pending: 0, last: -Infinity, coolUntil: 0 });
    const host = hosts.get(url.hostname);
    if (host.pending >= 12) throw new Error("The metadata queue is busy.");
    host.pending++;
    const task = host.queue.then(async () => {
      signal.throwIfAborted();
      const remaining = (SPACING[url.hostname] ?? 1000) - (now() - host.last);
      if (remaining > 0) await wait(remaining, undefined, { signal });
      signal.throwIfAborted();
      host.last = now();
      return fetchJSON(url, signal);
    });
    host.queue = task.then(() => undefined, () => undefined);
    void task.finally(() => host.pending--).catch(() => {});
    return abortable(task, signal);
  }

  function musicbrainz(entity, query, signal) {
    const url = new URL(`https://musicbrainz.org/ws/2/${entity}/`);
    url.searchParams.set("query", query);
    url.searchParams.set("fmt", "json");
    url.searchParams.set("limit", "10");
    return request(url, signal);
  }

  function labs(path, params, signal) {
    const url = new URL(`https://labs.api.listenbrainz.org/${path}`);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    return request(url, signal);
  }

  /**
   * A song's identity (its recording and credited artists) from artist + title, through ListenBrainz alone:
   * the exact artist-credit lookup first; then the fuzzy search, where the lead artist may stand in for a
   * multi-artist credit and "(feat. …)" is ignored, followed by that recording's own credits.
   */
  function identify(seed, signal) {
    const key = `identity:${JSON.stringify([normalize(seed.name), normalize(seed.title)])}`;
    const hit = cached(key);
    if (hit !== undefined) return Promise.resolve(hit);
    // A song asked about as both a song and an artist seed is looked up once.
    if (!identifying.has(key)) identifying.set(key, lookUp(seed, key, signal).finally(() => identifying.delete(key)));
    return identifying.get(key);
  }

  async function lookUp(seed, key, signal) {
    const mbids = (list) => (Array.isArray(list) ? list.filter((m) => MBID.test(m)) : []);
    let found = null;
    const lookup = await labs("acr-lookup/json", { artist_credit_name: seed.name, recording_name: seed.title }, signal);
    const row = Array.isArray(lookup) ? lookup.find((r) => MBID.test(r?.recording_mbid) && typeof r.artist_credit_name === "string" && sameArtist(r.artist_credit_name, seed.name)) : undefined;
    if (row) found = { recording: row.recording_mbid, artists: mbids(row.artist_mbids) };
    if (!found) {
      const data = await labs("recording-search/json", { query: `${leadArtist(seed.name)} ${seed.title}` }, signal);
      if (!Array.isArray(data)) throw new Error("Invalid recording metadata.");
      // Popular songs exist as several identical recordings (album, single, compilations); the search ranks
      // the original first. Live and remix versions differ in title, so they never match here.
      const exact = data.find((r) => MBID.test(r?.recording_mbid) && meaningful(r?.artist_credit_name) && typeof r.recording_name === "string" && sameArtist(r.artist_credit_name, seed.name) && songTitle(r.recording_name) === songTitle(seed.title));
      if (exact) {
        const detail = await labs("recording-mbid-lookup/json", { recording_mbid: exact.recording_mbid }, signal);
        found = { recording: exact.recording_mbid, artists: mbids(Array.isArray(detail) ? detail[0]?.artist_credit_mbids : undefined) };
      }
    }
    return remember(key, found, found ? 7 * 86_400_000 : 5 * 60_000);
  }

  /** The MusicBrainz artist for a name, when no song identifies it; an exact-name collision is settled by a song title, else abstains. */
  async function resolveArtist(seed, signal) {
    const key = `artist:${JSON.stringify([normalize(seed.name), normalize(seed.title ?? "")])}`;
    const hit = cached(key);
    if (hit !== undefined) return hit;
    const data = await musicbrainz("artist", `artist:${quote(seed.name)}`, signal);
    if (!Array.isArray(data?.artists)) throw new Error("Invalid artist metadata.");
    const names = (a) => [a.name, ...(Array.isArray(a.aliases) ? a.aliases.map((v) => v?.name).filter((v) => typeof v === "string") : [])];
    const exact = data.artists.filter((a) => MBID.test(a?.id) && meaningful(a?.name) && names(a).some((n) => normalize(n) === normalize(seed.name)));
    // A multi-artist credit with no exact match is looked up by its lead artist.
    if (!exact.length && leadArtist(seed.name) !== seed.name && meaningful(leadArtist(seed.name))) {
      const lead = await resolveArtist({ name: leadArtist(seed.name), title: seed.title }, signal);
      return remember(key, lead, lead ? 7 * 86_400_000 : 5 * 60_000);
    }
    let artist = exact.length === 1 ? exact[0] : undefined;
    if (exact.length > 1 && seed.title) {
      const found = await musicbrainz("recording", `artist:${quote(seed.name)} AND recording:${quote(seed.title)}`, signal);
      if (!Array.isArray(found?.recordings)) throw new Error("Invalid recording metadata.");
      const possible = new Set(exact.map((a) => a.id));
      const credited = new Set();
      for (const r of found.recordings) {
        if (typeof r?.title !== "string" || normalize(r.title) !== normalize(seed.title) || !Array.isArray(r["artist-credit"])) continue;
        for (const c of r["artist-credit"]) if (possible.has(c?.artist?.id)) credited.add(c.artist.id);
      }
      if (credited.size === 1) artist = exact.find((a) => credited.has(a.id));
    }
    return artist ? remember(key, { mbid: artist.id, name: artist.name }, 7 * 86_400_000) : remember(key, null, 5 * 60_000);
  }

  async function similarArtists(seed, signal) {
    // The artist's own song identifies it without MusicBrainz; the lead credited artist is the one asked about.
    const lead = seed.title ? (await identify({ name: seed.name, title: seed.title }, signal))?.artists[0] : undefined;
    const resolved = lead ? { mbid: lead } : await resolveArtist(seed, signal);
    if (!resolved) return { seed: seed.name, status: "unresolved", artists: [] };
    const key = `artists:${resolved.mbid}`;
    let rows = cached(key);
    if (rows === undefined) {
      const data = await labs("similar-artists/json", { artist_mbids: resolved.mbid, algorithm: ARTIST_ALGORITHM }, signal);
      if (!Array.isArray(data)) throw new Error("Invalid artist relationships.");
      const valid = data.filter((r) => r?.reference_mbid === resolved.mbid && MBID.test(r.artist_mbid) && r.artist_mbid !== resolved.mbid && meaningful(r.name) && Number.isFinite(r.score) && r.score > 0);
      rows = rankEdges(valid, (r) => r.artist_mbid).map(({ row, affinity }) => ({ name: row.name, affinity }));
      remember(key, rows, rows.length ? 86_400_000 : 5 * 60_000);
    }
    return { seed: seed.name, status: rows.length ? "available" : "unresolved", artists: rows };
  }

  /** Song-level relationships for a song identified exactly (see identify). */
  async function similarSongs(seed, signal) {
    const identity = await identify(seed, signal);
    const resolved = identity ? { mbid: identity.recording } : null;
    const seedOut = { name: seed.name, title: seed.title };
    if (!resolved) return { seed: seedOut, status: "unresolved", songs: [] };
    const key = `songs:${resolved.mbid}`;
    let rows = cached(key);
    if (rows === undefined) {
      const data = await labs("similar-recordings/json", { recording_mbids: resolved.mbid, algorithm: RECORDING_ALGORITHM }, signal);
      if (!Array.isArray(data)) throw new Error("Invalid recording relationships.");
      const valid = data.filter((r) => r?.reference_mbid === resolved.mbid && MBID.test(r.recording_mbid) && r.recording_mbid !== resolved.mbid && meaningful(r.artist_credit_name) && meaningful(r.recording_name) && Number.isFinite(r.score) && r.score > 0);
      rows = rankEdges(valid, (r) => r.recording_mbid).map(({ row, affinity }) => ({ artist: row.artist_credit_name, title: row.recording_name, affinity }));
      remember(key, rows, rows.length ? 86_400_000 : 5 * 60_000);
    }
    return { seed: seedOut, status: rows.length ? "available" : "unresolved", songs: rows };
  }

  function seedList(value, needsTitle) {
    if (value === undefined) return [];
    const ok = Array.isArray(value) && value.length <= 5 && value.every((s) => meaningful(s?.name) && (needsTitle ? typeof s.title === "string" && s.title.trim() : s.title === undefined || typeof s.title === "string") && (s.title ?? "").length <= 250);
    if (!ok) throw badRequest("Send up to five seeds, each an artist name (and song title for songs).");
    return value.map((s) => ({ name: s.name.trim(), title: typeof s.title === "string" ? s.title.trim() : undefined }));
  }

  /**
   * Related songs for up to five song seeds and related artists for up to five
   * artist seeds, in one call. A seed that fails comes back "unavailable" while
   * the others still answer.
   */
  async function related(body, parentSignal = new AbortController().signal) {
    const songs = seedList(body?.songs, true);
    const artists = seedList(body?.artists, false);
    if (!songs.length && !artists.length) throw badRequest("Send at least one song or artist seed.");
    parentSignal.throwIfAborted();
    const signal = AbortSignal.any([parentSignal, AbortSignal.timeout(deadlineMs)]);
    const settle = (list, run, failed) => Promise.allSettled(list.map((s) => run(s, signal))).then((all) => all.map((r, i) => (r.status === "fulfilled" ? r.value : failed(list[i]))));
    const [songResults, artistResults] = await Promise.all([
      settle(songs, similarSongs, (s) => ({ seed: { name: s.name, title: s.title }, status: "unavailable", songs: [] })),
      settle(artists, similarArtists, (s) => ({ seed: s.name, status: "unavailable", artists: [] })),
    ]);
    parentSignal.throwIfAborted();
    return { source: "listenbrainz", songs: songResults, artists: artistResults };
  }

  return { related };
}
