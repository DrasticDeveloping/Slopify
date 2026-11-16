import { createRequire } from "node:module";

const { youtubeVideoID } = createRequire(import.meta.url)("../providers/local-import-core.cjs");

/*
 * Source keys: the provider ids a song came from, written one way however its
 * link was written ("youtu.be/X", "youtube.com/watch?v=X&t=30" and a playlist
 * entry for X are all "youtube:X"). Two songs that share a key came from the
 * same upload, so the second needs no download at all.
 *
 * A song's keys come from its link, its source identity (what was matched: a
 * Spotify track) and that identity's aliases (where its sound came from: the
 * YouTube video chosen for it).
 */

const SOUNDCLOUD_HOSTS = new Set(["soundcloud.com", "www.soundcloud.com", "m.soundcloud.com"]);
const SPOTIFY_ID = /^[A-Za-z0-9]{22}$/;

/** A link's source key, or null for a link that isn't a song on a known site. */
export function linkKey(value) {
  if (typeof value !== "string" || !value) return null;
  let url;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  try {
    const id = youtubeVideoID(url.href.replace(/^http:/, "https:"));
    if (id) return `youtube:${id}`;
  } catch {
    // Not a YouTube video.
  }
  const host = url.hostname.toLowerCase();
  if (host === "open.spotify.com") {
    const parts = url.pathname.split("/").filter(Boolean).filter((part) => !/^intl-/i.test(part));
    if (parts[0] === "track" && SPOTIFY_ID.test(parts[1] || "")) return `spotify:${parts[1]}`;
    return null;
  }
  if (SOUNDCLOUD_HOSTS.has(host)) {
    const parts = url.pathname.split("/").filter(Boolean).map((part) => part.toLowerCase());
    // artist/track (a playlist, "sets", is never a song).
    if (parts.length === 2 && parts[1] !== "sets") return `soundcloud:${parts.join("/")}`;
  }
  return null;
}

/** A provider id's source key, or null. */
function idKey(provider, id) {
  const p = typeof provider === "string" ? provider.toLowerCase() : "";
  const value = typeof id === "string" || typeof id === "number" ? String(id).trim() : "";
  if (!p || !value) return null;
  if (p.startsWith("youtube")) return /^[A-Za-z0-9_-]{11}$/.test(value) ? `youtube:${value}` : null;
  if (p === "spotify") return SPOTIFY_ID.test(value) ? `spotify:${value}` : null;
  if (p === "soundcloud") {
    // A SoundCloud result's id is its track number, sometimes written "soundcloud:123".
    const number = value.replace(/^soundcloud:/i, "");
    return /^\d+$/.test(number) ? `soundcloud-id:${number}` : linkKey(value);
  }
  return null;
}

/** Every source key of a song (or of one being saved): `{ sourceURL, sourceIdentity }`. */
export function sourceKeys({ sourceURL, sourceIdentity } = {}) {
  const keys = new Set();
  const add = (key) => key && keys.add(key);
  add(linkKey(sourceURL));
  const visit = (identity, depth) => {
    if (!identity || typeof identity !== "object" || Array.isArray(identity)) return;
    add(idKey(identity.provider, identity.providerID));
    add(linkKey(identity.sourcePageURL));
    add(linkKey(identity.sourceURL));
    add(linkKey(identity.mediaSourceURL));
    add(linkKey(identity.evidence?.matchedMediaReference));
    add(idKey(identity.evidence?.matchedMediaProvider, identity.evidence?.matchedMediaProviderID));
    if (depth === 0 && Array.isArray(identity.aliases)) for (const alias of identity.aliases.slice(0, 8)) visit(alias, 1);
  };
  visit(sourceIdentity, 0);
  return keys;
}

/* ───────────────────────── names that might be the same song ───────────────────────── */

/** A title's words, without what uploads add to it ("(Official Video)", "[Lyrics]", "feat. …"). */
export function titleWords(value) {
  if (typeof value !== "string") return [];
  const text = value
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[([{][^)\]}]*[)\]}]/g, " ")
    .replace(/\b(feat|ft|featuring)\b\.?.*$/, " ")
    .replace(/[^a-z0-9À-￿]+/g, " ");
  return text.split(" ").filter(Boolean);
}

