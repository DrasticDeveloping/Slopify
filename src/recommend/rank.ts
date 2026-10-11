import type { Genre, Track } from "../data/types";
import { artistKey, IMPORT_WEIGHT, reasonWeight, songKey, tasteProfile, trustedGenre, type ReasonKind, type TasteInput } from "./taste";

export type RankMode = "home" | "mix" | "radio" | "autoplay";

export interface RankOptions {
  mode?: RankMode;
  /** The song radio or autoplay continues from. */
  seedId?: string;
  /** Mixes: only songs whose genre is known (the demo catalog), never guessed for imports. */
  genre?: Genre;
  exclude?: Iterable<string>;
  limit?: number;
}

export interface Recommendation {
  id: string;
  score: number;
  reason: string;
  kind: ReasonKind;
}

export interface RankInput extends TasteInput {
  trackIds: string[];
  playable: (t: Track) => boolean;
}

const sat = (n: number) => n / (n + 2);
function hash(value: string) {
  let h = 2166136261;
  for (const c of value) h = Math.imul(h ^ c.charCodeAt(0), 16777619);
  return (h >>> 0) / 4294967296;
}

/**
 * How much a song's own history counts. Home leans on what surrounds your
 * favourites, so it surfaces more than your top songs; radio and autoplay keep
 * familiar songs, which is what makes continuous listening feel right.
 */
const FAMILIAR: Record<RankMode, number> = { home: 0.5, mix: 1, radio: 1, autoplay: 1 };
const FRESH: Record<RankMode, number> = { home: 0.9, mix: 0.6, radio: 0.4, autoplay: 0.4 };
/** Signals about you rather than about the song playing. */
const PERSONAL = new Set<ReasonKind>(["liked", "saved", "enjoyed", "artist", "genre", "playlist"]);

/**
 * Ranks library songs from your taste profile. Every score is a sum of named
 * signals; the strongest one becomes the reason shown, and each signal is
 * weighted by how often you have kept suggestions of that kind. A greedy pass
 * then spaces out artists and genres and reserves every fifth slot for a song
 * you have not played yet.
 */
