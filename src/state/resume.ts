import { cueSong, positionOf, toast } from "./actions";
import { getState, subscribe, type Route } from "./store";

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
}

const STORAGE_KEY = "slopify.playback-spot.v1";
const DEVICE_KEY = "slopify.device.v1";
/** While playing, the position is noted this often. */
const NOTE_EVERY = 60_000;
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
const device = deviceId();

const isSpot = (x: PlaybackSpot | null | undefined): x is PlaybackSpot =>
  Boolean(x) && typeof x!.id === "string" && Number.isFinite(x!.position) && Number.isFinite(x!.at) && typeof x!.device === "string" && Array.isArray(x!.ids);

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

function note() {
  const s = getState();
  const id = s.currentId;
  if (!id || !synced(id) || following || s.listen.mode === "guest") return;
  publish({
    id,
    position: Math.round(positionOf(id)),
    at: Date.now(),
    device,
    label: s.context?.label,
    route: s.context?.route,
    ids: (s.context?.ids ?? [id]).filter(synced).slice(0, MAX_IDS),
  });
}

function cue(next: PlaybackSpot) {
  // Set first: cueing changes the song showing, which mustn't be noted as played here.
  const was = following;
  following = true;
  if (cueSong(next.id, next.position, { label: next.label ?? "Library", route: next.route, ids: next.ids })) return true;
  following = was;
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
    if (s.currentId !== prev.currentId || s.isPlaying !== prev.isPlaying) note();
  });
  window.setInterval(() => {
    if (getState().isPlaying) note();
  }, NOTE_EVERY);
  window.addEventListener("pagehide", note);
}
