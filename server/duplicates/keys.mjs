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
