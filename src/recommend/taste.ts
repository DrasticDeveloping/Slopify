import type { Artist, Genre, Playlist, Track } from "../data/types";

/*
 * What Slopify knows about your taste, and the one profile every recommendation
 * surface reads from. Only deliberate signals count: likes and playlist saves made
 * in the app, and songs actually heard (measured by the engine, so seeking or a
 * muted tab cannot fake a listen). Generated demo play counts and starter
 * playlists never count. Everything stays in this browser.
 */

const DAY = 86_400_000;

/** Why a song was suggested. Also the unit the recommender learns over: kinds you keep take more weight. */
export type ReasonKind =
  | "liked" | "saved" | "enjoyed" | "artist" | "genre" | "playlist" | "after" | "similar" | "linked" | "fresh"
  | "discover-song" | "discover-artist" | "discover-search";

export interface Listen {
  /** One per playback occurrence; progress saves update it in place. */
  id: string;
  trackId: string;
  at: number;
  /** Seconds actually heard (playing, audible, at normal pace). */
  heard: number;
  /** Seconds of the song covered, counting each part once. */
  covered: number;
  /** Length of the playable range (the clip, or the whole song). */
  span: number;
  end: "playing" | "finished" | "skipped" | "changed" | "error";
  /** The recommendation that started it, if any. */
  via?: ReasonKind;
}

/** A public "listeners of A also play B" edge between two songs (ListenBrainz). */
export interface SongLink { from: string; to: string; affinity: number; at: number }

export interface TasteState {
  version: 2;
  /** Bumps only when something that can move recommendations changes, not on every progress save. */
  rev: number;
  /** Newest first. */
  listens: Listen[];
  /** When each song was liked in the app. Counts only while the song is still in Liked Songs. */
  likes: Record<string, number>;
  /** When each song was added to each of your playlists. Counts only while it is still there. */
  saves: Record<string, Record<string, number>>;
  hidden: Record<string, number>;
  /** Outside-library suggestions dismissed, keyed by `songKey`. */
  hiddenDiscoveries: Record<string, number>;
  /** Kept / rejected counts per reason kind. */
  reasons: Partial<Record<ReasonKind, [number, number]>>;
  links: SongLink[];
}

export const emptyTaste = (rev = 0): TasteState => ({ version: 2, rev, listens: [], likes: {}, saves: {}, hidden: {}, hiddenDiscoveries: {}, reasons: {}, links: [] });

const MAX_LISTENS = 500;
const MAX_LINKS = 150;
const KEEP_FOR = 180 * DAY;
const LINKS_FOR = DAY;

/* ───────────────────────── identity ───────────────────────── */

export const normalize = (v: string | null | undefined) => (v ?? "").normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim();
const PLACEHOLDERS = new Set(["unknown", "unknown artist", "unknown uploader", "local files", "various artists"]);
/** A real artist name, not a placeholder that would lump unrelated songs together. */
export const meaningfulArtist = (name: string | null | undefined) => !!normalize(name) && !PLACEHOLDERS.has(normalize(name));
/** One song across services and re-imports: artist + title, keeping live/remix qualifiers. */
export const songKey = (artist: string | null | undefined, title: string | null | undefined) => `${normalize(artist)}|${normalize(title)}`;
/** Songs imported from the web or from files; their genre is decoration, not evidence. */
export const isImported = (t: Track) => !t.stream && Boolean(t.mediaUrl || t.fileUrl);
export const trustedGenre = (t: Track, artists: Record<string, Artist>): Genre | undefined => (isImported(t) ? undefined : artists[t.artistId]?.genre);
export function artistKey(t: Track, artists: Record<string, Artist>) {
  const name = artists[t.artistId]?.name;
  return meaningfulArtist(name) ? normalize(name) : undefined;
}

/* ───────────────────────── listening ───────────────────────── */

/** A listen that says "I like this": five audible seconds plus 30 seconds or most of the song. */
export const qualified = (l: Listen) => l.heard >= 5 && (l.heard >= 30 || l.covered / l.span >= 0.6);
/** Next pressed after a few seconds: a "not this" signal. Under two seconds is treated as flicking past. */
export const earlySkip = (l: Listen) => l.end === "skipped" && l.heard >= 2 && l.heard < 15 && l.covered / l.span < 0.25;
const verdict = (l: Listen | undefined) => (!l ? 0 : qualified(l) ? 1 : earlySkip(l) ? -1 : 0);

/**
 * Turns engine progress samples into heard/covered seconds. Seeks, pauses, rate and
 * range changes reset the anchor, and implausible jumps (throttled background tabs,
 * stalls) earn nothing, so the numbers only ever undercount.
 */
