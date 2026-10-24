import { setTimeout as delay } from "node:timers/promises";

/*
 * Song lyrics from LRCLIB (lrclib.net), a free public lyrics library with
 * time-synced (LRC) lyrics for many songs. Only a song's title, artist, album
 * and length are sent. Answers, including "not found", are cached in memory.
 *
 * Wrong lyrics are worse than none, so a search result is only taken when its
 * title and artist match and its length is close to the song's.
 */

const USER_AGENT = process.env.SLOPIFY_METADATA_USER_AGENT || "Slopify/2.0 (https://github.com/DrasticDeveloping/Slopify)";
const BASE = "https://lrclib.net/api";
const MAX_BYTES = 2_000_000;
const SPACING = 300;
const CACHE_SIZE = 300;
const FOUND_TTL = 7 * 86_400_000;
const MISSING_TTL = 6 * 3_600_000;
/** How far a found song's length may be from ours, in seconds. */
const LENGTH_SLACK = 4;

const badRequest = (message) => Object.assign(new Error(message), { status: 400 });
const text = (v, max) => (typeof v === "string" ? v.trim().slice(0, max) : "");
/** Compared without case, accents, spacing or punctuation. */
const bare = (s) => String(s ?? "").normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
/** A title without its bracketed qualifiers ("(feat. X)", "[Remastered 2011]") or a dashed version ("- Radio Edit"). */
const plainTitle = (s) => s.replace(/\s*[([][^)\]]*[)\]]/g, "").replace(/\s+[-–—]\s+.*(?:remaster|version|edit|mix|live|mono|stereo).*$/iu, "").trim() || s;
/** Versions that are sung differently, or not at all, from the song of the same name. */
const VERSIONS = ["live", "remix", "acoustic", "cover", "sped up", "slowed", "nightcore", "instrumental", "karaoke", "demo", "unplugged", "reprise", "a cappella", "acapella"];
const versionsOf = (s) => new Set(VERSIONS.filter((v) => new RegExp(`\\b${v.replace(" ", "\\s*")}\\b`, "iu").test(s)));
const sameVersions = (a, b) => {
  const [x, y] = [versionsOf(a), versionsOf(b)];
  return x.size === y.size && [...x].every((v) => y.has(v));
};
/** The first artist of a credit: "Calvin Harris & Dua Lipa" → "Calvin Harris". */
const leadArtist = (s) => s.split(/\s*(?:&|,|\bx\b|\bfeat\.?\s|\bft\.?\s|\bwith\b)\s*/iu)[0]?.trim() || s;

async function readJSON(response) {
  if (Number(response.headers.get("content-length")) > MAX_BYTES) {
    void response.body?.cancel().catch(() => {});
    throw new Error("Lyrics are too large.");
  }
  const raw = await response.text();
  if (raw.length > MAX_BYTES) throw new Error("Lyrics are too large.");
  return JSON.parse(raw);
}

/** What the client gets: synced lines (as LRC), plain words, an instrumental, or nothing. */
function answer(row) {
  const synced = text(row?.syncedLyrics, 200_000);
  const plain = text(row?.plainLyrics, 200_000);
  const found = { source: row?.id ? `https://lrclib.net/api/get/${encodeURIComponent(row.id)}` : undefined, matched: { title: text(row?.trackName, 300), artist: text(row?.artistName, 300) } };
  if (row?.instrumental) return { status: "instrumental", ...found };
  if (synced) return { status: "synced", lrc: synced, plain: plain || undefined, ...found };
  if (plain) return { status: "plain", plain, ...found };
  return { status: "none" };
}

