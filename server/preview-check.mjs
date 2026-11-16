import fs from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { compare, decodeAudio, libraryPrint, prepareQuery, queryPrint } from "./duplicates/fingerprint.mjs";

/*
 * Listening to a match nobody could read: a playlist song matched only as its artist's upload of the same length
 * (its title in another language, see ownUploadByLength) is compared, by its sound, with Deezer's 30-second preview of
 * the song. Deezer's catalogue and public search (no account) carry the same releases as Spotify's, so the preview
 * is the song itself; the duplicate check's fingerprints (duplicates/fingerprint.mjs) then find it, or don't, inside
 * the upload. Measured on Vocaloid and Ado uploads: the same recording scores a bit error rate of 0.03-0.09, a
 * different song 0.48-0.50, another mix of the same song about 0.25.
 */

const require = createRequire(import.meta.url);
const { normalizeMatchText, scoreUnderNames, withoutCredit } = require("./providers/local-import-core.cjs");
const { ffmpegExecutable } = require("./providers/local-import-platform.cjs");
const { fetchResolvedAudioRange, resolveYouTubeAudio, youtubeCoolingDown } = require("./providers/local-youtube.cjs");
const { fetchResolvedSoundCloudRange, isSoundCloudURL, resolveSoundCloudAudio } = require("./providers/local-soundcloud.cjs");

const DEEZER_SEARCH = "https://api.deezer.com/search";
/** Deezer allows 50 requests in 5 seconds; this stays well inside that, across every playlist at once. */
const DEEZER_GAP_MS = 250;
/** A Deezer track is this song only if its length agrees this closely with Spotify's. */
const SAME_LENGTH_SECONDS = 2;
/** Searches tried for one song, at most. */
const MAX_QUERIES = 5;
/** Uploads compared with one preview, at most (the match and its fallbacks, then uploads of about its length). */
const MAX_UPLOADS = 6;
/**
 * How alike an upload the names didn't match must sound to be taken (`strictFrom`): stricter than `same`, since
 * another singer's version over the same backing track can come close (measured 0.25 for a Hatsune Miku and a
 * Kasane Teto release of one song, 0.03-0.09 for the same recording).
 */
const STRICT_BER = 0.15;
/** Above this bit error rate the upload is another recording altogether (different songs measure 0.48-0.50). */
const DIFFERENT_BER = 0.4;
/** An upload's first this-many seconds are compared first: a preview is usually from its first minute or so. */
const FIRST_SECONDS = 120;

const pause = (ms, signal) => new Promise((resolve, reject) => {
  if (signal?.aborted) return reject(signal.reason ?? new DOMException("Cancelled", "AbortError"));
  const timer = setTimeout(() => {
    signal?.removeEventListener("abort", stop);
    resolve();
  }, ms);
  const stop = () => {
    clearTimeout(timer);
    reject(signal.reason ?? new DOMException("Cancelled", "AbortError"));
  };
  signal?.addEventListener("abort", stop, { once: true });
});

let nextDeezerAt = 0;
async function deezerTurn(signal) {
  const now = Date.now();
  const at = Math.max(now, nextDeezerAt);
  nextDeezerAt = at + DEEZER_GAP_MS;
  await pause(at - now, signal);
}

/**
 * Listening that couldn't be done this time (Deezer or the upload didn't answer): thrown, so no verdict is
 * remembered and the song is listened to again next time.
 */
class NotHeard extends Error {
  constructor(message) {
    super(message);
    this.name = "NotHeard";
    this.retryable = true;
  }
}

/** Deezer's tracks for a search ([] when it has none). Deezer asking for a pause is waited out once. */
async function searchDeezer(query, signal, fetchImpl) {
  for (let attempt = 0; attempt < 2; attempt++) {
    await deezerTurn(signal);
    const response = await fetchImpl(`${DEEZER_SEARCH}?q=${encodeURIComponent(query)}&limit=10`, { signal, headers: { Accept: "application/json" } });
    if (!response.ok) throw new NotHeard(`Deezer search answered ${response.status}`);
    const body = await response.json().catch(() => null);
    // Code 4: "Quota limit exceeded".
    if (body?.error?.code === 4 && attempt === 0) {
      nextDeezerAt = Math.max(nextDeezerAt, Date.now() + 5_000);
      continue;
    }
    if (!body || body.error) throw new NotHeard("Deezer search failed");
    return Array.isArray(body.data) ? body.data : [];
  }
  throw new NotHeard("Deezer asked for a pause");
}

const mainArtist = (artist) => String(artist || "").split(/\s*,\s*/)[0];
/** A title without its credits and bracketed parts ("Debug Drug (feat. HATSUNE MIKU)" -> "Debug Drug"). */
const bareTitle = (title) => withoutCredit(String(title || "")).replace(/\s*[([【「『][^)\]】」』]*[)\]】」』]/g, " ").replace(/\s+/g, " ").trim();