export class ListeningCollector {
  private anchor: { position: number; clock: number; audible: boolean } | null = null;
  private parts: Array<[number, number]> = [];
  listen: Listen | null = null;

  start(listen: Listen) {
    this.listen = { ...listen };
    this.parts = [];
    this.anchor = null;
  }

  clear() {
    this.listen = null;
    this.parts = [];
    this.anchor = null;
  }

  resetAnchor() {
    this.anchor = null;
  }

  sample(position: number, clock: number, rate: number, audible: boolean) {
    const prev = this.anchor;
    this.anchor = { position, clock, audible };
    if (!this.listen || !prev || !prev.audible || !audible || rate <= 0) return;
    const elapsed = (clock - prev.clock) / 1000;
    const moved = position - prev.position;
    if (elapsed <= 0 || elapsed > 2 || moved <= 0 || moved > elapsed * rate * 1.3 + 0.1) return;
    this.listen.heard += Math.min(elapsed, moved / rate);
    this.parts.push([prev.position, position]);
    this.parts.sort((a, b) => a[0] - b[0]);
    const merged: Array<[number, number]> = [];
    for (const part of this.parts) {
      const last = merged.at(-1);
      if (last && part[0] <= last[1] + 0.001) last[1] = Math.max(last[1], part[1]);
      else merged.push([...part]);
    }
    this.parts = merged;
    this.listen.covered = Math.min(this.listen.span, merged.reduce((sum, [a, b]) => sum + b - a, 0));
  }
}

/* ───────────────────────── updates ───────────────────────── */

/** Counts a kept (hit) or rejected suggestion of this kind. Old evidence halves so taste can change. */
export function countReason(t: TasteState, kind: ReasonKind | undefined, hit: boolean): TasteState {
  if (!kind) return t;
  let [kept, rejected] = t.reasons[kind] ?? [0, 0];
  if (kept + rejected >= 40) [kept, rejected] = [kept / 2, rejected / 2];
  return { ...t, rev: t.rev + 1, reasons: { ...t.reasons, [kind]: hit ? [kept + 1, rejected] : [kept, rejected + 1] } };
}

/** Saves a listen (new or in progress). Only a change in what it says about taste bumps `rev`. */
export function recordListen(t: TasteState, listen: Listen): TasteState {
  const before = verdict(t.listens.find((l) => l.id === listen.id));
  const after = verdict(listen);
  const next: TasteState = { ...t, listens: [listen, ...t.listens.filter((l) => l.id !== listen.id && l.at > listen.at - KEEP_FOR)].slice(0, MAX_LISTENS) };
  if (before === after) return next;
  // countReason bumps `rev` itself; ordinary listens (no recommendation behind them) still move recommendations.
  return after && listen.via ? countReason(next, listen.via, after > 0) : { ...next, rev: next.rev + 1 };
}

export function noteLikes(t: TasteState, ids: string[], at = Date.now()): TasteState {
  if (!ids.length) return t;
  return { ...t, rev: t.rev + 1, likes: { ...t.likes, ...Object.fromEntries(ids.map((id) => [id, at])) } };
}

export function noteSaves(t: TasteState, playlistId: string, ids: string[], at = Date.now()): TasteState {
  if (!ids.length || playlistId === "liked") return t;
  const saves = { ...t.saves };
  for (const id of ids) saves[id] = { ...saves[id], [playlistId]: at };
  return { ...t, rev: t.rev + 1, saves };
}

export function setLinks(t: TasteState, links: SongLink[], now = Date.now()): TasteState {
  const replaced = new Set(links.map((l) => l.from));
  return { ...t, rev: t.rev + 1, links: [...links, ...t.links.filter((l) => !replaced.has(l.from) && l.at > now - LINKS_FOR)].slice(0, MAX_LINKS) };
}

/* ───────────────────────── persistence ───────────────────────── */

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const ENDS = new Set(["playing", "finished", "skipped", "changed", "error"]);
const KINDS = new Set<string>(["liked", "saved", "enjoyed", "artist", "genre", "playlist", "after", "similar", "linked", "fresh", "discover-song", "discover-artist", "discover-search"]);

