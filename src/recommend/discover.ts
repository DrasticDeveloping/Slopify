import type { Candidate } from "../state/importer";
import { earlySkip, isImported, meaningfulArtist, normalize, reasonWeight, songKey, tasteProfile, type ReasonKind, type SongLink, type TasteInput } from "./taste";

/*
 * Finding songs outside your library. Your most-supported imported songs and
 * artists go to ListenBrainz (through the app server) for "listeners also play"
 * relationships; the strongest unfamiliar songs and artists are then searched on
 * the import providers, and only results whose metadata really matches are shown.
 * Without relationships it falls back to plain searches, and says so.
 */

export type DiscoveryKind = Extract<ReasonKind, "discover-song" | "discover-artist" | "discover-search">;

export interface Seed { name: string; title: string; weight: number }

export interface Related {
  songs: Array<{ seed: { name: string; title: string }; status: string; songs: Array<{ artist: string; title: string; affinity: number }> }>;
  artists: Array<{ seed: string; status: string; artists: Array<{ name: string; affinity: number }> }>;
}

export interface DiscoveryQuery {
  text: string;
  kind: DiscoveryKind;
  /** The artist a result must be by (related songs and artists). */
  artist?: string;
  /** The title a result must have (related songs). */
  title?: string;
  /** What the query came from, for the reason line. */
  because: string;
  affinity: number;
}

export interface DiscoveryBatch { query: DiscoveryQuery; candidates: Candidate[] }

export interface DiscoveredSong {
  key: string;
  candidate: Candidate;
  title: string;
  artist: string;
  artwork?: string;
  reason: string;
  kind: DiscoveryKind;
}

const DAY = 86_400_000;
const sat = (n: number) => n / (n + 2);
/** Seeds sent to ListenBrainz, of each kind (the server accepts up to five). */
const SEEDS = 5;
/** First-wave searches. A related-song search yields its one exact match; an artist search up to two songs. */
const SONG_QUERIES = 14;
const ARTIST_QUERIES = 6;
const MIN_QUERIES = 12;
/** Reserve searches, run only while the shelf is short of SHELF_TARGET (many searches find nothing usable). */
const MAX_QUERIES = 48;
/** The shelf keeps searching until it has this many suggestions, and shows at most SHELF_SIZE. */
export const SHELF_TARGET = 24;
export const SHELF_SIZE = 30;

/** Upload decorations that are not part of a song's name ("(Official Video …)", "(Lyrics)"). Live, remix and version qualifiers stay unless they sit inside such a tag. */
const DECORATION = /\s*[([](?:official\b[^)\]]*|lyrics?|lyric\s*video|visuali[sz]er|audio|hd|hq|4k)[)\]]\s*/giu;
/** Featured-artist notes are credits, not part of a title. */
const FEATURING = /\s*[([](?:feat|ft|featuring|with)\b\.?[^)\]]*[)\]]/giu;
const cleanTitle = (title: string | null | undefined) => normalize((title ?? "").replace(DECORATION, " ").replace(FEATURING, " "));
/** Artist names compared without channel suffixes, spacing or punctuation: "DuaLipaVEVO" and "Dua Lipa - Topic" are "dualipa". */
const cleanArtist = (artist: string | null | undefined) =>
  normalize((artist ?? "").replace(/\s+-\s+topic$/iu, "").replace(/vevo$/iu, "")).replace(/[^\p{L}\p{N}]+/gu, "");
/** A collaborator's own artist page includes songs explicitly credited to that collaborator. */
const creditedArtist = (credit: string, name: string) => cleanArtist(credit) === cleanArtist(name)
  || credit.split(/\s*(?:&|,|\bfeat\.?\s|\bft\.?\s|\bwith\b)\s*/iu).some((part) => cleanArtist(part) === cleanArtist(name));
