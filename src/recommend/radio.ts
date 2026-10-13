import type { DiscoveredSong } from "./discover";
import type { ReasonKind } from "./taste";
import { connectRadio, isPlayable, playList, recommendations, toast } from "../state/actions";
import { canStream, registerStreams, streamTrackId } from "../state/importer";
import { getState, setState } from "../state/store";
import { discover, interleave, seedsForIds, trackKey, type Seeds } from "./service";

/*
 * Song, album and artist radio: the related library songs first, with new songs
 * from the web mixed in, topped up as the queue runs low so the radio keeps going.
 */

interface Session {
  /** Matches the playback context this radio is playing in. */
  key: string;
  seeds: Seeds;
  /** Song keys already in this radio, so top-ups never repeat one. */
  seen: Set<string>;
  batch: number;
  exhausted: boolean;
  pending: Promise<void> | null;
}

/** Top up once fewer than this many songs are left in the queue. */
const LOW_WATER = 6;
const BATCH = 8;

let serial = 0;
let session: Session | null = null;

const current = (r: Session) => session === r && getState().context?.radioKey === r.key;

/** The next batch of new songs for this radio. Nothing changes until the caller adopts them. */
async function findMore(r: Session) {
  const { songs } = await discover({ seeds: r.seeds, signal: AbortSignal.timeout(90_000), refresh: r.batch++, exclude: r.seen, limit: BATCH, budget: 12 });
  return songs;
}

/** Makes found songs playable and marks them seen, once the radio is known to still be wanted. */
function adopt(r: Session, found: DiscoveredSong[]) {
  registerStreams(found);
  found.forEach((song) => r.seen.add(song.key));
  const songs = found.filter((song) => canStream(song.candidate));
  const picks: Record<string, ReasonKind> = Object.fromEntries(songs.map((song) => [streamTrackId(song.key), song.kind]));
  return { ids: Object.keys(picks), picks };
}

/** Mixes a new batch into the rest of the queue, one after every two songs still to come. */
async function topUp(r: Session) {
  try {
    const found = await findMore(r);
    if (!current(r)) return;
    const { ids, picks } = adopt(r, found);
    const s = getState();
    const added = ids.filter((id) => !s.order.includes(id));
    if (!added.length) {
      r.exhausted = true;
      return;
    }
    const order = [...s.order.slice(0, s.index + 1), ...interleave(s.order.slice(s.index + 1), added)];
    setState((st) => ({ order, context: st.context ? { ...st.context, ids: order, picks: { ...st.context.picks, ...picks } } : null }));
  } catch {
    // The songs already queued keep playing when discovery is unavailable.
  } finally {
    r.pending = null;
  }
}

/** Tops up the playing radio when its queue runs low, or now when `force` is set. */
function refill(force = false): Promise<void> {
  const r = session;
  const s = getState();
  if (!r || r.exhausted || s.context?.radioKey !== r.key) return Promise.resolve();
  if (r.pending) return r.pending;
  if (!force && s.order.length - s.index > LOW_WATER) return Promise.resolve();
  r.pending = topUp(r);
  return r.pending;
}

function start(seedIds: string[], name: string) {
  const s = getState();
  const seeds = seedsForIds(seedIds);
  if (!seeds.artists.length && name) seeds.artists.push({ name, title: "", weight: 1 });
  const key = `radio-${++serial}`;
  const label = `${name} Radio`;
  // Library songs related to the first seed (unrelated favourites are left out).
  const related = seedIds[0] ? recommendations(s, { mode: "radio", seedId: seedIds[0], limit: 20, requireRelated: true }) : [];
  const ids = [...new Set([...seedIds, ...related.map((r) => r.id)])].filter((id) => isPlayable(s.tracks[id], s));
  const r: Session = { key, seeds, seen: new Set(ids.map((id) => trackKey(s, id))), batch: 0, exhausted: false, pending: null };
  session = r;
  if (ids.length) {
    playList(ids, ids[0], { label, radioKey: key });
    void refill(true);
    return;
  }

  // Nothing playable in the library (an artist known only online): start from new songs.
  const before = s.context;
  toast(`Finding songs for ${label}`);
  r.pending = findMore(r)
    .then((songs) => {
      // Something else started playing meanwhile.
      if (session !== r || getState().context !== before) return;
      const { ids: found, picks } = adopt(r, songs);
      if (found.length) playList(found, found[0], { label, radioKey: key, picks });
      else toast("No playable songs found for this radio yet");
    })
    .catch(() => {
      toast("Radio discovery is unavailable right now");
    })
    .finally(() => {
      r.pending = null;
    });
}

connectRadio({
  start,
  refill: () => void refill(),
  finish: () => refill(true),
});