/** Validates saved taste (it is untrusted) and drops songs that are no longer in `ids`. */
export function restoreTaste(value: unknown, ids: ReadonlySet<string>, now = Date.now()): TasteState {
  const t = emptyTaste();
  if (!isObject(value) || value.version !== 2) return t;
  const time = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v > 0 && v <= now + 60_000;
  const stamps = (v: unknown, keep: (key: string) => boolean) =>
    isObject(v) ? (Object.fromEntries(Object.entries(v).filter(([k, at]) => keep(k) && time(at))) as Record<string, number>) : {};
  t.rev = typeof value.rev === "number" && Number.isFinite(value.rev) ? value.rev : 0;
  t.likes = stamps(value.likes, (id) => ids.has(id));
  t.hidden = stamps(value.hidden, (id) => ids.has(id));
  t.hiddenDiscoveries = stamps(value.hiddenDiscoveries, (key) => key.length <= 500);
  if (isObject(value.saves)) {
    for (const [id, memberships] of Object.entries(value.saves)) {
      const kept = ids.has(id) ? stamps(memberships, (pid) => pid !== "liked") : {};
      if (Object.keys(kept).length) t.saves[id] = kept;
    }
  }
  if (Array.isArray(value.listens)) {
    const seen = new Set<string>();
    for (const l of value.listens as unknown[]) {
      if (!isObject(l) || typeof l.id !== "string" || seen.has(l.id) || typeof l.trackId !== "string" || !ids.has(l.trackId)) continue;
      if (!time(l.at) || l.at < now - KEEP_FOR || !ENDS.has(String(l.end))) continue;
      const seconds = [l.heard, l.covered, l.span];
      if (!seconds.every((n) => typeof n === "number" && Number.isFinite(n) && n >= 0 && n <= 86_400) || (l.span as number) <= 0) continue;
      seen.add(l.id);
      t.listens.push({ id: l.id, trackId: l.trackId, at: l.at, heard: l.heard as number, covered: l.covered as number, span: l.span as number, end: l.end as Listen["end"], ...(KINDS.has(String(l.via)) ? { via: l.via as ReasonKind } : {}) });
      if (t.listens.length === MAX_LISTENS) break;
    }
  }
  if (isObject(value.reasons)) {
    for (const [kind, pair] of Object.entries(value.reasons)) {
      if (KINDS.has(kind) && Array.isArray(pair) && pair.length === 2 && pair.every((n) => typeof n === "number" && Number.isFinite(n) && n >= 0 && n <= 1000)) {
        t.reasons[kind as ReasonKind] = [pair[0], pair[1]];
      }
    }
  }
  if (Array.isArray(value.links)) {
    t.links = (value.links as unknown[]).filter((l): l is SongLink =>
      isObject(l) && typeof l.from === "string" && l.from.length <= 600 && typeof l.to === "string" && l.to.length <= 600 &&
      time(l.at) && l.at > now - LINKS_FOR && typeof l.affinity === "number" && l.affinity > 0 && l.affinity <= 1,
    ).slice(0, MAX_LINKS);
  }
  return t;
}

/* ───────────────────────── the profile ───────────────────────── */

export interface TasteInput {
  tracks: Record<string, Track>;
  artists: Record<string, Artist>;
  playlists: Playlist[];
  taste: TasteState;
}

export interface Profile {
  now: number;
  /** Positive evidence per song: likes, saves, and decayed listening. */
  support: Map<string, number>;
  /** When each song last earned support, for tie-breaks. */
  touched: Map<string, number>;
  liked: Set<string>;
  /** Songs you brought in yourself (web or file imports): choosing a song is a taste signal too. */
  imported: Set<string>;
  /** Your playlists each song is deliberately in. */
  memberships: Map<string, string[]>;
  /** How many supported songs each of your playlists holds. */
  playlistSupport: Map<string, number>;
  /** Decayed early skips per song. */
  skips: Map<string, number>;
  /** Decayed recent plays per song, so favourites rest between plays. */
  fatigue: Map<string, number>;
  artists: Map<string, number>;
  genres: Map<Genre, number>;
  /** Songs heard in the last two hours, newest first. */
  recent: string[];
  /** Your own sequences: after[a][b] grows each time b is kept right after a, and shrinks when b is skipped. */
  after: Map<string, Map<string, number>>;
  /** ListenBrainz edges by song key. */
  links: Map<string, Map<string, number>>;
  hasTaste: boolean;
}

/** Support an imported song gets just for being imported. */
export const IMPORT_WEIGHT = 1;
const decay = (at: number, now: number, halfLifeDays: number) => 2 ** (-Math.max(0, now - at) / DAY / halfLifeDays);
const add = <K>(map: Map<K, number>, key: K, value: number) => map.set(key, (map.get(key) ?? 0) + value);

let cached: { input: TasteInput; at: number; profile: Profile } | null = null;

/** The profile for the current state. Recomputed when the inputs change, or once a minute for decay. */
export function tasteProfile(input: TasteInput, now = Date.now()): Profile {
  const c = cached;
  if (c && c.input.taste === input.taste && c.input.tracks === input.tracks && c.input.artists === input.artists && c.input.playlists === input.playlists && now - c.at < 60_000) return c.profile;
  const profile = buildProfile(input, now);
  cached = { input, at: now, profile };
  return profile;
}