/** One song however a service decorates it: "Creo - Topic / Flow (Official Audio)" is "creo|flow". Used for ownership, duplicates and dismissals. */
export const discoveryKey = (artist: string | null | undefined, title: string | null | undefined) => `${cleanArtist(artist)}|${cleanTitle(title)}`;

/** Dislikes per artist: early skips of their songs and dismissed discoveries, both fading over two weeks. */
function artistPenalties(input: TasteInput, now: number) {
  const penalties = new Map<string, number>();
  const add = (name: string | undefined, at: number) => {
    if (!meaningfulArtist(name)) return;
    const key = cleanArtist(name);
    penalties.set(key, (penalties.get(key) ?? 0) + 2 ** (-(now - at) / DAY / 14));
  };
  for (const l of input.taste.listens) {
    const t = input.tracks[l.trackId];
    if (t && earlySkip(l)) add(input.artists[t.artistId]?.name, l.at);
  }
  for (const [key, at] of Object.entries(input.taste.hiddenDiscoveries)) add(key.split("|")[0], at);
  return penalties;
}

/**
 * Up to three songs and three artists to discover from: imported songs you have
 * liked, saved or played, with real artist names (demo artists are fictional).
 */
export function discoverySeeds(input: TasteInput, now = Date.now()) {
  const p = tasteProfile(input, now);
  const penalties = artistPenalties(input, now);
  const songs = new Map<string, Seed & { touched: number }>();
  const artists = new Map<string, Seed & { best: number; touched: number }>();
  for (const [id, support] of p.support) {
    const t = input.tracks[id];
    const name = input.artists[t.artistId]?.name;
    if (!isImported(t) || input.taste.hidden[id] || !meaningfulArtist(name) || !t.title.trim() || name!.length > 180 || t.title.length > 250) continue;
    const weight = support / (1 + (penalties.get(cleanArtist(name)) ?? 0));
    const touched = p.touched.get(id) ?? 0;
    const key = songKey(name, t.title);
    const song = songs.get(key);
    songs.set(key, { name: name!, title: t.title, weight: (song?.weight ?? 0) + weight, touched: Math.max(song?.touched ?? 0, touched) });
    const artist = artists.get(normalize(name));
    artists.set(normalize(name), {
      name: name!,
      title: artist && artist.best >= weight ? artist.title : t.title,
      best: Math.max(artist?.best ?? 0, weight),
      weight: (artist?.weight ?? 0) + weight,
      touched: Math.max(artist?.touched ?? 0, touched),
    });
  }
  // Recent evidence breaks ties, so a freshly imported playlist steers discovery.
  const top = <T extends Seed & { touched: number }>(list: Iterable<T>) =>
    [...list].sort((a, b) => b.weight - a.weight || b.touched - a.touched || a.name.localeCompare(b.name)).slice(0, SEEDS).map(({ name, title, weight }) => ({ name, title, weight }));
  return { songs: top(songs.values()), artists: top(artists.values()) };
}

/** Asks the app server for ListenBrainz relationships. Malformed entries are dropped, not trusted. */
export async function fetchRelated(seeds: { songs: Seed[]; artists: Seed[] }, signal: AbortSignal): Promise<Related> {
  const res = await fetch("/api/recommendations/related", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ songs: seeds.songs.map(({ name, title }) => ({ name, title })), artists: seeds.artists.map(({ name, title }) => ({ name, title })) }),
    signal,
  });
  const body = (await res.json().catch(() => null)) as { ok?: boolean; result?: Partial<Related> } | null;
  if (!res.ok || !body?.ok || !body.result) throw new Error("Related music is unavailable.");
  const text = (v: unknown, max = 250): v is string => typeof v === "string" && v.trim().length > 0 && v.length <= max;
  const affinity = (v: unknown): v is number => typeof v === "number" && v > 0 && v <= 1;
  return {
    songs: (Array.isArray(body.result.songs) ? body.result.songs : []).filter((r) => text(r?.seed?.name) && text(r.seed.title) && Array.isArray(r.songs)).map((r) => ({
      seed: r.seed, status: String(r.status), songs: r.songs.filter((s) => text(s?.artist, 180) && text(s.title) && affinity(s.affinity)).slice(0, 50),
    })),
    artists: (Array.isArray(body.result.artists) ? body.result.artists : []).filter((r) => text(r?.seed) && Array.isArray(r.artists)).map((r) => ({
      seed: r.seed, status: String(r.status), artists: r.artists.filter((a) => text(a?.name, 180) && affinity(a.affinity)).slice(0, 50),
    })),
  };
}

