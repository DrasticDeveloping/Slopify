import { useSyncExternalStore } from "react";
import type { ReasonKind } from "./taste";
import { isPlayable, recommendations } from "../state/actions";
import { canStream, registerStreams, streamTrackId } from "../state/importer";
import { getState, setState, snoozedUntil, subscribe, type AppState } from "../state/store";
import { discover, seedsForIds, trackKey } from "./service";

/*
 * Smart shuffle (press Shuffle twice): while the list you're playing shuffles,
 * a recommended song joins the queue after every two of yours. Songs from your
 * library that suit the list come first, straight away; new songs from the web
 * join as they're found. Only the queue changes, never the list itself, so
 * turning smart shuffle (or shuffle) off leaves just your songs.
 */

/** One recommendation after this many of your songs. */
const EVERY = 2;
/** How far ahead the queue is kept mixed; it tops up as you listen. */
const AHEAD = 12;
const BATCH = 8;

interface Session {
  /** The list it belongs to (label and page), so a reshuffle or a new start keeps its songs. */
  key: string;
  /** Songs it put in the queue. */
  added: Set<string>;
  /** Song keys it has offered or found in the list, so nothing repeats. */
  seen: Set<string>;
  /** Found but not queued yet: new songs from the web, and suitable library songs. */
  fresh: string[];
  owned: string[];
  picks: Record<string, ReasonKind>;
  batch: number;
  exhausted: boolean;
  pending: boolean;
}

let session: Session | null = null;

const listeners = new Set<() => void>();
let addedView: ReadonlySet<string> = new Set();
function publish() {
  addedView = new Set(session?.added ?? []);
  listeners.forEach((l) => l());
}
/** Songs smart shuffle put in the queue, to mark them there. */
export const useSmartAdded = () => useSyncExternalStore((l) => (listeners.add(l), () => void listeners.delete(l)), () => addedView);

const keyOf = (s: AppState) => (s.context ? `${s.context.label}|${JSON.stringify(s.context.route ?? null)}` : "");

/** Smart shuffle has something to do: a list of your songs is playing (radio, autoplay and recommendation lists mix in new songs already). */
function active(s: AppState) {
  const c = s.context;
  if (!s.smartShuffle || !s.shuffle || !c || !s.currentId || s.listen.mode === "guest" || c.radioKey) return false;
  return !c.ids.every((id) => c.picks?.[id]);
}

function sessionFor(s: AppState) {
  const key = keyOf(s);
  if (session?.key === key) return session;
  const ids = s.context?.ids ?? [];
  session = { key, added: new Set(), seen: new Set(ids.map((id) => trackKey(s, id))), fresh: [], owned: [], picks: {}, batch: 0, exhausted: false, pending: false };
  publish();
  return session;
}

/** Where recommendations go in the songs ahead: after every EVERY of yours (counting the one playing), within the next AHEAD. */
function slots(upcoming: string[], added: Set<string>, playingMine: boolean) {
  const at: number[] = [];
  let since = playingMine ? 1 : 0;
  let mine = 0;
  for (let i = 0; i < upcoming.length && mine < AHEAD; i++) {
    if (added.has(upcoming[i])) {
      since = 0;
      continue;
    }
    since++;
    mine++;
    if (since >= EVERY && !added.has(upcoming[i + 1] ?? "")) {
      at.push(i + 1);
      since = 0;
    }
  }
  return at;
}

/** Library songs that suit what's playing and aren't in the list or queue, or snoozed. */
function ownedFor(s: AppState, r: Session, count: number) {
  const exclude = new Set([...(s.context?.ids ?? []), ...s.order, ...s.upNext, ...r.added, ...r.owned]);
  const list = recommendations(s, { mode: "autoplay", seedId: s.currentId ?? undefined, exclude, limit: count * 2 })
    .filter((rec) => !s.tracks[rec.id]?.stream && !snoozedUntil(s, rec.id) && !r.seen.has(trackKey(s, rec.id)));
  for (const rec of list.slice(0, count)) {
    r.owned.push(rec.id);
    r.picks[rec.id] = rec.kind;
    r.seen.add(trackKey(s, rec.id));
  }
}

