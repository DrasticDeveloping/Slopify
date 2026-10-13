import { setTimeout as delay } from "node:timers/promises";

/*
 * The music catalog, from Deezer's public API (no account or key): what an
 * artist has released and when, album tracklists, and which album a song comes
 * from. It powers Release Radar, Albums for you and real release years. Only
 * artist names and song titles are sent. Answers are cached in memory.
 *
 * Deezer allows about 50 requests in 5 seconds, so requests go one at a time,
 * spaced out, and stop for a minute if it says we've sent too many.
 */

const API = "https://api.deezer.com";
const SPACING = 150;
const MAX_BYTES = 3_000_000;
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const MAX_ARTISTS = 24;
const MAX_SONGS = 40;

/** Names compared without case, accents, punctuation or channel suffixes: "Dua Lipa - Topic" is "dualipa". */
const normalize = (s) => String(s ?? "").normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase()
  .replace(/\s+-\s+topic$|vevo$/gu, "").replace(/[^\p{L}\p{N}]/gu, "");
/** A title without bracketed extras ("(Remastered 2011)", "[Official Video]") or a featured credit. */
const coreTitle = (s) => normalize(String(s ?? "").replace(/[([{].*?[)\]}]/g, " ").replace(/\s(feat|ft|featuring|with)\.?\s.*$/i, " ").replace(/\s+-\s+.*(remaster|version|edit|mix|live).*$/i, " "));
const text = (v, max = 300) => (typeof v === "string" ? v.trim().slice(0, max) : "");
const date = (v) => (/^\d{4}-\d{2}-\d{2}$/.test(v ?? "") && !v.startsWith("0000") ? v : null);
const badRequest = (message) => Object.assign(new Error(message), { status: 400 });

function cache(size) {
  const entries = new Map();
  return {
    get(key) {
      const hit = entries.get(key);
      return hit && hit.until > Date.now() ? hit.value : undefined;
    },
    set(key, value, ttl) {
      entries.delete(key);
      entries.set(key, { value, until: Date.now() + ttl });
      while (entries.size > size) entries.delete(entries.keys().next().value);
      return value;
    },
  };
}

const release = (a, artist) => ({
  id: `dz${a.id}`,
  title: text(a.title),
  artist: text(a.artist?.name) || artist,
  released: date(a.release_date),
  /** album, single, ep or compile. */
  type: text(a.record_type, 20) || "album",
  artwork: a.cover_xl || a.cover_big || a.cover_medium || undefined,
  fans: Number(a.fans) || 0,
  sourceUrl: `https://www.deezer.com/album/${a.id}`,
});

