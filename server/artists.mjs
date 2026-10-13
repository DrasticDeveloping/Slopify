import { setTimeout as delay } from "node:timers/promises";

/*
 * Public artist profiles for the artist page and artist search: TheAudioDB for
 * pictures, popular tracks and albums; MusicBrainz for identity and releases;
 * Wikipedia for a biography when neither has one. Only artist names and
 * MusicBrainz ids are sent. Results are cached in memory.
 */

const MBID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const USER_AGENT = process.env.SLOPIFY_METADATA_USER_AGENT || "Slopify/2.0 (https://github.com/DrasticDeveloping/Slopify)";
/** Minimum gap between requests to one host. TheAudioDB's free key allows about 30 a minute; MusicBrainz one a second. */
const SPACING = { "www.theaudiodb.com": 2100, "musicbrainz.org": 1500 };
const DEFAULT_SPACING = 1500;
const MAX_BYTES = 2_000_000;
const DAY = 86_400_000;
const CACHE_SIZE = 100;
const NOT_ARTISTS = new Set(["unknownartist", "localfiles", "variousartists"]);

/** Names compared without channel suffixes, case, spacing or punctuation: "Dua Lipa - Topic" is "dualipa". */
const normalize = (s) => String(s ?? "").normalize("NFKC").toLowerCase().replace(/\s+-\s+topic$|vevo$/giu, "").replace(/[^\p{L}\p{N}]/gu, "");
const text = (v, max = 6000) => (typeof v === "string" ? v.trim().slice(0, max) : "");
const httpsUrl = (v) => {
  try {
    const url = new URL(v);
    return url.protocol === "https:" ? url.href : undefined;
  } catch {
    return undefined;
  }
};
const quote = (s) => `"${s.replace(/[\\"]/g, "\\$&")}"`;
const coverArt = (releaseGroupId) => (MBID.test(releaseGroupId ?? "") ? `https://coverartarchive.org/release-group/${releaseGroupId}/front-250` : undefined);
const badRequest = (message) => Object.assign(new Error(message), { status: 400 });
/** Splits a credit like "Calvin Harris & Dua Lipa" into its artists. */
const creditedArtists = (name) => name.split(/\s*(?:&|,|\bfeat\.?\s|\bft\.?\s|\band\b)\s*/iu).filter(Boolean);

/**
 * TheAudioDB puts a solo artist's birth year in its formed-year field and gives
 * bands a gender too, so the member count decides; gender only when it's missing.
 */
function formedYear(row) {
  const members = text(row.intMembers, 5);
  const gender = text(row.strGender, 20);
  const solo = members ? members === "1" : /^(male|female)$/i.test(gender);
  const group = members ? members !== "1" : /^group$/i.test(gender);
  if (solo) return { formed: text(row.intBornYear, 20), formedLabel: "Born" };
  return { formed: text(row.intFormedYear, 20), formedLabel: group ? "Formed" : "Active since" };
}