export function recommend(input: RankInput, options: RankOptions = {}): Recommendation[] {
  const { tracks, artists, taste } = input;
  const { mode = "home", genre, limit = 20 } = options;
  const p = tasteProfile(input);
  const now = p.now;
  const seed = options.seedId && tracks[options.seedId] ? tracks[options.seedId] : undefined;
  const excluded = new Set(options.exclude ?? []);
  const seeded = Boolean(seed) && (mode === "radio" || mode === "autoplay");
  if (seeded) excluded.add(seed!.id);

  // What the next song should fit. Radio and autoplay follow only their seed, so earlier listening cannot pull
  // the station elsewhere; other lists fit the seed first, then what you just played.
  const context = seeded ? [seed!.id] : seed ? [seed.id, ...p.recent.filter((id) => id !== seed.id)] : p.recent;
  const lead = context[0] ? tracks[context[0]] : undefined;
  const title = (t: Track | undefined) => (t ? `“${t.title}”` : "");
  const keyOf = (t: Track) => songKey(artists[t.artistId]?.name, t.title);
  const maxSupport = Math.max(1, ...p.support.values());
  const weight = (kind: ReasonKind) => reasonWeight(taste, kind);
  const familiar = FAMILIAR[mode];

  const linkSources = seed ? [[keyOf(seed), 1, seed] as const] : [...p.support].map(([id, s]) => [keyOf(tracks[id]), s / maxSupport, tracks[id]] as const);
  const sharedPlaylist = (a: string, b: string) => a !== b && (p.memberships.get(a) ?? []).some((pid) => p.memberships.get(b)?.includes(pid));
  const playlistName = (pid: string) => input.playlists.find((pl) => pl.id === pid)?.name ?? "your playlist";

  const scored = [...new Set(input.trackIds)].flatMap((id) => {
    const t = tracks[id];
    if (!t || excluded.has(id) || taste.hidden[id] || !input.playable(t)) return [];
    const g = trustedGenre(t, artists);
    if (genre && g !== genre) return [];
    const artist = artistKey(t, artists);
    const artistName = artists[t.artistId]?.name ?? "";
    const support = p.support.get(id) ?? 0;
    const signals: Array<[ReasonKind, number, string]> = [];

    if (p.liked.has(id)) signals.push(["liked", 3 * familiar, "You liked this"]);
    const saved = p.memberships.get(id);
    if (saved) signals.push(["saved", 2 * familiar, `In your playlist “${playlistName(saved[0])}”`]);
    const listened = support - (p.liked.has(id) ? 3 : 0) - (saved ? 2 : 0) - (p.imported.has(id) ? IMPORT_WEIGHT : 0);
    if (listened > 0) signals.push(["enjoyed", 3 * familiar * sat(listened), "A song you keep coming back to"]);
    if (artist) {
      // Your love for this artist, minus this song's own part in it.
      const others = (p.artists.get(artist) ?? 0) - support;
      if (others > 0) signals.push(["artist", 2 * sat(others), `Because you play ${artistName}`]);
    }
    if (g && p.genres.get(g)) signals.push(["genre", sat(p.genres.get(g)!), `Because you like ${g}`]);
    const neighbours = (saved ?? []).reduce((n, pid) => n + (p.playlistSupport.get(pid) ?? 0), 0) - (saved && support ? saved.length : 0);
    if (neighbours > 0) signals.push(["playlist", 1.5 * Math.min(1, neighbours / 2), `Fits your playlist “${playlistName(saved![0])}”`]);

    let followed = 0;
    if (lead) {
      followed = p.after.get(lead.id)?.get(id) ?? 0;
      if (followed > 0) signals.push(["after", 2.5 * sat(followed * 2), `You often play this after ${title(lead)}`]);
      else if (followed < 0) signals.push(["after", -1.5 * sat(-followed * 2), ""]);
    }

    let best = 0;
    let match: Track | undefined;
    context.forEach((otherId, i) => {
      const other = tracks[otherId];
      if (!other || otherId === id) return;
      const relation = Math.max(artist && artist === artistKey(other, artists) ? 1 : 0, sharedPlaylist(id, otherId) ? 0.8 : 0, g && g === trustedGenre(other, artists) ? 0.35 : 0);
      const value = relation * (i === 0 ? 1 : 0.7);
      if (value > best) [best, match] = [value, other];
    });
    if (best > 0) signals.push(["similar", 2 * best, seed ? `Like ${title(match)}` : `Goes with ${title(match)}`]);

    const key = keyOf(t);
    let linked = 0;
    let linkedFrom: Track | undefined;
    for (const [from, share, source] of linkSources) {
      const value = (p.links.get(from)?.get(key) ?? 0) * share;
      if (value > linked) [linked, linkedFrom] = [value, source];
    }
    if (linked > 0) signals.push(["linked", 3 * linked, `Listeners of ${title(linkedFrom)} also play this · ListenBrainz`]);

    // Radio and autoplay follow the seed: your favourites only count in full when they fit it,
    // so an unrelated saved song never jumps ahead of one that sounds like what was playing.
    const relevance = Math.max(best, followed > 0 ? 1 : 0, Math.min(1, linked));
    const personalScale = seeded ? 0.3 + 0.7 * relevance : 1;
    let score = 0;
    let top: [ReasonKind, number, string] | null = null;
    for (const signal of signals) {
      const value = signal[1] * weight(signal[0]) * (PERSONAL.has(signal[0]) ? personalScale : 1);
      score += value;
      if (signal[2] && value > (top?.[1] ?? 0.3)) top = [signal[0], value, signal[2]];
    }
    // Not yet heard: being imported alone does not make a song familiar.
    const fresh = support - (p.imported.has(id) ? IMPORT_WEIGHT : 0) <= 0 && !p.fatigue.has(id);
    if (fresh) score += FRESH[mode] * weight("fresh");
    score -= 4 * sat(p.skips.get(id) ?? 0) + 1.5 * sat(p.fatigue.get(id) ?? 0);
    // A small tie-break that holds for the day, so the shelf is stable but not frozen.
    score += hash(`${Math.floor(now / 86_400_000)}:${mode}:${genre ?? ""}:${id}`) * 0.15;
    const fallback: [ReasonKind, number, string] = ["fresh", 0, fresh ? "Something new from your library" : "From your library"];
    const [kind, , reason] = top ?? fallback;
    return [{ id, score, reason, kind, artist, genre: g, fresh }];
  });

  // Songs from the last few plays sit out, unless the library is too small to fill the list without them.
  const justPlayed = new Set(p.recent.slice(0, 3));
  const rested = scored.filter((c) => !justPlayed.has(c.id));
  const pool = rested.length >= Math.min(limit, scored.length) ? rested : scored;
  const picked: typeof scored = [];
  while (pool.length && picked.length < limit) {
    const explore = picked.length % 5 === 4 && pool.some((c) => c.fresh);
    const adjusted = (c: (typeof pool)[number]) =>
      c.score
      - (c.artist ? picked.slice(-2).filter((s) => s.artist === c.artist).length * 2.5 : 0)
      - (!genre && c.genre ? picked.slice(-3).filter((s) => s.genre === c.genre).length * 0.7 : 0);
    let best = -1;
    for (let i = 0; i < pool.length; i++) {
      if (explore && !pool[i].fresh) continue;
      if (best < 0 || adjusted(pool[i]) > adjusted(pool[best]) || (adjusted(pool[i]) === adjusted(pool[best]) && pool[i].id < pool[best].id)) best = i;
    }
    picked.push(pool.splice(best, 1)[0]);
  }
  return picked.map(({ id, score, reason, kind }) => ({ id, score, reason, kind }));
}

/** True once there is any deliberate signal to personalise from. */
export function hasTaste(input: TasteInput) {
  return tasteProfile(input).hasTaste;
}
