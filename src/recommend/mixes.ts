import { useSyncExternalStore } from "react";
import { hashString } from "../data/library";
import { getState } from "../state/store";
import { qualified, tasteProfile } from "./taste";
import { discoveryKey, type DiscoveredSong } from "./discover";
import { discover, seedsForIds } from "./service";
import { canStream, registerStreams, streamTrackId } from "../state/importer";

export interface Mix {
  id: string;
  name: string;
  description: string;
  kind: "daily" | "weekly" | "repeat";
  edition: string;
  expires: number;
  libraryIds: string[];
  seedIds: string[];
  songs: DiscoveredSong[];
  hidden: string[];
  complete: boolean;
  note?: string;
}
const KEY = "slopify.mix-editions.v1";
const listeners = new Set<() => void>();
let mixes: Mix[] = [];
try {
  const raw: unknown = JSON.parse(localStorage.getItem(KEY) ?? "[]");
  if (Array.isArray(raw)) mixes = raw.filter((m) => m && typeof m.id === "string" && ["daily", "weekly", "repeat"].includes(m.kind) && typeof m.expires === "number" && m.expires > Date.now() && Array.isArray(m.libraryIds) && Array.isArray(m.seedIds) && Array.isArray(m.hidden) && Array.isArray(m.songs)).slice(0, 5).map((m) => ({ ...m, songs: m.songs.filter((s: DiscoveredSong) => s && typeof s.key === "string" && typeof s.artist === "string" && typeof s.title === "string" && s.candidate && typeof s.candidate.sourceURL === "string").slice(0, 30) }));
} catch { /* A corrupt optional edition never prevents startup. */ }
function publish(next: Mix[]) {
  mixes = next;
  try { localStorage.setItem(KEY, JSON.stringify(mixes)); } catch { /* session editions still work */ }
  listeners.forEach((l) => l());
}
export function useMixes() { return useSyncExternalStore((l) => { listeners.add(l); return () => { listeners.delete(l); }; }, () => mixes); }
export const getMix = (id: string) => mixes.find((m) => m.id === id);
export const mixSeed = (mix: Mix) => hashString(mix.id);
export function hideFromMix(id: string, key: string) {
  publish(mixes.map((m) => m.id === id ? { ...m, hidden: [...new Set([...m.hidden, key])] } : m));
}
export function mixSongs(mix: Mix) {
  const s = getState();
  return mix.songs.filter((song) => !mix.hidden.includes(song.key) && !s.taste.hiddenDiscoveries[song.key]);
}
export function mixIds(mix: Mix) {
  const s = getState();
  const library = mix.libraryIds.filter((id) => s.tracks[id] && !mix.hidden.includes(id) && !s.taste.hidden[id] && !s.taste.hiddenDiscoveries[discoveryKey(s.artists[s.tracks[id].artistId]?.name, s.tracks[id].title)]);
  const owned = new Map(Object.values(s.tracks).filter((t) => !t.stream && !mix.hidden.includes(t.id) && !s.taste.hidden[t.id]).map((t) => [discoveryKey(s.artists[t.artistId]?.name, t.title), t.id]));
  registerStreams(mixSongs(mix));
  const hiddenOwned = new Set(Object.values(s.tracks).filter((t) => !t.stream && (mix.hidden.includes(t.id) || s.taste.hidden[t.id])).map((t) => discoveryKey(s.artists[t.artistId]?.name, t.title)));
  const discoveries = mixSongs(mix).filter((song) => !hiddenOwned.has(song.key) && (owned.has(song.key) || canStream(song.candidate))).map((song) => owned.get(song.key) ?? streamTrackId(song.key));
  // Interleave one discovery after each pair of familiar songs.
  const ids: string[] = [];
  for (let i = 0; i < Math.max(library.length, discoveries.length * 2); i++) {
    if (library[i]) ids.push(library[i]);
    if (i % 2 === 1 && discoveries[(i - 1) / 2]) ids.push(discoveries[(i - 1) / 2]);
  }
  return [...new Set(ids)].slice(0, 30);
}
/** Stable editions change only at the local day / Monday boundary. */
export function ensureMixes(now = new Date()) {
  const s = getState();
  const profile = tasteProfile(s, now.getTime());
  const ids = s.trackIds.filter((id) => s.tracks[id] && !s.tracks[id].stream && !s.taste.hidden[id]).sort((a, b) => (profile.support.get(b) ?? 0) - (profile.support.get(a) ?? 0) || a.localeCompare(b));
  const midnight = new Date(now); midnight.setHours(0, 0, 0, 0);
  const tomorrow = new Date(midnight); tomorrow.setDate(tomorrow.getDate() + 1);
  const monday = new Date(midnight); monday.setDate(monday.getDate() - (monday.getDay() + 6) % 7);
  const nextWeek = new Date(monday); nextWeek.setDate(nextWeek.getDate() + 7);
  const day = midnight.toISOString();
  const week = monday.toISOString();
  const old = mixes.filter((m) => m.expires > now.getTime());
  const next = [...old];
  const add = (mix: Mix) => {
    const index = next.findIndex((m) => m.id === mix.id);
    if (index < 0) next.push(mix);
    else if (!next[index].complete && !pending.has(mix.id)) next[index] = { ...next[index], description: mix.description, seedIds: mix.seedIds, libraryIds: mix.libraryIds };
  };
  const artists = [...new Set(ids.map((id) => s.tracks[id].artistId))];
  for (let n = 0; n < Math.min(3, Math.ceil(artists.length / 3)); n++) {
    const group = artists.slice(n * 3, n * 3 + 3);
    const pool = ids.filter((id) => group.includes(s.tracks[id].artistId));
    add({ id: `daily-${n + 1}`, name: `Daily Mix ${n + 1}`, description: group.map((id) => s.artists[id]?.name).filter(Boolean).join(", "), kind: "daily", edition: day, expires: tomorrow.getTime(), libraryIds: pool.slice(0, 21), seedIds: pool, songs: [], hidden: [], complete: false });
  }
  add({ id: "weekly", name: "Discover Weekly", description: "New songs across your taste. A fresh edition every Monday.", kind: "weekly", edition: week, expires: nextWeek.getTime(), libraryIds: [], seedIds: ids, songs: [], hidden: [], complete: false });
  const counts = new Map<string, number>();
  for (const l of s.taste.listens) if (qualified(l) && l.at > now.getTime() - 14 * 86_400_000 && ids.includes(l.trackId)) counts.set(l.trackId, (counts.get(l.trackId) ?? 0) + 1);
  const repeat = [...counts].sort((a, b) => b[1] - a[1] || (profile.touched.get(b[0]) ?? 0) - (profile.touched.get(a[0]) ?? 0)).map(([id]) => id).slice(0, 30);
  if (repeat.length) add({ id: "repeat", name: "On Repeat", description: "Your most-heard songs over the last two weeks. Updated daily.", kind: "repeat", edition: day, expires: tomorrow.getTime(), libraryIds: repeat, seedIds: [], songs: [], hidden: [], complete: true });
  if (JSON.stringify(next) !== JSON.stringify(mixes)) publish(next);
}
const pending = new Map<string, Promise<void>>();
export function fillMix(id: string) {
  if (pending.has(id)) return pending.get(id)!;
  const mix = getMix(id);
  if (!mix || mix.complete) return Promise.resolve();
  if (mix.kind === "weekly" && !mix.seedIds.length) {
    publish(mixes.map((m) => m.id === id ? { ...m, note: "Import, like or play songs to build your first weekly edition." } : m));
    return Promise.resolve();
  }
  const task = (async () => {
    const songs: DiscoveredSong[] = [];
    const target = mix.kind === "daily" ? Math.min(9, Math.round(mix.libraryIds.length * 3 / 7)) : 30;
    const groups = mix.kind === "weekly" ? Math.min(3, Math.max(1, Math.ceil(mix.seedIds.length / 5))) : 1;
    let note = "";
    try {
      for (let n = 0; n < groups && songs.length < target; n++) {
        const seeds = seedsForIds(mix.seedIds, n * 5);
        const result = await discover({ seeds, signal: AbortSignal.timeout(90_000), limit: target - songs.length, budget: Math.floor(48 / groups), exclude: new Set(songs.map((v) => v.key)) });
        songs.push(...result.songs);
        note = result.note;
        if (songs.length >= 30) break;
      }
      publish(mixes.map((m) => m.id === id && m.edition === mix.edition ? { ...m, libraryIds: m.kind === "daily" && songs.length ? m.libraryIds.slice(0, Math.round(songs.length * 7 / 3)) : m.libraryIds, songs: songs.slice(0, target), complete: true, note } : m));
    } catch {
      publish(mixes.map((m) => m.id === id && m.edition === mix.edition ? { ...m, songs, note: "Couldn't finish this edition. Open it again to retry." } : m));
    }
  })().finally(() => pending.delete(id));
  pending.set(id, task);
  return task;
}
