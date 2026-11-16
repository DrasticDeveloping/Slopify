import type { Artist, Track } from "../data/types";
import type { Candidate } from "../state/importer";

/*
 * Recognising songs you already have, so recommendations never offer them again,
 * whatever link or upload they come from. A song matches a library song when:
 *  - it comes from the same source (the same YouTube video, SoundCloud track or
 *    Spotify track, however the link is written), or
 *  - its artist and title match once upload decorations are ignored:
 *    "Dua Lipa - New Rules (Official Music Video)" on DuaLipaVEVO,
 *    "New Rules | Lyrics" re-uploaded by a lyrics channel, and
 *    "New Rules (feat. X) [Remastered 2020]" by "Dua Lipa & X"
 *    are all Dua Lipa's "New Rules".
 * Live versions, remixes, acoustic takes and other versions stay distinct songs.
 * Search results are not filtered; this is only for recommendations.
 */

/** Bracketed tags that describe an upload rather than the song. */
const UPLOAD_TAG = /[([](?:official\b[^)\]]*|(?:hd|hq|4k)\b[^)\]]*|lyrics?\b[^)\]]*|lyric\s*video|visuali[sz]er|audio|video|music\s*video|explicit|clean|(?:\d{4}\s*)?remaster(?:ed)?\b[^)\]]*)[)\]]/giu;
/** The same tags left bare at the end of a title: "Song - Official Video", "Song Remastered 2011". */
const TRAILING_TAG = /\s*[-–—|:]?\s*(?:official\s+(?:music\s+)?(?:video|audio|visuali[sz]er|lyric\s+video)|lyrics?(?:\s+video)?|(?:\d{4}\s+)?remaster(?:ed)?(?:\s+\d{4})?)\s*$/iu;
/** Featured artists and producers are credits, not part of a title. */
const CREDIT = /\s*[([]?\b(?:feat|ft|featuring|prod(?:uced)?(?:\s+by)?)\b\.?[^)\]]*[)\]]?/giu;
/** "Song | Artist" and "Song | Official Video": everything after a pipe is about the upload. */
const PIPE = /\s+\|.*$/u;
/** "Artist - Song". */
const DASHED = /^(.+?)\s+[-–—]\s+(.+)$/u;
/** Splits a credit like "Calvin Harris, Dua Lipa & Young Thug" or "A x B". */
const CREDIT_SPLIT = /\s*(?:&|,|\s+x\s+|\bfeat\.?\s|\bft\.?\s|\bfeaturing\b|\bwith\b)\s*/iu;
const PLACEHOLDER_ARTISTS = new Set(["", "unknown", "unknownartist", "unknownuploader", "localfiles", "variousartists"]);

/** Letters and digits only: "Don't Stop Me Now" and "Dont Stop Me Now" compare equal. */
const bare = (s: string) => s.normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
/** An artist without channel suffixes: "Dua Lipa - Topic" and "DuaLipaVEVO" are "dualipa". */
const artistCore = (artist: string) => bare(artist.replace(/\s+-\s+topic$/iu, "").replace(/vevo$/iu, "").replace(/\s+official$/iu, ""));
function titleCore(title: string) {
  let t = title.replace(PIPE, "").replace(UPLOAD_TAG, " ").replace(CREDIT, " ");
  // Tags can stack ("Song - Official Video - Remastered"), so strip until nothing changes.
  for (let before = ""; before !== t; ) {
    before = t;
    t = t.replace(TRAILING_TAG, "");
  }
  return bare(t);
}

/** Every artist named in a credit, the whole credit first. */
const creditedArtists = (artist: string) => [artist, ...artist.split(CREDIT_SPLIT)].map(artistCore).filter((a) => !PLACEHOLDER_ARTISTS.has(a));

/**
 * The ways a song can be named: its own artist and title, plus "Artist - Title"
 * read from the title (uploads by someone other than the artist), each for every
 * credited artist.
 */
export function songKeys(artist: string | null | undefined, title: string | null | undefined): string[] {
  const names: Array<[string, string]> = [[artist ?? "", title ?? ""]];
  const dashed = (title ?? "").replace(PIPE, "").match(DASHED);
  if (dashed) names.push([dashed[1], dashed[2]]);
  const keys = new Set<string>();
  for (const [a, t] of names) {
    const core = titleCore(t);
    if (!core) continue;
    for (const credited of creditedArtists(a)) keys.add(`${credited}|${core}`);
  }
  return [...keys];
}

/** One id per source, however its link is written (youtu.be, music.youtube.com, ?si= tracking, trailing slashes…). */
export function sourceId(url: string | null | undefined): string | undefined {
  if (!url) return undefined;
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return undefined;
  }
  const host = u.hostname.replace(/^(www|m|music)\./, "");
  if (host === "youtu.be") return `youtube:${u.pathname.slice(1, 12)}`;
  if (host === "youtube.com" || host === "youtube-nocookie.com") {
    const id = u.searchParams.get("v") ?? u.pathname.match(/^\/(?:shorts|embed|live|v)\/([\w-]{11})/)?.[1];
    if (id) return `youtube:${id}`;
  }
  if (host === "open.spotify.com") {
    const track = u.pathname.match(/\/track\/(\w+)/)?.[1];
    if (track) return `spotify:${track}`;
  }
  if (host === "soundcloud.com") return `soundcloud:${u.pathname.replace(/\/+$/, "").toLowerCase()}`;
  return `${host}${u.pathname.replace(/\/+$/, "")}`;
}

/** The links a search result can be known by. */
export const candidateSources = (c: Candidate) =>
  [c.sourceURL, c.sourcePageURL, c.importMetadata?.sourceURL, c.importMetadata?.sourcePageURL].filter((v): v is string => Boolean(v));

export interface OwnedIndex {
  /** Library track ids for this song, if you have it. */
  find(song: { artist?: string | null; title?: string | null; sources?: string[] }): string[];
}

/** Library track ids for a suggestion, if you already have that song. */
export const ownedCopies = (index: OwnedIndex, song: { artist: string; title: string; candidate: Candidate }) =>
  index.find({ artist: song.artist, title: song.title, sources: candidateSources(song.candidate) });

const cache = new WeakMap<Record<string, Track>, { artists: Record<string, Artist>; index: OwnedIndex }>();

/** An index of the library's songs (not streamed suggestions), rebuilt only when tracks or artists change. */
export function ownedIndex(input: { tracks: Record<string, Track>; artists: Record<string, Artist> }): OwnedIndex {
  const hit = cache.get(input.tracks);
  if (hit && hit.artists === input.artists) return hit.index;
  const byKey = new Map<string, string[]>();
  const bySource = new Map<string, string[]>();
  const add = (map: Map<string, string[]>, key: string, id: string) => map.set(key, [...(map.get(key) ?? []), id]);
  for (const t of Object.values(input.tracks)) {
    if (t.stream) continue;
    for (const key of songKeys(input.artists[t.artistId]?.name, t.title)) add(byKey, key, t.id);
    const source = sourceId(t.sourceUrl);
    if (source) add(bySource, source, t.id);
  }
  const index: OwnedIndex = {
    find({ artist, title, sources = [] }) {
      const ids = new Set<string>();
      for (const source of sources) for (const id of bySource.get(sourceId(source) ?? "") ?? []) ids.add(id);
      for (const key of songKeys(artist, title)) for (const id of byKey.get(key) ?? []) ids.add(id);
      return [...ids];
    },
  };
  cache.set(input.tracks, { artists: input.artists, index });
  return index;
}
