import { useSyncExternalStore } from "react";
import { recommend } from "../recommend/rank";
import type { Listen } from "../recommend/taste";
import { connectSlipIns, isLiked, isPlayable, toast, toggleLike } from "./actions";
import { registerStreams, streamSong, streamTrackId, type StreamSong } from "./importer";
import { getState, type AppState } from "./store";

/*
 * Slip-ins: songs you've picked to be played now and then, between the songs
 * you chose to play, when they fit what's playing. You hear them the way you'd
 * hear a song on the radio rather than deciding about them, and skip them as
 * often as you like. The playlist (or album, or shuffle) carries on from where
 * it was afterwards; nothing in it is skipped or moved.
 *
 * A slip-in plays when the recommender expects you'll like it there: it has to
 * fit what's playing (the same artists, playlists you keep them together in,
 * songs listeners play together, what you usually play next).
 *
 * Kept per song, here (localStorage) and, for music-server songs, with your
 * library and account (sync.ts), so they follow you to your other devices.
 * A streamed song (a search result or suggestion) can be a slip-in without
 * being saved: it keeps what's needed to stream it again in a later session.
 */

export interface SlipIn {
  addedAt: number;
  /** Times it was slipped in, on this device. */
  slipped: number;
  /** Times it was heard to the end, and skipped early, when slipped in on this device. */
  finished: number;
  skipped: number;
  /** The same three counts on your other devices (sync.ts). */
  elsewhere?: [number, number, number];
  /** Skips in a row since it was last heard to the end. */
  skipStreak: number;
  lastAt?: number;
  /** Whether "you've heard it a few times" was already said. */
  offered?: boolean;
  /** A streamed song, not in the library: how to stream it again. */
  stream?: StreamSong;
}

export type SlipFrequency = "off" | "rare" | "sometimes" | "often";

const STORAGE_KEY = "slopify.slip-ins.v1";
/** Songs between slip-ins, at each frequency. */
const GAPS: Record<Exclude<SlipFrequency, "off">, [number, number]> = { rare: [7, 11], sometimes: [3, 6], often: [2, 3] };
/** The same song isn't slipped in again within this long. */
const REST = 60 * 60_000;
/** Skipped early this many times in a row, a song stops being slipped in (you're told, and can undo). */
const RETIRE_AFTER = 3;
/** Heard to the end this many times, it's offered for Liked Songs. */
const OFFER_AFTER = 3;

function load(): Record<string, SlipIn> {
  try {
    const raw = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}") as Record<string, SlipIn>;
    return raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  } catch {
    return {};
  }
}

let songs = load();
const listeners = new Set<() => void>();
function publish(next: Record<string, SlipIn>) {
  songs = next;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(songs));
  } catch {
    // Still works for this session.
  }
  listeners.forEach((l) => l());
}
const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => void listeners.delete(l);
};

export const useSlipIns = () => useSyncExternalStore(subscribe, () => songs);
/** For sync.ts: every slip-in, a way to hear of changes, and taking the synced ones in. */
export const allSlipIns = () => songs;
export const onSlipIns = subscribe;
export function adoptSlipIns(next: Record<string, SlipIn>) {
  if (JSON.stringify(next) !== JSON.stringify(songs)) publish(next);
}
export const isSlipIn = (id: string) => Boolean(songs[id]);

/** The song playing now, if it was slipped in. */
let current: string | null = null;
const currentListeners = new Set<() => void>();
function setCurrent(id: string | null) {
  if (current === id) return;
  current = id;
  currentListeners.forEach((l) => l());
}
export const useSlippedIn = () => useSyncExternalStore((l) => (currentListeners.add(l), () => void currentListeners.delete(l)), () => current);

function add(ids: string[]) {
  const next = { ...songs };
  for (const id of ids) {
    const stream = getState().tracks[id]?.stream ? streamSong(id) : null;
    next[id] ??= { addedAt: Date.now(), slipped: 0, finished: 0, skipped: 0, skipStreak: 0, ...(stream ? { stream } : {}) };
  }
  publish(next);
}

/** Streamed slip-ins become playable songs again (they aren't kept between sessions like library songs). */
export function registerStreamed() {
  const s = getState();
  const missing = Object.values(songs).flatMap((r) => (r.stream && !s.tracks[streamId(r)] ? [r.stream] : []));
  if (missing.length) registerStreams(missing);
}
const streamId = (r: SlipIn) => (r.stream ? streamTrackId(r.stream.key) : "");

/** Marks songs to be slipped in (or, if they all are, stops it). Streamed songs stay streamed: nothing is downloaded. */
export function toggleSlipIn(ids: string[]) {
  const s = getState();
  if (ids.length && ids.every(isSlipIn)) {
    const next = { ...songs };
    ids.forEach((id) => delete next[id]);
    publish(next);
    toast(ids.length === 1 ? "Won't slip it in anymore" : `Won't slip in ${ids.length} songs anymore`);
    return;
  }
  add(ids.filter((id) => s.tracks[id]));
  const off = s.settings.slipIns === "off";
  toast(ids.length === 1 ? "It'll slip in when it fits what you're playing" : `${ids.length} songs will slip in when they fit what you're playing`, {
    tone: "success",
    detail: off ? "Slip-ins are turned off in Settings → Playback." : "Skip it whenever you like.",
  });
}

