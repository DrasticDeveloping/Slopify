import { useSyncExternalStore } from "react";
import { hashString } from "../data/library";
import { canStream, streamTrackId } from "../state/importer";
import { getState } from "../state/store";
import { type DiscoveredSong } from "./discover";
import { ownedCopies, ownedIndex } from "./owned";
import { discover, interleave, seedsForIds, trackKey } from "./service";
import { qualified, tasteProfile } from "./taste";

/*
 * "Made for you" mixes. Each is an edition kept in localStorage until it
 * expires, so a mix stays the same across visits and reloads. Editions are made
 * when the app opens (prepareMixes), one after another, and no new song appears
 * in two mixes:
 *  - Daily Mix 1–3: songs by three of your artists, with new songs by related
 *    artists mixed in. New editions each local midnight.
 *  - Discover Weekly: 30 new songs across your taste. New edition each Monday.
 *  - On Repeat: your most-played songs over the last two weeks. Updated daily.
 */

export interface Mix {
  id: string;
  name: string;
  description: string;
  kind: "daily" | "weekly" | "repeat";
  /** When this edition started (ISO date). */
  edition: string;
  expires: number;
  /** Library songs in the mix. */
  libraryIds: string[];
  /** Library songs new songs are found from. */
  seedIds: string[];
  /** New songs found for this edition. */
  songs: DiscoveredSong[];
  /** Song ids or song keys hidden from this mix only. */
  hidden: string[];
  /** Whether new songs have been found for this edition (or it needs none). */
  complete: boolean;
  note?: string;
}

const STORAGE_KEY = "slopify.mix-editions.v1";
const MAX_SONGS = 30;
const DAY = 86_400_000;

/* ───────────────────────── stored editions ───────────────────────── */

const isSong = (s: DiscoveredSong) => s && typeof s.key === "string" && typeof s.artist === "string" && typeof s.title === "string" && typeof s.candidate?.sourceURL === "string";
const isMix = (m: Mix) =>
  m && typeof m.id === "string" && ["daily", "weekly", "repeat"].includes(m.kind) && typeof m.expires === "number"
  && Array.isArray(m.libraryIds) && Array.isArray(m.seedIds) && Array.isArray(m.hidden) && Array.isArray(m.songs);

function load(): Mix[] {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "[]");
    if (!Array.isArray(raw)) return [];
    return raw
      .filter((m: Mix) => isMix(m) && m.expires > Date.now())
      .slice(0, 5)
      .map((m: Mix) => ({ ...m, songs: m.songs.filter(isSong).slice(0, MAX_SONGS) }));
  } catch {
    // A corrupt edition never prevents startup; new ones are made.
    return [];
  }
}

let mixes = load();
const listeners = new Set<() => void>();

function publish(next: Mix[]) {
  mixes = next;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(mixes));
  } catch {
    // Editions still work for this session.
  }
  listeners.forEach((l) => l());
}
const update = (id: string, change: (m: Mix) => Partial<Mix>) => publish(mixes.map((m) => (m.id === id ? { ...m, ...change(m) } : m)));

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => void listeners.delete(listener);
};
export const useMixes = () => useSyncExternalStore(subscribe, () => mixes);
export const getMix = (id: string) => mixes.find((m) => m.id === id);
/** A stable artwork seed for a mix. */
export const mixSeed = (mix: Mix) => hashString(mix.id);

export function hideFromMix(id: string, key: string) {
  update(id, (m) => ({ hidden: [...new Set([...m.hidden, key])] }));
}

/* ───────────────────────── playing a mix ───────────────────────── */

/** The mix's new songs, without ones hidden from it or dismissed everywhere. */
export function mixSongs(mix: Mix) {
  const hiddenEverywhere = getState().taste.hiddenDiscoveries;
  return mix.songs.filter((song) => !mix.hidden.includes(song.key) && !hiddenEverywhere[song.key]);
}

