import type { Artist, Track } from "../data/types";

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

/**
 * A saved upload's title as a song name: tags like "(Official Video)" and a leading
 * "Artist - " for its own artist are dropped. Who it's by isn't re-read here; the
 * music server already checked that when the song was saved.
 */
export function uploadTitle(artist: string, title: string) {
  let t = title;
  for (let before = ""; before !== t; ) {
    before = t;
    t = t.replace(UPLOAD_TAG, "").trim();
  }
  const dashed = t.match(DASHED);
  if (dashed && bare(dashed[1]) === bare(artist) && !VERSION.test(dashed[2].trim())) t = dashed[2].trim();
  return t || title;
}

/** Acts whose own name has a comma in it. */
const COMMA_NAMES = ["Tyler, The Creator", "Earth, Wind & Fire", "Crosby, Stills, Nash & Young", "Crosby, Stills & Nash", "Emerson, Lake & Palmer", "Peter, Paul and Mary"];

/**
 * Each artist of a credit: "Lady Gaga, Bruno Mars" and "Calvin Harris feat. Big Sean"
 * are two artists. "&" is left alone ("Selena Gomez & The Scene" is one act), and so
 * are acts with a comma in their name ("Tyler, The Creator").
 */
export function splitArtists(credit: string): string[] {
  // Acts with a comma in their name stand in as "#0#", "#1#"… while the credit is split.
  const kept: string[] = [];
  let masked = credit;
  for (const name of COMMA_NAMES) {
    const at = masked.toLowerCase().indexOf(name.toLowerCase());
    if (at >= 0) masked = `${masked.slice(0, at)}#${kept.push(masked.slice(at, at + name.length)) - 1}#${masked.slice(at + name.length)}`;
  }
  const names: string[] = [];
  for (const part of masked.split(/\s*,\s*|\s+(?:feat\.?|ft\.?|featuring)\s+/iu)) {
    const name = part.replace(/#(\d+)#/gu, (_, i: string) => kept[Number(i)]).trim();
    if (name && !names.some((n) => bare(n) === bare(name))) names.push(name);
  }
  return names.length ? names : [credit];
}

/** Everyone credited on a track, main artist first: "Lady Gaga, Bruno Mars". */
export function creditLine(t: Pick<Track, "artistId" | "featuring">, artists: Record<string, Artist>) {
  return [t.artistId, ...(t.featuring ?? [])].map((id) => artists[id]?.name).filter(Boolean).join(", ");
}

/** Whether `artistId` is credited on the track, as its main artist or a featured one. */
export const creditsArtist = (t: Pick<Track, "artistId" | "featuring">, artistId: string) => t.artistId === artistId || Boolean(t.featuring?.includes(artistId));
