/*
 * Who a song is by, when it comes from an upload. Uploads often name the artist
 * in the title and come from someone else's channel: "TV Girl - Not Allowed"
 * uploaded by "elka sarra" is TV Girl's "Not Allowed". Services with real song
 * metadata (Spotify) are left as they are.
 */

const DASHED = /^(.+?)\s+[-–—]\s+(.+)$/u;
/** Upload decorations at the end of a title: "(Official Video)", "[Lyrics]", "| Audio". */
const UPLOAD_TAG = /\s*(?:[([](?:official[^)\]]*|(?:hd|hq|4k)\b[^)\]]*|lyrics?\b[^)\]]*|lyric\s*video|visuali[sz]er|audio|video|music\s*video)[)\]]|\|\s*(?:official\b.*|lyrics?\b.*|audio|video))\s*$/iu;
/** A whole part after the dash that only names a version: "Remix", "Radio Edit", "Live at Wembley", "Part II", "Sped Up". */
const VERSION = /^(?:(?:[\p{L}\p{N}'’.]+\s+){0,2}(?:remix|version|edit|mix|cover|remaster(?:ed)?|instrumental|acoustic|demo)|live\b[^()[\]]*|part\s+[\p{L}\p{N}]+|pt\.?\s*\d+|sped\s*up|slowed(?:\s*\+?\s*reverb)?|extended)$/iu;
const bare =(s: string) => s.normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");

/** Whether a source link is an upload (YouTube or SoundCloud), whose uploader may not be the artist. */
export function isUploadLink(url: string | null | undefined) {
  if (!url) return false;
  try {
    const host = new URL(url).hostname.replace(/^(www|m|music)\./, "");
    return host === "youtube.com" || host === "youtu.be" || host === "soundcloud.com";
  } catch {
    return false;
  }
}

/** The artist and title an upload is of: "Artist - Title" read from the title, and channel suffixes removed. */
export function uploadCredit(artist: string, title: string): { artist: string; title: string } {
  // "Artist - Topic" channels carry the label's own metadata.
  const topic = /\s+-\s+topic$/iu.test(artist);
  let a = artist.replace(/\s+-\s+topic$/iu, "").trim() || artist;
  let t = title;
  for (let before = ""; before !== t; ) {
    before = t;
    t = t.replace(UPLOAD_TAG, "").trim();
  }
  const dashed = topic ? null : t.match(DASHED);
  // "Song - Remix", "Song - Live at …": a version, not an artist.
  if (dashed && !VERSION.test(dashed[2])) {
    const [left, right] = [dashed[1].trim(), dashed[2].trim()];
    // "Title - Artist" by the artist's own channel reads the other way round.
    if (bare(right) === bare(a) && bare(left) !== bare(a)) t = left;
    else if (left.length <= 80) [a, t] = [left, right];
  }
  return { artist: a || artist, title: t || title };
}