/** The mix as track ids: its library songs with a new song after every two. Its new songs must be registered as streams to play. */
export function mixIds(mix: Mix) {
  const s = getState();
  const hiddenHere = (id: string) => mix.hidden.includes(id) || Boolean(s.taste.hidden[id]);
  const library = mix.libraryIds.filter((id) => s.tracks[id] && !hiddenHere(id) && !s.taste.hiddenDiscoveries[trackKey(s, id)]);
  const owned = ownedIndex(s);
  const fresh: string[] = [];
  for (const song of mixSongs(mix)) {
    const copies = ownedCopies(owned, song);
    // A new song saved since this edition plays as the library copy; hiding any copy hides it here.
    if (copies.some(hiddenHere)) continue;
    if (copies.length) fresh.push(copies[0]);
    else if (canStream(song.candidate)) fresh.push(streamTrackId(song.key));
  }
  return [...new Set(interleave(library, fresh))].slice(0, MAX_SONGS);
}

/* ───────────────────────── editions ───────────────────────── */

function boundaries(now: Date) {
  const today = new Date(now);
  today.setHours(0, 0, 0, 0);
  const tomorrow = new Date(today);
  tomorrow.setDate(today.getDate() + 1);
  const monday = new Date(today);
  monday.setDate(today.getDate() - ((today.getDay() + 6) % 7));
  const nextMonday = new Date(monday);
  nextMonday.setDate(monday.getDate() + 7);
  return { day: today.toISOString(), dayEnds: tomorrow.getTime(), week: monday.toISOString(), weekEnds: nextMonday.getTime() };
}

const fresh = (mix: Omit<Mix, "songs" | "hidden" | "complete">, complete = false): Mix => ({ ...mix, songs: [], hidden: [], complete });

/** The mixes the library supports today, as new (empty) editions. */
function plannedMixes(now: Date): Mix[] {
  const s = getState();
  const profile = tasteProfile(s, now.getTime());
  const { day, dayEnds, week, weekEnds } = boundaries(now);
  // Library songs, best supported first.
  const ids = s.trackIds
    .filter((id) => s.tracks[id] && !s.tracks[id].stream && !s.taste.hidden[id])
    .sort((a, b) => (profile.support.get(b) ?? 0) - (profile.support.get(a) ?? 0) || a.localeCompare(b));
  const planned: Mix[] = [];

  // Up to three daily mixes of three artists each, in order of support.
  const artists = [...new Set(ids.map((id) => s.tracks[id].artistId))];
  for (let n = 0; n < Math.min(3, Math.ceil(artists.length / 3)); n++) {
    const group = artists.slice(n * 3, n * 3 + 3);
    const pool = ids.filter((id) => group.includes(s.tracks[id].artistId));
    planned.push(fresh({
      id: `daily-${n + 1}`,
      name: `Daily Mix ${n + 1}`,
      description: group.map((id) => s.artists[id]?.name).filter(Boolean).join(", "),
      kind: "daily",
      edition: day,
      expires: dayEnds,
      libraryIds: pool.slice(0, 21),
      seedIds: pool,
    }));
  }

  planned.push(fresh({ id: "weekly", name: "Discover Weekly", description: "New songs across your taste. A fresh edition every Monday.", kind: "weekly", edition: week, expires: weekEnds, libraryIds: [], seedIds: ids }));

  const plays = new Map<string, number>();
  const library = new Set(ids);
  for (const l of s.taste.listens) {
    if (qualified(l) && l.at > now.getTime() - 14 * DAY && library.has(l.trackId)) plays.set(l.trackId, (plays.get(l.trackId) ?? 0) + 1);
  }
  const repeat = [...plays]
    .sort((a, b) => b[1] - a[1] || (profile.touched.get(b[0]) ?? 0) - (profile.touched.get(a[0]) ?? 0))
    .map(([id]) => id)
    .slice(0, MAX_SONGS);
  if (repeat.length) {
    planned.push(fresh({ id: "repeat", name: "On Repeat", description: "Your most-heard songs over the last two weeks. Updated daily.", kind: "repeat", edition: day, expires: dayEnds, libraryIds: repeat, seedIds: [] }, true));
  }
  return planned;
}

/**
 * Starts any edition that is due. A current edition stays as it is, except that
 * one still waiting for its new songs follows library changes until its search starts.
 */