export function createCatalog({ fetchImpl = fetch } = {}) {
  const artists = cache(400);
  const releases = cache(400);
  const related = cache(200);
  const albums = cache(200);
  const songs = cache(2000);
  const pending = new Map();
  let queue = Promise.resolve();
  let last = 0;
  let blockedUntil = 0;

  /** One Deezer request, in turn. Deezer reports errors (including "too many requests") inside a 200 answer. */
  function get(path, signal) {
    const task = queue.then(async () => {
      signal.throwIfAborted();
      if (blockedUntil > Date.now()) throw new Error("The music catalog is busy. Try again in a minute.");
      await delay(Math.max(0, SPACING - (Date.now() - last)), undefined, { signal });
      last = Date.now();
      const response = await fetchImpl(new URL(path, API), { signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]), headers: { Accept: "application/json" }, redirect: "error" });
      if (!response.ok) {
        void response.body?.cancel().catch(() => {});
        if (response.status === 429) blockedUntil = Date.now() + 60_000;
        throw new Error(`The music catalog answered HTTP ${response.status}.`);
      }
      const body = await readJSON(response);
      if (body?.error) {
        if (body.error.code === 4) blockedUntil = Date.now() + 60_000;
        // "No data" (800) is an empty answer, not a failure.
        if (body.error.code === 800) return { data: [] };
        throw new Error(`The music catalog said: ${text(body.error.message) || "error"}.`);
      }
      return body;
    });
    queue = task.catch(() => {});
    return task;
  }

  /**
   * Runs `load` once per key at a time, and caches its answer. The shared lookup
   * has its own deadline, so one caller giving up doesn't fail the others; each
   * caller still stops waiting as soon as its own signal aborts.
   */
  function once(store, key, ttl, load, signal) {
    signal.throwIfAborted();
    const hit = store.get(key);
    if (hit !== undefined) return Promise.resolve(hit);
    if (!pending.has(store)) pending.set(store, new Map());
    let task = pending.get(store).get(key);
    if (!task) {
      task = load(AbortSignal.timeout(60_000))
        .then((value) => store.set(key, value, typeof ttl === "function" ? ttl(value) : ttl))
        .finally(() => pending.get(store).delete(key));
      pending.get(store).set(key, task);
    }
    return new Promise((resolve, reject) => {
      const stop = () => reject(signal.reason);
      signal.addEventListener("abort", stop, { once: true });
      task.then(resolve, reject).finally(() => signal.removeEventListener("abort", stop));
    });
  }

  /** The Deezer artist with exactly this name (the most followed, if several), or null. */
  const findArtist = (name, signal) => once(artists, normalize(name), (v) => (v ? 7 * DAY : DAY), async (signal) => {
    const { data = [] } = await get(`/search/artist?q=${encodeURIComponent(name)}&limit=10`, signal);
    const exact = data.filter((a) => normalize(a.name) === normalize(name)).sort((a, b) => (b.nb_fan || 0) - (a.nb_fan || 0));
    const a = exact[0];
    return a ? { id: a.id, name: text(a.name), picture: a.picture_xl || a.picture_big || a.picture_medium || undefined, fans: a.nb_fan || 0 } : null;
  }, signal);

  /** An artist's releases, newest first. */
  const releasesOf = (artist, signal) => once(releases, artist.id, 12 * HOUR, async (signal) => {
    const { data = [] } = await get(`/artist/${artist.id}/albums?limit=100`, signal);
    return data.map((a) => release(a, artist.name)).filter((r) => r.title && r.released)
      .sort((a, b) => b.released.localeCompare(a.released));
  }, signal);

  const relatedTo = (artist, signal) => once(related, artist.id, DAY, async (signal) => {
    const { data = [] } = await get(`/artist/${artist.id}/related?limit=8`, signal);
    return data.map((a) => text(a.name)).filter(Boolean);
  }, signal);

  /**
   * Releases by these artists (Release Radar, Albums for you), and the names of
   * artists like them. Artists the catalog doesn't know are skipped.
   */
  async function artistReleases(body, signal) {
    const names = [...new Set((Array.isArray(body?.artists) ? body.artists : []).map((n) => text(n, 200)).filter(Boolean))].slice(0, MAX_ARTISTS);
    if (!names.length) throw badRequest("Send artist names.");
    const wantRelated = Math.min(Number(body?.related) || 0, 8);
    const out = [];
    let unavailable = false;
    for (const name of names) {
      try {
        const artist = await findArtist(name, signal);
        if (!artist) continue;
        const entry = { name: artist.name, picture: artist.picture, releases: await releasesOf(artist, signal), related: [] };
        if (out.length < wantRelated) entry.related = await relatedTo(artist, signal).catch(() => []);
        out.push(entry);
      } catch (error) {
        if (signal.aborted) throw error;
        unavailable = true;
      }
    }
    return { artists: out, partial: unavailable };
  }

  /** Pictures for these artists (Fans also like), by name; null where the catalog doesn't know one. */
  async function artistPictures(body, signal) {
    const names = [...new Set((Array.isArray(body?.artists) ? body.artists : []).map((n) => text(n, 200)).filter(Boolean))].slice(0, 12);
    const pictures = {};
    /** Names that couldn't be looked up (the catalog failed), as opposed to ones it doesn't know. */
    const failed = [];
    for (const name of names) {
      try {
        let found = await findArtist(name, signal);
        // A collaboration ("Vicetone, Cozi Zuehlsdorff") shows its first artist.
        const first = name.split(/\s*(?:,|&|\bx\b|\band\b|\bwith\b|\bfeat\.?|\bft\.?)\s*/iu)[0];
        if (!found && first && first !== name) found = await findArtist(first, signal);
        pictures[name] = found?.picture ?? null;
      } catch (error) {
        if (signal.aborted) throw error;
        pictures[name] = null;
        failed.push(name);
      }
    }
    return { pictures, failed };
  }

  /** A release's details and tracklist. */
  const album = (id, signal) => once(albums, id, DAY, async (signal) => {
    const a = await get(`/album/${id}`, signal);
    return {
      ...release(a, text(a.artist?.name)),
      label: text(a.label, 200),
      tracks: (a.tracks?.data ?? []).map((t, i) => ({
        n: i + 1,
        title: text(t.title),
        artist: text(t.artist?.name) || text(a.artist?.name),
        durationSeconds: Number(t.duration) || null,
      })).filter((t) => t.title),
    };
  }, signal);

  /**
   * Which release a song first came out on, and when: of the catalog's songs with
   * this artist and title, the earliest release (a compilation only if nothing
   * else has it). Uploads often name the artist in the title ("Britney Spears -
   * Gimme More (Official HD Video)"), so that is dropped first.
   */
  const songRelease = (artist, rawTitle, signal) => {
    const prefixed = String(rawTitle ?? "").match(/^(.+?)\s+[-–—]\s+(.+)$/u);
    const title = prefixed && normalize(prefixed[1]) === normalize(artist) ? prefixed[2] : rawTitle;
    return songReleaseOf(artist, title, signal);
  };
  const songReleaseOf = (artist, title, signal) => once(songs, `${normalize(artist)}|${coreTitle(title)}`, (v) => (v ? 30 * DAY : 3 * DAY), async (signal) => {
    const plain = String(title).replace(/[([{].*?[)\]}]/g, " ").replace(/\s+/g, " ").trim();
    const { data = [] } = await get(`/search/track?q=${encodeURIComponent(`${artist} ${plain}`)}&limit=25`, signal);
    const wanted = coreTitle(title);
    // The catalog's artist must be the song's artist, or one of its credited artists ("A & B", "A feat. B").
    const credits = new Set([artist, ...artist.split(/\s*(?:&|,|\bx\b|\band\b|\bwith\b|\bfeat\.?|\bft\.?)\s*/iu)].map(normalize).filter(Boolean));
    const matches = data.filter((t) => coreTitle(t.title) === wanted && credits.has(normalize(t.artist?.name)));
    const ids = [...new Set(matches.map((t) => t.album?.id).filter(Boolean))].slice(0, 6);
    let best = null;
    let failed = null;
    for (const id of ids) {
      let found = null;
      try {
        found = await album(id, signal);
      } catch (error) {
        if (signal.aborted) throw error;
        failed = error;
        continue;
      }
      if (!found?.released) continue;
      // The earliest release is when the song came out (a later "best of" or reissue isn't);
      // a compilation counts only when nothing else has the song.
      const compiled = (r) => (r.type === "compile" ? 1 : 0);
      if (!best || compiled(found) < compiled(best) || (compiled(found) === compiled(best) && found.released < best.released)) best = found;
    }
    // An album that couldn't be loaded may be the answer: fail (so it's asked again) rather than remember "not found".
    if (!best && failed) throw failed;
    return best ? { album: best.title, albumId: best.id, released: best.released, type: best.type, artwork: best.artwork } : null;
  }, signal);

  async function lookupSongs(body, signal) {
    const list = (Array.isArray(body?.songs) ? body.songs : []).slice(0, MAX_SONGS);
    const results = [];
    for (const song of list) {
      const artist = text(song?.artist, 200);
      const title = text(song?.title, 300);
      if (!artist || !title) { results.push(null); continue; }
      try {
        results.push(await songRelease(artist, title, signal));
      } catch (error) {
        if (signal.aborted) throw error;
        results.push(null);
      }
    }
    return { songs: results };
  }

  return {
    artistReleases,
    artistPictures,
    album: (id, signal) => {
      if (!/^dz\d{1,15}$/.test(id)) throw badRequest("Unknown album.");
      return album(id.slice(2), signal);
    },
    lookupSongs,
    songRelease,
  };
}

async function readJSON(response) {
  if (!response.body) throw new Error("The music catalog sent nothing.");
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BYTES) throw new Error("The music catalog's answer was too large.");
      chunks.push(Buffer.from(value));
    }
    return JSON.parse(Buffer.concat(chunks, size).toString("utf8"));
  } finally {
    void reader.cancel().catch(() => {});
  }
}