/**
 * Whether two songs' names leave room for them being the same recording: one's title words
 * are (nearly all) among the other's title and artist words. An upload's title often holds
 * its artist too ("Artist - Song"), so a library song's artist counts toward its title.
 */
export function namesOverlap(a, b) {
  const aTitle = titleWords(a.title);
  const bTitle = titleWords(b.title);
  if (!aTitle.length || !bTitle.length) return false;
  const covered = (words, pool) => {
    const set = new Set(pool);
    return words.filter((w) => set.has(w)).length / words.length;
  };
  const aAll = [...aTitle, ...titleWords(a.artist)];
  const bAll = [...bTitle, ...titleWords(b.artist)];
  return covered(aTitle, bAll) >= 0.8 || covered(bTitle, aAll) >= 0.8;
}

/* ───────────────────────── songs already in the library ───────────────────────── */

/** Each credited artist on its own, letters only: "ryo (supercell), Hatsune Miku" is "ryo" and "hatsunemiku". */
function creditedNames(artist) {
  if (typeof artist !== "string") return [];
  const names = [artist, ...artist.split(/\s*(?:,|、|&|\/|\s x\s|\bfeat\b\.?|\bft\b\.?|\bfeaturing\b|\bwith\b)\s*/i)]
    .map((name) => titleWords(name.replace(/\s+-\s+topic$/i, "").replace(/vevo$/i, "")).join(""))
    .filter(Boolean);
  return [...new Set(names)];
}

const songName = (title) => titleWords(title).join("");

/** Words that make a recording another version of the song: "Song (Live)" and "Song (Remix)" aren't "Song". */
const VERSION_WORD = /\b(live|remix(?:ed)?|mix|acoustic|instrumental|inst|karaoke|cover|nightcore|slowed|sped|reverb|demo|remake|unplugged|acapella|a cappella|orchestral|piano|extended|edit|version|ver|size|session)\b/giu;
/** A title's version words, bracketed or not, sorted: two recordings are one only if theirs are the same. */
const versionOf = (title) => (typeof title === "string" ? [...new Set((title.toLowerCase().match(VERSION_WORD) ?? []))].sort().join(",") : "");

/**
 * Finds the library song a playlist song already is, so a playlist import needn't search for it: the same source
 * (a Spotify track saved before), or the same title and version (live, remix…) by one of the same artists.
 * Stricter than `namesOverlap`, which only says two songs might be one: here a match means the song isn't offered
 * for saving again. Only songs saved as `savedAs` count (a song saved as audio doesn't stand in for its video).
 * Returns `(track) => song id | null`.
 */
export function ownedSongFinder(songs, savedAs = "audio") {
  const bySource = new Map();
  const byName = new Map();
  for (const song of songs) {
    if ((song.savedAs === "video" ? "video" : "audio") !== savedAs) continue;
    for (const key of sourceKeys(song)) if (!bySource.has(key)) bySource.set(key, song.id);
    const names = [[song.artist, song.title]];
    // An upload saved under its own title: "Artist - Song".
    const dashed = typeof song.title === "string" ? /^(.+?)\s+[-–—]\s+(.+)$/u.exec(song.title) : null;
    if (dashed) names.push([dashed[1], dashed[2]]);
    for (const [artist, title] of names) {
      const name = songName(title);
      if (!name) continue;
      const key = `${name}|${versionOf(title)}`;
      for (const credited of creditedNames(artist)) if (!byName.has(`${credited}|${key}`)) byName.set(`${credited}|${key}`, song.id);
    }
  }
  return (track) => {
    const source = linkKey(track?.sourceURL);
    if (source && bySource.has(source)) return bySource.get(source);
    // Its own names, and the Japanese ones Spotify also gives it (a song saved from YouTube carries those).
    const names = [[track?.artist, track?.title], [track?.alternateArtist || track?.artist, track?.alternateTitle || track?.title]];
    for (const [artist, title] of names) {
      const name = songName(title);
      if (!name) continue;
      const key = `${name}|${versionOf(title)}`;
      for (const credited of creditedNames(artist)) {
        const id = byName.get(`${credited}|${key}`);
        if (id) return id;
      }
    }
    return null;
  };
}