export function ensureMixes(now = new Date()) {
  const next = mixes.filter((m) => m.expires > now.getTime());
  for (const plan of plannedMixes(now)) {
    const index = next.findIndex((m) => m.id === plan.id);
    if (index < 0) next.push(plan);
    else if (!next[index].complete && !filling.has(plan.id)) {
      next[index] = { ...next[index], description: plan.description, seedIds: plan.seedIds, libraryIds: plan.libraryIds };
    }
  }
  if (JSON.stringify(next) !== JSON.stringify(mixes)) publish(next);
}

/* ───────────────────────── finding new songs ───────────────────────── */

const filling = new Map<string, Promise<void>>();
/** When a mix's search last failed; it's tried again after a while, not on every check. */
const failedAt = new Map<string, number>();
const RETRY_AFTER = 10 * 60_000;
let preparing: Promise<void> | null = null;

/**
 * Makes today's mixes in the background: starts any edition that's due, then
 * finds each one's new songs in turn (Daily Mixes first). Called when the app
 * opens and then every minute, so a mix is ready before it's opened.
 */
export function prepareMixes(now = new Date()): Promise<void> {
  ensureMixes(now);
  if (preparing) return preparing;
  preparing = (async () => {
    for (const mix of [...mixes].sort((a, b) => a.id.localeCompare(b.id))) {
      if (mix.complete || Date.now() - (failedAt.get(`${mix.id}|${mix.edition}`) ?? 0) < RETRY_AFTER) continue;
      await fillMix(mix.id);
    }
  })().finally(() => {
    preparing = null;
  });
  return preparing;
}

/** Finds the new songs for a mix's current edition, once. */
export function fillMix(id: string): Promise<void> {
  const running = filling.get(id);
  if (running) return running;
  const mix = getMix(id);
  if (!mix || mix.complete) return Promise.resolve();
  if (mix.kind === "weekly" && !mix.seedIds.length) {
    update(id, () => ({ note: "Import, like or play songs to build your first weekly edition." }));
    return Promise.resolve();
  }
  const task = findSongs(mix).finally(() => filling.delete(id));
  filling.set(id, task);
  return task;
}

async function findSongs(mix: Mix) {
  // A daily mix is about 3 new songs to every 7 familiar ones; the weekly is all new.
  const target = mix.kind === "daily" ? Math.min(9, Math.round((mix.libraryIds.length * 3) / 7)) : MAX_SONGS;
  // The weekly spreads its searches over up to three sets of seeds, so one artist doesn't dominate.
  const rounds = mix.kind === "weekly" ? Math.min(3, Math.max(1, Math.ceil(mix.seedIds.length / 5))) : 1;
  const sameEdition = (m: Mix) => m.id === mix.id && m.edition === mix.edition;
  // Songs already in the other mixes stay out of this one, so each mix is its own.
  const taken = new Set(mixes.filter((m) => m.id !== mix.id).flatMap((m) => m.songs.map((song) => song.key)));
  const songs: DiscoveredSong[] = [];
  let note = "";
  try {
    for (let n = 0; n < rounds && songs.length < target; n++) {
      const result = await discover({
        seeds: seedsForIds(mix.seedIds, n * 5),
        signal: AbortSignal.timeout(90_000),
        limit: target - songs.length,
        budget: Math.floor(48 / rounds),
        exclude: new Set([...taken, ...songs.map((song) => song.key)]),
      });
      songs.push(...result.songs);
      note = result.note;
    }
    // A mix filled at the same time (one opened while the others were being made) may have taken some meanwhile.
    const takenNow = new Set(mixes.filter((m) => m.id !== mix.id).flatMap((m) => m.songs.map((song) => song.key)));
    songs.splice(0, songs.length, ...songs.filter((song) => !takenNow.has(song.key)));
    publish(mixes.map((m) => {
      if (!sameEdition(m)) return m;
      // Fewer new songs than planned keep the daily mix's familiar-to-new balance.
      const libraryIds = m.kind === "daily" && songs.length ? m.libraryIds.slice(0, Math.round((songs.length * 7) / 3)) : m.libraryIds;
      return { ...m, libraryIds, songs: songs.slice(0, target), complete: true, note };
    }));
  } catch {
    failedAt.set(`${mix.id}|${mix.edition}`, Date.now());
    publish(mixes.map((m) => (sameEdition(m) ? { ...m, songs, note: "Couldn't finish this edition. Open it again to retry." } : m)));
  }
}