/** New songs from the web like the ones coming up; they join the queue when found. */
function findFresh(s: AppState, r: Session) {
  if (r.pending || r.exhausted) return;
  r.pending = true;
  const ahead = s.order.slice(s.index + 1).filter((id) => !r.added.has(id) && !s.tracks[id]?.stream);
  const seeds = seedsForIds([s.currentId!, ...ahead.slice(0, 8)], r.batch);
  discover({ seeds, signal: AbortSignal.timeout(90_000), refresh: r.batch++, exclude: new Set(r.seen), limit: BATCH, budget: 12 })
    .then(({ songs }) => {
      if (session !== r) return;
      registerStreams(songs);
      songs.forEach((song) => r.seen.add(song.key));
      const playable = songs.filter((song) => canStream(song.candidate));
      if (!playable.length) r.exhausted = true;
      for (const song of playable) {
        const id = streamTrackId(song.key);
        r.fresh.push(id);
        r.picks[id] = song.kind;
      }
      fill();
    })
    .catch(() => {
      // Library songs keep smart shuffle going when discovery is unavailable.
      if (session === r) r.exhausted = true;
    })
    .finally(() => {
      r.pending = false;
    });
}

/** Puts recommendations in the open places ahead, alternating new songs and library songs. */
function fill() {
  const s = getState();
  if (!active(s)) return;
  const r = sessionFor(s);
  const upcoming = s.order.slice(s.index + 1);
  const open = slots(upcoming, r.added, Boolean(s.currentId) && !r.added.has(s.currentId!));
  if (!open.length) return;
  const usable = (id: string) => isPlayable(s.tracks[id], s) && !s.order.includes(id);
  r.fresh = r.fresh.filter(usable);
  r.owned = r.owned.filter(usable);
  if (r.owned.length + r.fresh.length < open.length) ownedFor(s, r, open.length - r.owned.length - r.fresh.length);
  if (r.fresh.length < open.length) findFresh(s, r);
  const picks: string[] = [];
  for (let i = 0; i < open.length; i++) {
    const id = (i % 2 === 0 ? r.fresh.shift() ?? r.owned.shift() : r.owned.shift() ?? r.fresh.shift());
    if (!id) break;
    picks.push(id);
  }
  if (!picks.length) return;
  const ahead = [...upcoming];
  // From the end, so earlier places stay where they were.
  for (let i = picks.length - 1; i >= 0; i--) ahead.splice(open[i], 0, picks[i]);
  picks.forEach((id) => r.added.add(id));
  const reasons = Object.fromEntries(picks.map((id) => [id, r.picks[id]]).filter(([, kind]) => kind));
  setState((st) => ({ order: [...st.order.slice(0, st.index + 1), ...ahead], context: st.context ? { ...st.context, picks: { ...st.context.picks, ...reasons } } : null }));
  publish();
}

/** Takes the recommendations still to come out of the queue when smart shuffle goes off (the one playing, if any, finishes). */
function clear() {
  const r = session;
  session = null;
  publish();
  if (!r?.added.size) return;
  const s = getState();
  const ahead = s.order.slice(s.index + 1);
  if (!ahead.some((id) => r.added.has(id))) return;
  setState({ order: [...s.order.slice(0, s.index + 1), ...ahead.filter((id) => !r.added.has(id))] });
}

let scheduled = false;
function soon() {
  if (scheduled) return;
  scheduled = true;
  queueMicrotask(() => {
    scheduled = false;
    fill();
  });
}

let last = getState();
subscribe(() => {
  const s = getState();
  const prev = last;
  last = s;
  if (s.smartShuffle !== prev.smartShuffle && !s.smartShuffle) return clear();
  if (!active(s)) return;
  if (s.smartShuffle !== prev.smartShuffle || s.order !== prev.order || s.index !== prev.index || s.context !== prev.context || s.currentId !== prev.currentId) soon();
});
