import { dayKey } from "../lib/format";
import type { Palette, Playlist } from "./types";

/** Small deterministic PRNG (stable artwork and waveforms). */
export function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function hashString(value: string) {
  let h = 2166136261;
  for (let i = 0; i < value.length; i++) {
    h ^= value.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function hsl(h: number, s: number, l: number) {
  return `hsl(${Math.round(h) % 360} ${s}% ${l}%)`;
}

export function paletteFromSeed(seed: number): Palette {
  const r = rng(seed);
  const h = r() * 360;
  const shift = 30 + r() * 70;
  return {
    a: hsl(h, 70 + r() * 20, 52 + r() * 10),
    b: hsl(h + shift, 65 + r() * 25, 42 + r() * 12),
    c: hsl(h + shift * 2.2, 60 + r() * 30, 28 + r() * 14),
  };
}

/** Liked Songs has one app-owned identity; sync carries its contents, not its display labels. */
export function likedPlaylist(existing?: Playlist): Playlist {
  return {
    ...existing,
    id: "liked",
    name: "Liked Songs",
    description: "Everything you've hearted, in one place.",
    system: true,
    trackIds: existing?.trackIds ?? [],
    createdAt: existing?.createdAt ?? Date.now(),
    palette: { a: "hsl(252 90% 66%)", b: "hsl(280 70% 50%)", c: "hsl(230 60% 30%)" },
  };
}

/** The `days` local calendar days ending on `now`'s day, oldest first, as YYYY-MM-DD keys. */
export function recentDays(days = 90, now = Date.now()) {
  const today = new Date(now);
  // Calendar arithmetic at local noon, so daylight-saving changes never skip or repeat a day.
  return Array.from({ length: days }, (_, i) => dayKey(new Date(today.getFullYear(), today.getMonth(), today.getDate() - (days - 1 - i), 12)));
}
