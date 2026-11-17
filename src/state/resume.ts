import { cueSong, positionOf, toast } from "./actions";
import { flushPersist, getState, subscribe, type Route } from "./store";

/*
 * Picking up where you left off: the song you were playing, how far in, and the
 * list it was playing from. Kept here (so a reload carries on) and synced with
 * your library and account (sync.ts), so another device you sign in on can
 * carry on too. Only music-server songs are remembered, since only they exist
 * on every device.
 */

export interface PlaybackSpot {
  id: string;
  position: number;
  at: number;
  /** The device it was played on. */
  device: string;
  label?: string;
  route?: Route;
  ids: string[];
  /** The list plays from its top after this song (a playlist switched to while it played). */
  fromTop?: boolean;
  /** The actual play order and manually queued songs, when noted by a newer app. */
  order?: string[];
  index?: number;
  upNext?: string[];
}

const STORAGE_KEY = "slopify.playback-spot.v1";
const DEVICE_KEY = "slopify.device.v1";
/** While playing, the position is noted this often. */
const NOTE_EVERY = 10_000;
/** Enough of the list for a queue to carry on, without growing the synced data much. */
const MAX_IDS = 200;

const synced = (id: string) => id.startsWith("srv_");

function deviceId() {
  try {
    const known = localStorage.getItem(DEVICE_KEY);
    if (known) return known;
    const id = crypto.randomUUID();
    localStorage.setItem(DEVICE_KEY, id);
    return id;
  } catch {
    return "this-device";
  }
}
/** This device, as named in synced data. */
export const device = deviceId();

const isSpot = (x: PlaybackSpot | null | undefined): x is PlaybackSpot =>
  Boolean(x) && typeof x!.id === "string" && Number.isFinite(x!.position) && Number.isFinite(x!.at) && typeof x!.device === "string"
  && Array.isArray(x!.ids) && x!.ids.every((id) => typeof id === "string")
  && (x!.order === undefined || (Array.isArray(x!.order) && x!.order.every((id) => typeof id === "string")))
  && (x!.upNext === undefined || (Array.isArray(x!.upNext) && x!.upNext.every((id) => typeof id === "string")))
  && (x!.index === undefined || (Number.isInteger(x!.index) && x!.index >= -1));

function load(): PlaybackSpot | null {
  try {
    const raw = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "null") as PlaybackSpot | null;
    return isSpot(raw) ? raw : null;
  } catch {
    return null;
  }
}

let spot = load();
const listeners = new Set<() => void>();
function publish(next: PlaybackSpot) {
  spot = next;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(spot));
  } catch {
    // Still synced this session.
  }
  listeners.forEach((l) => l());
}

/** The latest spot, from here or another device, for sync.ts. */
export const playbackSpot = () => spot;
export const onPlaybackSpot = (listener: () => void) => {
  listeners.add(listener);
  return () => void listeners.delete(listener);
};

/** Whether the song showing was put there from a spot, and hasn't been played here since. */
let following = false;
let followedState: string | null = null;

function spotState() {
  const s = getState();
  return JSON.stringify([s.currentId, s.currentId ? positionOf(s.currentId) : 0, s.order, s.index, s.upNext, s.context]);
}

function note() {
  const s = getState();
  const id = s.currentId;
  if (!id || !synced(id) || s.listen.mode === "guest") return;
  if (following) {
    // An untouched restore should keep its timestamp/device. Queue edits and
    // scrubbing are new local intent even before the listener presses Play.
    if (followedState === null || followedState === spotState()) return;
    following = false;
  }
  const order = s.order.filter(synced);
  const index = s.order.slice(0, s.index + 1).filter(synced).length - 1;
  // Keep the current entry and enough of what follows, even in a long playlist.
  const from = Math.max(0, index - 20);
  const savedOrder = order.slice(from, from + MAX_IDS);
  const savedIds = new Set([id, ...savedOrder]);
  publish({
    id,
    position: Math.round(positionOf(id)),
    at: Date.now(),
    device,
    label: s.context?.label,
    route: s.context?.route,
    ids: (s.context?.ids ?? [id]).filter((entry) => synced(entry) && savedIds.has(entry)).slice(0, MAX_IDS),
    ...(s.index < 0 ? { fromTop: true } : {}),
    order: savedOrder,
    index: index - from,
    upNext: s.upNext.filter(synced).slice(0, MAX_IDS),
  });
}

function cue(next: PlaybackSpot) {
  // Set first: cueing changes the song showing, which mustn't be noted as played here.
  const was = following;
  const previousState = followedState;
  following = true;
  followedState = null;
  if (cueSong(next.id, next.position, { label: next.label ?? "Library", route: next.route, ids: next.ids, fromTop: next.fromTop === true, order: next.order, index: next.index, upNext: next.upNext })) {
    followedState = spotState();
    return true;
  }
  following = was;
  followedState = previousState;
  return false;
}

/** On opening, the song you were last playing (here or elsewhere) is put back, paused. */
export function restorePlaybackSpot() {
  if (spot && !getState().currentId) cue(spot);
}

/** Who already got a "carry on here" offer, so each song played elsewhere is offered once. */
let offered = "";

/**
 * A newer spot from sync. A device showing nothing (or still showing a spot it
 * was given) moves to it quietly; one paused on its own song is offered it;
 * one playing is left alone.
 */
export function adoptPlaybackSpot(next: PlaybackSpot | null | undefined) {
  if (!isSpot(next) || (spot && next.at <= spot.at)) return;
  publish(next);
  const s = getState();
  if (next.device === device || s.isPlaying || s.listen.mode !== "idle") return;
  if (!s.currentId || following || s.currentId === next.id) {
    cue(next);
    return;
  }
  const key = `${next.device}|${next.id}`;
  const t = s.tracks[next.id];
  if (key === offered || !t) return;
  offered = key;
  toast(`Carry on with “${t.title}”?`, {
    detail: "You were playing it on another device.",
    duration: 8000,
    action: { label: "Carry on", run: () => cue(next) },
  });
}

/** Notes the spot as you play: on each new song, on pause, now and then while playing, and on leaving. */
let watching = false;
export function watchPlaybackSpot() {
  if (watching) return;
  watching = true;
  let last = getState();
  subscribe(() => {
    const s = getState();
    const prev = last;
    last = s;
    if (s.isPlaying && !prev.isPlaying) following = false;
    if (s.currentId !== prev.currentId || s.isPlaying !== prev.isPlaying || s.order !== prev.order || s.index !== prev.index || s.upNext !== prev.upNext || s.context !== prev.context) note();
  });
  window.setInterval(() => {
    if (getState().isPlaying) note();
  }, NOTE_EVERY);
  const saveBeforeLeaving = () => {
    note();
    flushPersist();
  };
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") saveBeforeLeaving();
  });
  window.addEventListener("pagehide", saveBeforeLeaving);
}