/** Song edges to remember, so library ranking can use them too ("listeners of X also play Y"). */
export function relatedLinks(related: Related, at = Date.now()): SongLink[] {
  return related.songs.flatMap((r) => r.songs.map((s) => ({ from: songKey(r.seed.name, r.seed.title), to: songKey(s.artist, s.title), affinity: s.affinity, at }))).slice(0, 150);
}

/**
 * The searches to run: enough related songs and related artists to fill a
 * shelf, strongest first (at most two songs per artist), rotated by `refresh`
 * so "Find more" shows something new. Kinds you have kept more often rank higher.
 */
export function discoveryQueries(related: Related | null, seeds: { songs: Seed[]; artists: Seed[] }, input: TasteInput, refresh = 0, now = Date.now()): DiscoveryQuery[] {
  // Streamed suggestions are not in the library, so they never count as owned or known.
  const library = Object.values(input.tracks).filter((t) => !t.stream);
  const owned = new Set(library.map((t) => discoveryKey(input.artists[t.artistId]?.name, t.title)));
  const known = new Set(library.map((t) => cleanArtist(input.artists[t.artistId]?.name)));
  const penalties = artistPenalties(input, now);
  const damp = (artist: string) => 1 / (1 + (penalties.get(cleanArtist(artist)) ?? 0));

  const songs = new Map<string, DiscoveryQuery>();
  const maxSong = Math.max(1e-9, ...seeds.songs.map((s) => s.weight));
  for (const r of related?.songs ?? []) {
    const seed = seeds.songs.find((s) => songKey(s.name, s.title) === songKey(r.seed.name, r.seed.title));
    if (!seed) continue;
    for (const s of r.songs) {
      const key = discoveryKey(s.artist, s.title);
      if (owned.has(key) || input.taste.hiddenDiscoveries[key]) continue;
      // Unfamiliar artists are the point of discovery; known ones still qualify, a little lower.
      const affinity = s.affinity * (seed.weight / maxSong) * damp(s.artist) / (known.has(cleanArtist(s.artist)) ? 1.25 : 1);
      if ((songs.get(key)?.affinity ?? 0) < affinity) songs.set(key, { text: `${s.artist} ${s.title}`, kind: "discover-song", artist: s.artist, title: s.title, because: `“${seed.title}”`, affinity });
    }
  }
  const artists = new Map<string, DiscoveryQuery & { strongest: number }>();
  const maxArtist = Math.max(1e-9, ...seeds.artists.map((s) => s.weight));
  const seedNames = new Set(seeds.artists.map((s) => cleanArtist(s.name)));
  for (const r of related?.artists ?? []) {
    const seed = seeds.artists.find((s) => normalize(s.name) === normalize(r.seed));
    if (!seed) continue;
    for (const a of r.artists) {
      const name = cleanArtist(a.name);
      if (known.has(name) || seedNames.has(name)) continue;
      const edge = a.affinity * (seed.weight / maxArtist);
      const old = artists.get(name);
      // Artists related to several of your favourites add up; the strongest seed names the reason.
      artists.set(name, {
        text: a.name, kind: "discover-artist", artist: a.name,
        because: !old || edge > old.strongest ? seed.name : old.because,
        strongest: Math.max(edge, old?.strongest ?? 0),
        affinity: Math.min(1.5, (old?.affinity ?? 0) + edge),
      });
    }
  }
  const rank = <T extends DiscoveryQuery>(list: Iterable<T>, weight: number) =>
    [...list].map((q) => ({ ...q, affinity: q.kind === "discover-artist" ? q.affinity * damp(q.text) * weight : q.affinity }))
      .sort((a, b) => b.affinity - a.affinity || a.text.localeCompare(b.text)).slice(0, 80);
  const songPool = rank(songs.values(), 1);
  const artistPool = rank(artists.values(), 1).map(({ strongest: _, ...q }) => q as DiscoveryQuery);

  const picked: DiscoveryQuery[] = [];
  const sameArtist = (a: DiscoveryQuery, b: DiscoveryQuery) => !!a.artist && !!b.artist && cleanArtist(a.artist) === cleanArtist(b.artist);
  const take = (pool: DiscoveryQuery[], count: number, perArtist: number) => {
    const start = pool.length ? (refresh * count) % pool.length : 0;
    for (let i = 0; i < pool.length && count > 0; i++) {
      const q = pool[(start + i) % pool.length];
      if (picked.includes(q) || picked.filter((x) => x.kind === q.kind && sameArtist(x, q)).length >= perArtist) continue;
      picked.push(q);
      count--;
    }
  };
  take(songPool, SONG_QUERIES, 2);
  take(artistPool, ARTIST_QUERIES, 1);
  const firstWave = picked.length;
  // Short on relationships: other songs by the artists you play (the ones you own are filtered out later).
  for (const seed of seeds.artists) {
    if (picked.length >= MIN_QUERIES) break;
    const q: DiscoveryQuery = { text: `${seed.name}${refresh ? [" songs", " music", " official audio", " singles"][refresh % 4] : ""}`, kind: "discover-search", artist: seed.name, because: `More from ${seed.name}`, affinity: 0 };
    if (!picked.some((x) => x.kind === "discover-search" && sameArtist(x, q))) picked.push(q);
  }
  // Imported songs have no real genre, so a genre search only happens for demo-song taste or a cold start.
  if (picked.length < MIN_QUERIES) {
    const genre = [...tasteProfile(input, now).genres].sort((a, b) => b[1] - a[1])[0]?.[0];
    if (genre || !seeds.artists.length) {
      const subject = genre ?? ["indie", "electronic", "pop", "alternative", "soul", "lofi"][refresh % 6];
      picked.push({ text: `${subject} music`, kind: "discover-search", because: `Exploring ${subject}`, affinity: 0 });
    }
  }
  // Reserves, in the same order of strength, for when the first wave comes back thin.
  if (firstWave) {
    take(songPool, MAX_QUERIES - picked.length, 2);
    take(artistPool, MAX_QUERIES - picked.length, 1);
  }
  return picked.slice(0, MAX_QUERIES);
}