/* ───────────────────────── choosing when, and which ───────────────────────── */

/** Songs from the list played since the last slip-in, and how many to wait for (set from the frequency on first use). */
let sinceLast = 0;
let gap = 0;
const nextGap = (f: Exclude<SlipFrequency, "off">) => {
  const [lo, hi] = GAPS[f];
  return lo + Math.floor(Math.random() * (hi - lo + 1));
};

/** How likely you are to enjoy a slip-in here, as the recommender scores it; below this, it waits for a better moment. */
const LIKELY = 1;
/** After this many gaps without a good moment, a slip-in that fits a little will do. */
const PATIENCE = 3;
const FAIR = 0.5;

/**
 * How much you'd enjoy each slip-in right after what's playing, from the
 * recommender's autoplay ranking (the songs around it, playlists you keep
 * together, what you usually play next, what listeners play together, your
 * likes). A song that keeps getting skipped scores less.
 */
function likelihood(s: AppState, ids: string[], seedId: string) {
  const ranked = recommend(
    { tracks: s.tracks, artists: s.artists, playlists: s.playlists, taste: s.taste, trackIds: ids, playable: (t) => isPlayable(t, s) },
    { mode: "autoplay", seedId, limit: ids.length },
  );
  return ranked.map((r) => ({ id: r.id, score: r.score / (1 + songs[r.id].skipStreak) }));
}

/** A slip-in to play before `nextId`, or null to carry on with the list. */
function pick(state: AppState, nextId: string): string | null {
  const frequency = state.settings.slipIns;
  if (frequency === "off" || state.listen.mode === "guest" || state.repeat === "one") return null;
  if (!gap) gap = nextGap(frequency);
  // Only the list's own songs count towards the gap, not the slip-in that's ending.
  if (state.currentId !== current) sinceLast++;
  if (sinceLast < gap) return null;
  registerStreamed();
  const s = getState();
  const listed = new Set([...(s.context?.ids ?? []), ...s.upNext, ...s.history.slice(0, 15), s.currentId, nextId]);
  const now = Date.now();
  const ids = Object.keys(songs).filter((id) => !listed.has(id) && isPlayable(s.tracks[id], s) && !(now - (songs[id].lastAt ?? 0) < REST));
  if (!ids.length) return null;
  // It plays when you're likely to enjoy it after what's playing; otherwise it waits for a better moment.
  const bar = sinceLast >= gap * PATIENCE ? FAIR : LIKELY;
  const candidates = likelihood(s, ids, s.currentId ?? nextId).filter((c) => c.score >= bar);
  if (!candidates.length) return null;
  // A weighted draw, so the likeliest is likeliest without always winning.
  const weights = candidates.map((c) => c.score);
  let r = Math.random() * weights.reduce((a, b) => a + b, 0);
  const chosen = candidates[weights.findIndex((w) => (r -= w) <= 0)] ?? candidates[0];
  sinceLast = 0;
  gap = nextGap(frequency);
  publish({ ...songs, [chosen.id]: { ...songs[chosen.id], slipped: songs[chosen.id].slipped + 1, lastAt: now } });
  return chosen.id;
}

/** How a slipped-in song went: heard to the end, or skipped early. */
function ended(id: string, end: Listen["end"], listen: Listen | null) {
  const record = songs[id];
  if (!record) return;
  const heardMost = listen ? listen.covered / Math.max(1, listen.span) >= 0.8 : false;
  const t = getState().tracks[id];
  if (end === "finished" || heardMost) {
    // Heard to the end on any of your devices.
    const finished = record.finished + 1 + (record.elsewhere?.[1] ?? 0);
    publish({ ...songs, [id]: { ...record, finished: record.finished + 1, skipStreak: 0, offered: record.offered || finished >= OFFER_AFTER } });
    if (finished >= OFFER_AFTER && !record.offered && t && !isLiked(id)) {
      toast(`You've heard “${t.title}” all the way through ${finished} times`, { detail: "It'll keep slipping in. Like it to keep it with your favourites.", action: { label: "Like", run: () => toggleLike(id) } });
    }
    return;
  }
  if (end !== "skipped" || !listen || listen.covered / Math.max(1, listen.span) > 0.5) return;
  const skipStreak = record.skipStreak + 1;
  if (skipStreak >= RETIRE_AFTER) {
    const next = { ...songs };
    delete next[id];
    publish(next);
    if (t) toast(`Stopped slipping in “${t.title}”`, { detail: `You skipped it ${skipStreak} times in a row.`, action: { label: "Undo", run: () => publish({ ...songs, [id]: { ...record, skipped: record.skipped + 1, skipStreak: 0 } }) } });
    return;
  }
  publish({ ...songs, [id]: { ...record, skipped: record.skipped + 1, skipStreak } });
}

connectSlipIns({
  pick,
  ended,
  playing: (id, slipped) => setCurrent(slipped ? id : null),
  forget: (ids) => {
    if (!ids.some((id) => songs[id])) return;
    const next = { ...songs };
    ids.forEach((id) => delete next[id]);
    publish(next);
  },
});