function buildProfile({ tracks, artists, playlists, taste }: TasteInput, now: number): Profile {
  const support = new Map<string, number>();
  const touched = new Map<string, number>();
  const touch = (id: string, at: number) => touched.set(id, Math.max(touched.get(id) ?? 0, at));

  // Importing a song is a deliberate choice. It counts a little (1), less than a like or a save,
  // so an imported playlist steers discovery even before anything is played.
  const imported = new Set<string>();
  for (const t of Object.values(tracks)) {
    if (!isImported(t)) continue;
    imported.add(t.id);
    add(support, t.id, IMPORT_WEIGHT);
    touch(t.id, t.addedAt);
  }

  // Likes and saves count only while they still hold.
  const likedList = new Set(playlists.find((p) => p.id === "liked")?.trackIds ?? []);
  const liked = new Set<string>();
  for (const [id, at] of Object.entries(taste.likes)) {
    if (!tracks[id] || !likedList.has(id)) continue;
    liked.add(id);
    add(support, id, 3);
    touch(id, at);
  }
  const mine = new Map(playlists.filter((p) => !p.system).map((p) => [p.id, new Set(p.trackIds)]));
  const memberships = new Map<string, string[]>();
  for (const [id, saves] of Object.entries(taste.saves)) {
    if (!tracks[id]) continue;
    const held = Object.entries(saves).filter(([pid]) => mine.get(pid)?.has(id));
    if (!held.length) continue;
    memberships.set(id, held.map(([pid]) => pid));
    add(support, id, 2);
    touch(id, Math.max(...held.map(([, at]) => at)));
  }

  // Listening: a 30-day half-life, at most three listens per song per day.
  const skips = new Map<string, number>();
  const fatigue = new Map<string, number>();
  const perDay = new Map<string, number>();
  const recent: string[] = [];
  for (const l of taste.listens) {
    if (!tracks[l.trackId]) continue;
    if (qualified(l)) {
      const day = `${l.trackId}:${Math.floor(l.at / DAY)}`;
      const count = perDay.get(day) ?? 0;
      perDay.set(day, count + 1);
      if (count < 3) add(support, l.trackId, decay(l.at, now, 30) * (l.covered / l.span >= 0.8 ? 1.5 : 1));
      touch(l.trackId, l.at);
      if (l.at > now - 2 * 3_600_000 && recent.length < 5 && !recent.includes(l.trackId)) recent.push(l.trackId);
    }
    if (earlySkip(l)) add(skips, l.trackId, decay(l.at, now, 7));
    if (l.heard >= 5 && l.at > now - 3 * DAY) add(fatigue, l.trackId, decay(l.at, now, 1));
  }

  // Sequences from your own sessions: consecutive listens less than 30 minutes apart.
  const after = new Map<string, Map<string, number>>();
  const chronological = taste.listens.filter((l) => tracks[l.trackId]).reverse();
  for (let i = 1; i < chronological.length; i++) {
    const a = chronological[i - 1];
    const b = chronological[i];
    if (a.trackId === b.trackId || a.heard < 5 || b.at - a.at > 30 * 60_000) continue;
    const sign = verdict(b);
    if (!sign) continue;
    const row = after.get(a.trackId) ?? new Map<string, number>();
    add(row, b.trackId, (sign > 0 ? 1 : -0.6) * decay(b.at, now, 60));
    after.set(a.trackId, row);
  }

  const playlistSupport = new Map<string, number>();
  const artistSupport = new Map<string, number>();
  const genres = new Map<Genre, number>();
  for (const [id, weight] of support) {
    if (taste.hidden[id]) continue;
    const t = tracks[id];
    for (const pid of memberships.get(id) ?? []) add(playlistSupport, pid, 1);
    const artist = artistKey(t, artists);
    if (artist) add(artistSupport, artist, weight);
    const genre = trustedGenre(t, artists);
    if (genre) add(genres, genre, weight);
  }

  const links = new Map<string, Map<string, number>>();
  for (const l of taste.links) {
    if (l.at <= now - LINKS_FOR) continue;
    const row = links.get(l.from) ?? new Map<string, number>();
    row.set(l.to, Math.max(row.get(l.to) ?? 0, l.affinity));
    links.set(l.from, row);
  }

  return { now, support, touched, liked, imported, memberships, playlistSupport, skips, fatigue, artists: artistSupport, genres, recent, after, links, hasTaste: support.size > 0 };
}

/**
 * How much weight a kind of suggestion has earned: 1 with no evidence, moving
 * between 0.5 and 1.5 as you keep or reject that kind (a Beta(2,2) prior, so a
 * handful of plays nudges it and only a consistent pattern moves it far).
 */
export function reasonWeight(t: TasteState, kind: ReasonKind) {
  const [kept, rejected] = t.reasons[kind] ?? [0, 0];
  return 0.5 + (kept + 2) / (kept + rejected + 4);
}