/** Live streams, mixes and full albums are not songs; Search can still find them. */
const LONG_FORM = /\b(?:live\s*stream|livestream|24\s*\/\s*7|full\s+album|\d+\s*(?:hours?|hrs?))\b|\bradio\b.*\b(?:beats|study|relax|live)\b/iu;
/** A result the importer can actually download, or offer for review before downloading. */
export const discoverable = (c: Candidate) => Boolean(c.sourceURL) && (c.actionable !== false || c.requiresReview === true);

/**
 * Turns search results into suggestions: drops what you own or dismissed, long
 * mixes, and anything that does not really match its query (a loose search hit
 * never borrows a relationship's reason), then spaces out artists and services.
 */
export function pickDiscoveries(batches: DiscoveryBatch[], input: TasteInput, limit = SHELF_SIZE, now = Date.now(), exclude: Set<string> = new Set(), perArtist = 2): DiscoveredSong[] {
  const penalties = artistPenalties(input, now);
  const library = Object.values(input.tracks).filter((t) => !t.stream);
  const ownedUrls = new Set(library.map((t) => t.sourceUrl).filter(Boolean));
  const ownedKeys = new Set(library.map((t) => discoveryKey(input.artists[t.artistId]?.name, t.title)));
  const seen = new Set<string>();
  const urls = new Set<string>();
  const results: Array<DiscoveredSong & { score: number; provider: string }> = [];
  for (const { query, candidates } of batches) {
    candidates.forEach((candidate, index) => {
      if (!discoverable(candidate)) return;
      const meta = candidate.importMetadata ?? candidate;
      let title = (meta.title || candidate.title || "").replace(DECORATION, " ").trim();
      let artist = meta.artist || candidate.artist || "Unknown artist";
      // Uploads often put the artist in the title ("Dua Lipa - New Rules" on a channel called DuaLipaVEVO).
      const credited = title.match(/^(.+?)\s+[-–—]\s+(.+)$/u);
      if (credited && [query.artist, artist].some((a) => a && creditedArtist(credited[1], a))) [artist, title] = [credited[1].trim(), credited[2].trim()];
      if (!title) return;
      const durations = [meta.durationSeconds, candidate.durationSeconds].filter((d): d is number => typeof d === "number" && Number.isFinite(d));
      if (durations.some((d) => d > 20 * 60) || LONG_FORM.test(title)) return;
      // Every query about an artist (related or "More from") must return that artist; only genre searches range freely.
      const sameArtist = !!query.artist && creditedArtist(artist, query.artist);
      if (query.artist && !sameArtist) return;
      if (query.kind === "discover-song" && cleanTitle(title) !== cleanTitle(query.title)) return;
      const key = discoveryKey(artist, title);
      const sourceUrls = [candidate.sourceURL, candidate.sourcePageURL, candidate.importMetadata?.sourceURL, candidate.importMetadata?.sourcePageURL].filter((v): v is string => !!v);
      if (exclude.has(key) || input.taste.hiddenDiscoveries[key] || ownedKeys.has(key) || seen.has(key) || sourceUrls.some((u) => ownedUrls.has(u) || urls.has(u))) return;
      seen.add(key);
      sourceUrls.forEach((u) => urls.add(u));
      const reason = query.kind === "discover-song" ? `Listeners of ${query.because} also play this · ListenBrainz`
        : query.kind === "discover-artist" ? `Fans of ${query.because} also play ${query.artist} · ListenBrainz`
        : query.because;
      const base = query.kind === "discover-song" ? 5 + 3 * query.affinity : query.kind === "discover-artist" ? 3 + 3 * query.affinity : sameArtist ? 2 : 1;
      const score = base * reasonWeight(input.taste, query.kind) + 1 / (index + 1) - 3 * sat(penalties.get(cleanArtist(artist)) ?? 0);
      results.push({
        key, candidate, title, artist, reason, kind: query.kind, score,
        artwork: candidate.importMetadata?.artworkURL || candidate.thumbnailURL || undefined,
        provider: candidate.searchProvider ?? candidate.sourceProvider ?? "unknown",
      });
    });
  }
  const picked: typeof results = [];
  while (results.length && picked.length < limit) {
    const adjusted = (r: (typeof results)[number]) =>
      r.score
      - picked.slice(-2).filter((s) => meaningfulArtist(r.artist) && cleanArtist(s.artist) === cleanArtist(r.artist)).length * 1.2
      - picked.slice(-2).filter((s) => s.provider === r.provider).length * 0.5;
    results.sort((a, b) => adjusted(b) - adjusted(a) || a.key.localeCompare(b.key));
    const next = results.shift()!;
    if (picked.filter((s) => cleanArtist(s.artist) === cleanArtist(next.artist)).length < perArtist) picked.push(next);
  }
  return picked.map(({ score: _score, provider: _provider, ...song }) => song);
}
