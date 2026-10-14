import { useSyncExternalStore } from "react";
import type { Listen } from "../recommend/taste";
import { connectSlipIns, isLiked, isPlayable, saveStream, toast, toggleLike } from "./actions";
import { getState, type AppState } from "./store";

/*
 * Slip-ins: songs you've picked to be played now and then, between the songs
 * you chose to play, when they fit what's playing. You hear them the way you'd
 * hear a song on the radio rather than deciding about them, and skip them as
 * often as you like. The playlist (or album, or shuffle) carries on from where
 * it was afterwards; nothing in it is skipped or moved.
 *
 * Kept per library song, here (localStorage) and, for music-server songs, with
 * your library and account (sync.ts), so they follow you to your other devices.
 */

export interface SlipIn {
  addedAt: number;
  /** Times it was slipped in. */
  slipped: number;
  /** Times it was heard to the end, and skipped early, when slipped in. */
  finished: number;
  skipped: number;
  /** Skips in a row since it was last heard to the end. */
  skipStreak: number;
  lastAt?: number;
  /** Whether "you've heard it a few times" was already said. */
  offered?: boolean;
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
  for (const id of ids) next[id] ??= { addedAt: Date.now(), slipped: 0, finished: 0, skipped: 0, skipStreak: 0 };
  publish(next);
}

/**
 * Marks songs to be slipped in (or, if they all are, stops it). A streamed
 * song is added to the library first, since slip-ins come from your library.
 */
export function toggleSlipIn(ids: string[]) {
  const s = getState();
  if (ids.length && ids.every(isSlipIn)) {
    const next = { ...songs };
    ids.forEach((id) => delete next[id]);
    publish(next);
    toast(ids.length === 1 ? "Won't slip it in anymore" : `Won't slip in ${ids.length} songs anymore`);
    return;
  }
  const library = ids.filter((id) => s.tracks[id] && !s.tracks[id].stream);
  const streamed = ids.filter((id) => s.tracks[id]?.stream);
  if (library.length) add(library);
  for (const id of streamed) saveStream(id, (libraryId) => add([libraryId]));
  const off = s.settings.slipIns === "off";
  toast(ids.length === 1 ? "It'll slip into your listening now and then" : `${ids.length} songs will slip into your listening now and then`, {
    tone: "success",
    detail: off ? "Slip-ins are turned off in Settings → Listening." : streamed.length ? "Adding it to your library first." : "Skip it whenever you like.",
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

/**
 * How well a slip-in fits what's playing: by the same artists as the songs
 * around it, or in the same genre. A song that keeps getting skipped fits less.
 */
function fit(s: AppState, id: string, around: string[]) {
  const t = s.tracks[id];
  const artists = new Set(around.map((x) => s.tracks[x]?.artistId).filter(Boolean));
  const genres = new Set(around.map((x) => s.artists[s.tracks[x]?.artistId ?? ""]?.genre).filter(Boolean));
  const near = [s.currentId, ...around.slice(0, 1)].map((x) => (x ? s.tracks[x]?.artistId : undefined));
  let score = 0;
  if (near.includes(t.artistId)) score += 3;
  else if (artists.has(t.artistId)) score += 2;
  if (genres.has(s.artists[t.artistId]?.genre)) score += 1;
  return score / (1 + songs[id].skipStreak);
}

/** A slip-in to play before `nextId`, or null to carry on with the list. */
function pick(s: AppState, nextId: string): string | null {
  const frequency = s.settings.slipIns;
  if (frequency === "off" || s.listen.mode === "guest" || s.repeat === "one") return null;
  if (!gap) gap = nextGap(frequency);
  // Only the list's own songs count towards the gap, not the slip-in that's ending.
  if (s.currentId !== current) sinceLast++;
  if (sinceLast < gap) return null;
  const listed = new Set([...(s.context?.ids ?? []), ...s.upNext, ...s.history.slice(0, 15), s.currentId, nextId]);
  const around = [nextId, ...s.order.slice(Math.max(0, s.index - 4), s.index + 6)];
  const now = Date.now();
  const candidates = Object.keys(songs)
    .filter((id) => !listed.has(id) && isPlayable(s.tracks[id], s) && !(now - (songs[id].lastAt ?? 0) < REST))
    .map((id) => ({ id, score: fit(s, id, around) }));
  if (!candidates.length) return null;
  // A fitting song comes in once the gap is up; one that fits nothing here waits a while longer.
  const best = Math.max(...candidates.map((c) => c.score));
  if (best < 1 && sinceLast < gap * 2) return null;
  // A weighted draw, so the best fit is likeliest without always winning.
  const weights = candidates.map((c) => 0.25 + c.score);
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
    const finished = record.finished + 1;
    publish({ ...songs, [id]: { ...record, finished, skipStreak: 0, offered: record.offered || finished >= OFFER_AFTER } });
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