export function createLyrics({ fetchImpl = fetch, now = Date.now, wait = delay } = {}) {
  const cache = new Map();
  const pending = new Map();
  let queue = Promise.resolve();
  let last = 0;
  let blockedUntil = 0;

  const remember = (key, value) => {
    cache.delete(key);
    cache.set(key, { value, until: now() + (value.status === "none" ? MISSING_TTL : FOUND_TTL) });
    while (cache.size > CACHE_SIZE) cache.delete(cache.keys().next().value);
  };

  /** One request at a time, spaced out, and none for a minute after LRCLIB says it's busy. Null for "not found". */
  function request(path, params, signal) {
    const url = new URL(`${BASE}/${path}`);
    for (const [key, value] of Object.entries(params)) if (value !== undefined && value !== "") url.searchParams.set(key, String(value));
    const task = queue.then(async () => {
      signal.throwIfAborted();
      if (blockedUntil > now()) throw Object.assign(new Error("The lyrics library is busy. Try again in a minute."), { status: 503 });
      await wait(Math.max(0, SPACING - (now() - last)), undefined, { signal });
      last = now();
      const response = await fetchImpl(url, { signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]), headers: { Accept: "application/json", "User-Agent": USER_AGENT } }).catch((error) => {
        // A dropped connection or slow answer is the lyrics library being unreachable, not this server failing.
        throw signal.aborted ? error : Object.assign(new Error("The lyrics library couldn't be reached."), { status: 502 });
      });
      if (response.status === 404) {
        void response.body?.cancel().catch(() => {});
        return null;
      }
      if (response.status === 429 || response.status === 503) blockedUntil = now() + 60_000;
      if (!response.ok) {
        void response.body?.cancel().catch(() => {});
        throw Object.assign(new Error("The lyrics library couldn't be reached."), { status: 502 });
      }
      return readJSON(response);
    });
    queue = task.catch(() => {});
    return task;
  }

  /** Whether a found row is the song asked about: same title and artist, and about as long. */
  function matches(row, song) {
    if (!row || typeof row !== "object") return false;
    const length = Number(row.duration);
    if (song.duration && !(Number.isFinite(length) && Math.abs(length - song.duration) <= LENGTH_SLACK)) return false;
    const titles = [bare(row.trackName), bare(plainTitle(text(row.trackName, 300)))];
    const wanted = [bare(song.title), bare(plainTitle(song.title))];
    if (!titles.some((t) => t && wanted.includes(t))) return false;
    // "Song (Live)" is not "Song", nor the other way round.
    if (!sameVersions(text(row.trackName, 300) + " " + text(row.albumName, 300), song.title + " " + song.album)) return false;
    // The same credit, or the same lead artist ("Dua Lipa feat. DaBaby" is "Dua Lipa"); "Queensrÿche" is not "Queen".
    const theirs = text(row.artistName, 300);
    if (!bare(theirs)) return false;
    return bare(theirs) === bare(song.artist) || bare(leadArtist(theirs)) === bare(leadArtist(song.artist));
  }

  async function find(song, signal) {
    const title = plainTitle(song.title);
    const lead = leadArtist(song.artist);
    // An exact lookup first: LRCLIB matches the length itself (within a couple of seconds).
    if (song.duration) {
      for (const params of [
        { track_name: song.title, artist_name: song.artist, album_name: song.album, duration: Math.round(song.duration) },
        { track_name: title, artist_name: lead, duration: Math.round(song.duration) },
      ]) {
        const row = await request("get", params, signal);
        if (row && matches(row, song)) return answer(row);
      }
    }
    // Then a search, taking the closest-length match, synced lyrics first.
    const rows = await request("search", { track_name: title, artist_name: lead }, signal);
    const candidates = (Array.isArray(rows) ? rows : []).filter((row) => matches(row, song));
    candidates.sort((a, b) => Number(Boolean(b.syncedLyrics)) - Number(Boolean(a.syncedLyrics)) || Math.abs(a.duration - song.duration) - Math.abs(b.duration - song.duration));
    return candidates.length ? answer(candidates[0]) : { status: "none" };
  }

  return {
    /** Lyrics for a song: { title, artist, album?, duration } (seconds). */
    async lookup(body, signal) {
      const song = {
        title: text(body?.title, 300),
        artist: text(body?.artist, 300),
        album: text(body?.album, 300),
        duration: Number.isFinite(body?.duration) && body.duration > 0 && body.duration < 86_400 ? body.duration : 0,
      };
      if (!song.title || !song.artist) throw badRequest("Send the song's title and artist.");
      signal?.throwIfAborted();
      // The album decides versions too ("Live at Wembley"), so it's part of what was asked.
      const key = JSON.stringify([bare(song.title), bare(song.artist), bare(song.album), Math.round(song.duration)]);
      const hit = cache.get(key);
      if (hit && hit.until > now()) return hit.value;
      // Two windows asking for the same song share one lookup.
      let task = pending.get(key);
      if (!task) {
        task = find(song, AbortSignal.timeout(30_000))
          .then((value) => {
            remember(key, value);
            return value;
          })
          .finally(() => pending.delete(key));
        pending.set(key, task);
      }
      return signal ? Promise.race([task, new Promise((_, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }))]) : task;
    },
  };
}