/** The searches for a song, most exact first, under each of its names (Spotify's own and its Japanese one). */
function deezerQueries(track) {
  const names = [{ title: track.title, artist: track.artist }];
  if (track.alternateTitle || track.alternateArtist) names.push({ title: track.alternateTitle || track.title, artist: track.alternateArtist || track.artist });
  const queries = [];
  for (const { title, artist } of names) {
    const main = mainArtist(artist);
    const bare = bareTitle(title) || title;
    queries.push(`artist:"${main}" track:"${title}"`, `artist:"${main}" track:"${bare}"`, `${main} ${bare}`);
  }
  for (const { title } of names) queries.push(`track:"${bareTitle(title) || title}"`);
  return [...new Set(queries.map((q) => q.replace(/\s+/g, " ").trim()))].slice(0, MAX_QUERIES);
}

/**
 * Deezer's track of this song with a preview: the same length, and its name agreeing (`strong`: title and artist both;
 * otherwise one of them). Null if Deezer has none.
 */
export async function findDeezerTrack(track, { signal, fetchImpl = fetch } = {}) {
  if (!track?.title || !track.durationSeconds) return null;
  let fallback = null;
  const seen = new Set();
  /** Deezer's own spellings of the artist's name (see below): its tracks under them count as the artist's. */
  const aliases = new Set();
  const consider = (hit) => {
    // A track seen before an alias was known is weighed again with it.
    const key = `${hit?.id}:${aliases.size}`;
    if (!hit?.preview || seen.has(key) || Math.abs(Number(hit.duration) - track.durationSeconds) > SAME_LENGTH_SECONDS) return null;
    seen.add(key);
    const scored = scoreUnderNames(track, { title: hit.title, artist: hit.artist?.name, durationSeconds: Number(hit.duration) });
    const title = scored?.match.title ?? overlap(track.title, hit.title);
    const byAlias = aliases.has(normalizeMatchText(hit.artist?.name || ""));
    const artist = byAlias ? 1 : scored?.match.artist ?? overlap(track.artist, hit.artist?.name);
    // A track found under a spelling of the artist's name that Deezer's search suggested is taken, but isn't sure
    // enough to rule a match out ("different"): the spelling could be another artist's ("Pips" in "Gladys Knight & the
    // Pips").
    const named = title >= 0.75 && artist >= 0.5;
    const found = { id: hit.id, title: hit.title, artist: hit.artist?.name || null, durationSeconds: Number(hit.duration), preview: hit.preview, strong: named && !byAlias };
    if (named && byAlias) return found;
    if (!fallback && (title >= 0.5 || artist >= 0.5)) fallback = found;
    return found.strong ? found : null;
  };
  for (const query of deezerQueries(track)) {
    for (const hit of await searchDeezer(query, signal, fetchImpl)) {
      const found = consider(hit);
      if (found) return found;
    }
  }
  /*
   * Deezer may know the artist by another spelling (ぴーなた is "pinata" there), so none of the searches above find the
   * song. Its plain search for the artist's name does list their songs under that spelling: the name most of those
   * songs carry is taken as the artist's, and the song is searched for under it.
   */
  for (const main of [...new Set(artistNames(track).map(mainArtist).filter(Boolean))]) {
    const hits = await searchDeezer(main, signal, fetchImpl);
    const counts = new Map();
    for (const hit of hits) {
      const name = normalizeMatchText(hit.artist?.name || "");
      if (name && name !== normalizeMatchText(main)) counts.set(name, (counts.get(name) ?? 0) + 1);
    }
    const [alias, count] = [...counts].sort((a, b) => b[1] - a[1])[0] ?? [];
    if (!alias || count < 2 || count < hits.length / 3) continue;
    aliases.add(alias);
    const spelled = hits.find((hit) => normalizeMatchText(hit.artist?.name || "") === alias).artist.name;
    for (const hit of hits) {
      const found = consider(hit);
      if (found) return found;
    }
    for (const query of [...new Set(titleNames(track).map((t) => bareTitle(t) || t))].map((t) => `${spelled} ${t}`)) {
      for (const hit of await searchDeezer(query, signal, fetchImpl)) {
        const found = consider(hit);
        if (found) return found;
      }
    }
  }
  return fallback;
}

const artistNames = (track) => [track.artist, track.alternateArtist].filter(Boolean);
const titleNames = (track) => [track.title, track.alternateTitle].filter(Boolean);

/** The share of one name's words the other has (for names the scorer turned down outright). */
function overlap(expected, actual) {
  const left = normalizeMatchText(expected || "").split(" ").filter(Boolean);
  const right = new Set(normalizeMatchText(actual || "").split(" ").filter(Boolean));
  return left.length ? left.filter((word) => right.has(word)).length / left.length : 0;
}