async function readJSON(response) {
  if (Number(response.headers.get("content-length")) > MAX_BYTES) {
    void response.body?.cancel().catch(() => {});
    throw new Error("Artist metadata is too large.");
  }
  if (!response.body) throw new Error("Missing artist metadata.");
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BYTES) throw new Error("Artist metadata is too large.");
      chunks.push(Buffer.from(value));
    }
    return JSON.parse(Buffer.concat(chunks, size).toString("utf8"));
  } finally {
    void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

/** A bounded in-memory cache whose entries each carry their own lifetime. */
function expiringCache(now) {
  const entries = new Map();
  return {
    get(key) {
      const hit = entries.get(key);
      return hit && hit.until > now() ? hit.value : undefined;
    },
    set(key, value, ttl) {
      entries.delete(key);
      entries.set(key, { value, until: now() + ttl });
      while (entries.size > CACHE_SIZE) entries.delete(entries.keys().next().value);
    },
  };
}

function emptyProfile(name) {
  return { name, biography: "", genres: [], country: "", formed: "", formedLabel: "Active since", image: undefined, banner: undefined, sourceUrl: "", biographyUrl: undefined, tracks: [], releases: [], partial: false };
}

/** Adds a Wikipedia biography (and picture, if the profile has none) to `profile`. */
function addBiography(profile, extra) {
  profile.biography = extra.biography ?? "";
  profile.biographyUrl = extra.biographyUrl;
  profile.image ??= extra.image;
  profile.partial ||= extra.partial;
}

/** Public artist metadata. Exact identities only; collaboration credits are profiled per artist. */
export function createArtists({ fetchImpl = fetch, now = Date.now, wait = delay } = {}) {
  const profiles = expiringCache(now);
  const searches = expiringCache(now);
  const pending = new Map();
  const hosts = new Map();

  /** One request at a time per host, spaced out, and none while that host is rate limiting us. */
  function request(url, signal) {
    let host = hosts.get(url.hostname);
    if (!host) hosts.set(url.hostname, (host = { queue: Promise.resolve(), last: 0, blockedUntil: 0 }));
    const task = host.queue.then(async () => {
      signal.throwIfAborted();
      if (host.blockedUntil > now()) throw new Error("Metadata provider is temporarily rate limited.");
      await wait(Math.max(0, (SPACING[url.hostname] ?? DEFAULT_SPACING) - (now() - host.last)), undefined, { signal });
      host.last = now();
      const response = await fetchImpl(url, { signal: AbortSignal.any([signal, AbortSignal.timeout(8000)]), headers: { Accept: "application/json", "User-Agent": USER_AGENT } });
      if (response.status === 429 || response.status === 503) host.blockedUntil = now() + 60_000;
      if (!response.ok) {
        void response.body?.cancel().catch(() => {});
        throw new Error(`Metadata HTTP ${response.status}`);
      }
      return readJSON(response);
    });
    host.queue = task.catch(() => {});
    return task;
  }

  const audioDb = (path, params, signal) => {
    const url = new URL(`https://www.theaudiodb.com/api/v1/json/123/${path}.php`);
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
    return request(url, signal);
  };
  const musicBrainz = (path, params, signal) => {
    const url = new URL(`https://musicbrainz.org/ws/2/${path}`);
    for (const [key, value] of Object.entries({ ...params, fmt: "json" })) url.searchParams.set(key, value);
    return request(url, signal);
  };
  const wikipediaSummary = (title, signal) => request(new URL(`https://en.wikipedia.org/api/rest_v1/page/summary/${title}`), signal);

  /** The Wikipedia summary for a musician of exactly this name, if there is one. */
  async function findBiography(name, signal) {
    let partial = false;
    for (const title of [`${name} (musician)`, name]) {
      try {
        const page = await wikipediaSummary(encodeURIComponent(title), signal);
        const sameName = normalize(page.title?.replace(/\s*\([^)]*\)$/, "")) === normalize(name);
        const aboutMusic = /musician|producer|band|singer|songwriter|disc jockey|duo|DJ\b/i.test(`${page.description} ${page.extract}`);
        if (page.type === "disambiguation" || !sameName || !aboutMusic) continue;
        return { biography: text(page.extract), image: httpsUrl(page.thumbnail?.source), biographyUrl: `https://en.wikipedia.org/wiki/${encodeURIComponent(page.title)}`, partial };
      } catch (error) {
        // A missing page is an answer; anything else means the biography may exist but couldn't be read.
        if (!String(error?.message).includes("404")) partial = true;
      }
    }
    return { partial };
  }

  const releaseGroups = (data, artist, covers = new Map()) =>
    (data["release-groups"] ?? []).map((group) => ({
      id: `mb-${group.id}`,
      title: text(group.title, 250),
      artist,
      year: group["first-release-date"]?.slice(0, 4) ?? "",
      type: group["primary-type"] ?? "Release",
      artwork: covers.get(normalize(group.title)) || coverArt(group.id),
      sourceUrl: `https://musicbrainz.org/release-group/${group.id}`,
    }));

  /** A profile built from a TheAudioDB artist, with MusicBrainz's fuller discography when it is linked. */
  async function fromAudioDb(row, signal) {
    const profile = {
      ...emptyProfile(text(row.strArtist, 180)),
      ...formedYear(row),
      biography: text(row.strBiographyEN),
      genres: [text(row.strGenre, 100), text(row.strStyle, 100)].filter(Boolean),
      country: text(row.strCountry, 100),
      image: httpsUrl(row.strArtistThumb),
      banner: httpsUrl(row.strArtistFanart),
      sourceUrl: `https://www.theaudiodb.com/artist/${encodeURIComponent(row.idArtist)}`,
    };
    const byArtist = (credit) => normalize(credit) === normalize(profile.name);
    const [top, albums] = await Promise.allSettled([audioDb("track-top10", { s: profile.name }, signal), audioDb("album", { i: row.idArtist }, signal)]);
    profile.partial = top.status === "rejected" || albums.status === "rejected";
    if (top.status === "fulfilled") {
      profile.tracks = (top.value.track ?? [])
        .filter((t) => byArtist(t.strArtist) && text(t.strTrack))
        .slice(0, 10)
        .map((t) => ({ title: text(t.strTrack, 250), artist: profile.name, album: text(t.strAlbum, 250), artwork: httpsUrl(t.strTrackThumb), sourceUrl: `https://www.theaudiodb.com/track/${encodeURIComponent(t.idTrack)}` }));
    }
    if (albums.status === "fulfilled") {
      profile.releases = (albums.value.album ?? [])
        .filter((a) => byArtist(a.strArtist) && text(a.strAlbum))
        .slice(0, 60)
        .map((a) => ({ id: `audiodb-${a.idAlbum}`, title: text(a.strAlbum, 250), artist: profile.name, year: text(a.intYearReleased, 20), type: text(a.strReleaseFormat, 50), artwork: httpsUrl(a.strAlbumThumb), sourceUrl: `https://www.theaudiodb.com/album/${encodeURIComponent(a.idAlbum)}` }));
    }
    if (MBID.test(row.strMusicBrainzID ?? "")) {
      try {
        // TheAudioDB's album art is kept for the releases both sources know.
        const covers = new Map(profile.releases.map((r) => [normalize(r.title), r.artwork]));
        const groups = releaseGroups(await musicBrainz("release-group", { artist: row.strMusicBrainzID, limit: "50" }, signal), profile.name, covers);
        if (groups.length) profile.releases = groups;
      } catch {
        profile.partial = true;
      }
    }
    if (!profile.biography) addBiography(profile, await findBiography(profile.name, signal));
    return profile;
  }

  /** A profile built from MusicBrainz alone, with its linked Wikipedia article as the biography. */
  async function fromMusicBrainz(artist, signal) {
    const profile = {
      ...emptyProfile(artist.name),
      country: artist.area?.name ?? artist.country ?? "",
      formed: artist["life-span"]?.begin ?? "",
      formedLabel: artist.type === "Person" ? "Born" : "Formed",
      genres: (artist.tags ?? []).slice(0, 4).map((t) => t.name),
      sourceUrl: `https://musicbrainz.org/artist/${artist.id}`,
    };
    const [detail, releases] = await Promise.allSettled([
      musicBrainz(`artist/${artist.id}`, { inc: "url-rels" }, signal),
      musicBrainz("release-group", { artist: artist.id, limit: "50" }, signal),
    ]);
    profile.partial = detail.status === "rejected" || releases.status === "rejected";
    if (releases.status === "fulfilled") profile.releases = releaseGroups(releases.value, artist.name);
    const wiki = detail.status === "fulfilled"
      ? (detail.value.relations ?? []).find((r) => r.type === "wikipedia" && r.url?.resource?.startsWith("https://en.wikipedia.org/wiki/"))
      : undefined;
    if (!wiki) {
      addBiography(profile, await findBiography(profile.name, signal));
      return profile;
    }
    try {
      const page = await wikipediaSummary(new URL(wiki.url.resource).pathname.slice("/wiki/".length), signal);
      profile.biography = text(page.extract);
      profile.image = httpsUrl(page.thumbnail?.source);
      profile.biographyUrl = wiki.url.resource;
    } catch {
      profile.partial = true;
    }
    return profile;
  }

  /** The one artist with exactly this name (or MusicBrainz id), or null when there is none or it's ambiguous. */
  async function lookup(name, signal, musicBrainzId) {
    const clean = name.replace(/\s+-\s+Topic$|VEVO$/giu, "").trim();
    const matches = (a) => (!musicBrainzId || a.strMusicBrainzID?.toLowerCase() === musicBrainzId) && [a.strArtist, a.strArtistAlternate].some((n) => normalize(n) === normalize(clean));
    let row;
    try {
      row = (await audioDb("search", { s: clean }, signal)).artists?.find(matches);
    } catch {
      // MusicBrainz below.
    }
    if (row) return fromAudioDb(row, signal);
    try {
      const candidates = musicBrainzId
        ? [await musicBrainz(`artist/${musicBrainzId}`, {}, signal)]
        : ((await musicBrainz("artist/", { query: `artist:${quote(clean)}`, limit: "10" }, signal)).artists ?? []);
      const exact = candidates.filter((a) => (musicBrainzId ? a.id === musicBrainzId : normalize(a.name) === normalize(clean)));
      return exact.length === 1 ? await fromMusicBrainz(exact[0], signal) : null;
    } catch {
      return null;
    }
  }

  async function findProfiles(name, musicBrainzId) {
    const signal = AbortSignal.timeout(45_000);
    const exact = await lookup(name, signal, musicBrainzId);
    if (exact) return [exact];
    // "A & B" with no profile of its own: profile each credited artist, one at a time to stay polite.
    const parts = musicBrainzId ? [] : creditedArtists(name).slice(0, 3);
    if (parts.length < 2) return [];
    const found = [];
    for (const part of parts) {
      const profile = await lookup(part, signal);
      if (profile) found.push(profile);
    }
    return found;
  }

  async function profile(body) {
    const name = text(body?.name, 181);
    if (!name || name.length > 180 || NOT_ARTISTS.has(normalize(name))) throw badRequest("Send a real artist name.");
    const musicBrainzId = typeof body?.musicBrainzId === "string" ? body.musicBrainzId.toLowerCase() : undefined;
    if (musicBrainzId && !MBID.test(musicBrainzId)) throw badRequest("Invalid artist identity.");
    const key = `${normalize(name)}:${musicBrainzId ?? ""}`;
    const hit = profiles.get(key);
    if (hit) return hit;
    if (pending.has(key)) return pending.get(key);
    const task = findProfiles(name, musicBrainzId)
      .then((found) => {
        const status = !found.length ? "unavailable" : found.some((p) => p.partial) ? "partial" : "available";
        const value = { status, collaboration: found.length > 0 && normalize(found[0].name) !== normalize(name), profiles: found };
        // Incomplete answers are retried soon; complete ones are kept for a day.
        profiles.set(key, value, status === "available" ? DAY : 60_000);
        return value;
      })
      .finally(() => pending.delete(key));
    pending.set(key, task);
    return task;
  }

  /** Artists matching a search, MusicBrainz first (with TheAudioDB pictures), then TheAudioDB-only artists. */
  async function search(body, signal = AbortSignal.timeout(20_000)) {
    const query = text(body?.query, 181);
    if (!query || query.length > 180) throw badRequest("Enter an artist name (up to 180 characters).");
    const key = normalize(query);
    const hit = searches.get(key);
    if (hit) return hit;
    const [mb, adb] = await Promise.allSettled([musicBrainz("artist/", { query: `artist:${quote(query)}`, limit: "8" }, signal), audioDb("search", { s: query }, signal)]);
    signal.throwIfAborted();
    if (mb.status === "rejected" && adb.status === "rejected") throw Object.assign(new Error("Artist search is temporarily unavailable. Try again."), { status: 503 });
    const rows = adb.status === "fulfilled" ? adb.value.artists ?? [] : [];
    const results = [];
    for (const a of mb.status === "fulfilled" ? mb.value.artists ?? [] : []) {
      if (!text(a.name) || !MBID.test(a.id ?? "") || Number(a.score) < 50) continue;
      const row = rows.find((r) => r.strMusicBrainzID?.toLowerCase() === a.id.toLowerCase());
      results.push({
        id: `mb-${a.id}`,
        musicBrainzId: a.id,
        name: text(a.name, 180),
        image: httpsUrl(row?.strArtistThumb),
        description: [text(a.disambiguation, 250), text(a.type, 40), text(a.area?.name || a.country, 100)].filter(Boolean).join(" · "),
        sourceUrl: `https://musicbrainz.org/artist/${a.id}`,
      });
    }
    for (const row of rows) {
      const musicBrainzId = text(row.strMusicBrainzID, 36).toLowerCase();
      const identified = MBID.test(musicBrainzId);
      const listed = results.some((a) => (identified ? a.musicBrainzId === musicBrainzId : normalize(a.name) === normalize(row.strArtist)));
      if (!text(row.strArtist) || listed) continue;
      results.push({
        id: `audiodb-${text(row.idArtist, 30)}`,
        ...(identified ? { musicBrainzId } : {}),
        name: text(row.strArtist, 180),
        image: httpsUrl(row.strArtistThumb),
        description: [text(row.strGenre, 100), text(row.strCountry, 100)].filter(Boolean).join(" · "),
        sourceUrl: `https://www.theaudiodb.com/artist/${encodeURIComponent(row.idArtist)}`,
      });
    }
    // An exact name match goes first; otherwise MusicBrainz's relevance order stands.
    const exact = (a) => Number(normalize(a.name) === key);
    results.sort((a, b) => exact(b) - exact(a));
    const value = { artists: results.slice(0, 8), partial: mb.status === "rejected" || adb.status === "rejected" };
    searches.set(key, value, value.partial ? 60_000 : 600_000);
    return value;
  }

  return { profile, search };
}