async function decodeBytes(ffmpeg, bytes, seconds, signal) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "slopify-listen-"));
  try {
    const file = path.join(dir, "audio");
    await fs.writeFile(file, bytes);
    return await decodeAudio(ffmpeg, file, { seconds, signal });
  } finally {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}

/** An upload's audio stream, ready to read a range of, or null for a link that isn't one. */
async function openUpload(link, signal) {
  if (typeof link !== "string" || !link) return null;
  if (isSoundCloudURL(link)) {
    const resolved = await resolveSoundCloudAudio(link, signal);
    return { resolved, range: (start, end) => fetchResolvedSoundCloudRange(resolved, start, end, signal) };
  }
  // Fingerprinting waits while YouTube is cooling down, rather than adding to what it turned away.
  while (youtubeCoolingDown()) await pause(15_000, signal);
  const resolved = await resolveYouTubeAudio(link, signal);
  return { resolved, range: (start, end) => fetchResolvedAudioRange(resolved, start, end, signal) };
}

/** How an upload compares with a prepared preview: its first two minutes, then the rest if those didn't have it. */
async function compareUpload(ffmpeg, query, link, signal) {
  const upload = await openUpload(link, signal);
  if (!upload?.resolved?.contentLength) return null;
  const { contentLength } = upload.resolved;
  const duration = Number(upload.resolved.durationSeconds) || 0;
  const firstBytes = duration > FIRST_SECONDS ? Math.ceil(contentLength * ((FIRST_SECONDS + 3) / duration)) + 64 * 1024 : contentLength;
  let bytes = await upload.range(0, Math.min(contentLength, firstBytes));
  let samples = await decodeBytes(ffmpeg, bytes, 15 * 60, signal);
  let result = samples ? compare(query, libraryPrint(samples)) : null;
  if (!result?.same && bytes.length < contentLength) {
    bytes = Buffer.concat([bytes, await upload.range(bytes.length, contentLength)]);
    samples = await decodeBytes(ffmpeg, bytes, 15 * 60, signal);
    result = samples ? compare(query, libraryPrint(samples)) : null;
  }
  return result;
}

/**
 * Whether `uploads` (links: the match first, then its fallbacks, then from `strictFrom` on uploads only about as long
 * as the song, which must sound closer: STRICT_BER) sound like the song: `{ verdict: "same", at, ber,
 * deezer }` names the first that does; "different" says none does and Deezer's track is surely this song (title,
 * artist and length all agree), so the match was a coincidence of length; "unsure" is anything else Deezer answered
 * (no Deezer track, another mix). Throws (retryable) when Deezer, its preview or an upload didn't answer, so that
 * isn't taken for an answer.
 */
export async function listenForMatch(track, uploads, { signal, fetchImpl = fetch, strictFrom = Infinity } = {}) {
  let ffmpeg = null;
  try { ffmpeg = ffmpegExecutable(); } catch { ffmpeg = null; }
  if (!ffmpeg) throw new NotHeard("No ffmpeg to listen with");
  const deezer = await findDeezerTrack(track, { signal, fetchImpl });
  if (!deezer) return { verdict: "unsure", reason: "not_on_deezer" };
  const response = await fetchImpl(deezer.preview, { signal });
  if (!response.ok) throw new NotHeard(`Deezer's preview answered ${response.status}`);
  const samples = await decodeBytes(ffmpeg, Buffer.from(await response.arrayBuffer()), 31, signal);
  if (!samples) throw new NotHeard("Deezer's preview couldn't be decoded");
  const query = prepareQuery(queryPrint(samples));
  const about = { id: deezer.id, title: deezer.title, artist: deezer.artist };
  let allDifferent = true;
  let unheard = null;
  for (const [at, link] of uploads.slice(0, MAX_UPLOADS).entries()) {
    let result = null;
    // (Only the match and its fallbacks count as unheard: an upload merely about as long that won't play is just skipped.)
    try {
      result = await compareUpload(ffmpeg, query, link, signal);
      if (!result && at < strictFrom) unheard = new NotHeard("An upload couldn't be fingerprinted");
    } catch (error) {
      if (error?.name === "AbortError" || signal?.aborted) throw error;
      if (at < strictFrom) unheard = error;
    }
    if (result?.same && (at < strictFrom || result.ber <= STRICT_BER)) return { verdict: "same", at, ber: Number(result.ber.toFixed(3)), deezer: about };
    if (!result || result.ber <= DIFFERENT_BER) allDifferent = false;
  }
  // An upload not heard might have been the one: asked again next time rather than settled.
  if (unheard) throw unheard instanceof NotHeard ? unheard : new NotHeard(String(unheard?.message || unheard));
  return allDifferent && deezer.strong ? { verdict: "different", deezer: about } : { verdict: "unsure", reason: "inconclusive", deezer: about };
}
