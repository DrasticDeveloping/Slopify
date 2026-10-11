import { connectRadio, isPlayable, playList, recommendations, toast } from "../state/actions";
import { canStream, registerStreams, streamTrackId } from "../state/importer";
import { getState, setState } from "../state/store";
import { discoveryKey } from "./discover";
import { discover, seedsForIds, type Seeds } from "./service";

let serial = 0;
let session: { key: string; seeds: Seeds; seen: Set<string>; batch: number; busy: boolean; exhausted: boolean; pending?: Promise<void> } | null = null;
function refill(force = false): Promise<void> {
  const r = session;
  const s = getState();
  if (!r || r.exhausted || s.context?.radioKey !== r.key || (!force && s.order.length - s.index > 6)) return Promise.resolve();
  if (r.busy) return r.pending ?? Promise.resolve();
  r.busy = true;
  r.pending = refillSession(r);
  return r.pending;
}
async function refillSession(r: NonNullable<typeof session>) {
  try {
    const result = await discover({ seeds: r.seeds, signal: AbortSignal.timeout(90_000), refresh: r.batch++, exclude: r.seen, limit: 8, budget: 12 });
    const now = getState();
    if (session !== r || now.context?.radioKey !== r.key) return;
    registerStreams(result.songs);
    result.songs.forEach((song) => r.seen.add(song.key));
    const songs = result.songs.filter((song) => canStream(song.candidate));
    const ids = songs.map((song) => streamTrackId(song.key)).filter((id) => !now.order.includes(id));
    if (!ids.length) { r.exhausted = true; return; }
    const future = now.order.slice(now.index + 1);
    const blended: string[] = [];
    for (let i = 0; i < Math.max(future.length, ids.length * 2); i++) {
      if (future[i]) blended.push(future[i]);
      if (i % 2 === 1 && ids[(i - 1) / 2]) blended.push(ids[(i - 1) / 2]);
    }
    const order = [...now.order.slice(0, now.index + 1), ...blended];
    setState((st) => ({ order, context: st.context ? { ...st.context, ids: order, picks: { ...st.context.picks, ...Object.fromEntries(songs.map((song) => [streamTrackId(song.key), song.kind])) } } : null }));
  } catch { /* Existing songs keep playing when discovery is unavailable. */ }
  finally { r.busy = false; }
}
connectRadio({
  start: (seedIds, name) => {
    const s = getState();
    const seeds = seedsForIds(seedIds);
    if (!seeds.artists.length && name) seeds.artists.push({ name, title: "", weight: 1 });
    const key = `radio-${++serial}`;
    const seed = seedIds[0];
    const list = seed ? recommendations(s, { mode: "radio", seedId: seed, limit: 20, requireRelated: true }) : [];
    const ids = [...new Set([...seedIds, ...list.map((v) => v.id)])].filter((id) => isPlayable(s.tracks[id], s));
    session = { key, seeds, seen: new Set(ids.map((id) => discoveryKey(s.artists[s.tracks[id].artistId]?.name, s.tracks[id].title))), batch: 0, busy: false, exhausted: false };
    if (ids.length) { playList(ids, ids[0], { label: `${name} Radio`, radioKey: key }); void refill(true); }
    else {
      const before = s.context;
      toast(`Finding songs for ${name} Radio`);
      const r = session;
      r.busy = true;
      void discover({ seeds, signal: AbortSignal.timeout(90_000), limit: 8, budget: 12 }).then((result) => {
        if (session !== r || getState().context !== before) return;
        registerStreams(result.songs);
        const songs = result.songs.filter((song) => canStream(song.candidate));
        const ids = songs.map((song) => streamTrackId(song.key));
        songs.forEach((song) => r.seen.add(song.key));
        if (ids.length) playList(ids, ids[0], { label: `${name} Radio`, radioKey: key, picks: Object.fromEntries(songs.map((song) => [streamTrackId(song.key), song.kind])) });
        else toast("No playable songs found for this radio yet");
      }).catch(() => toast("Radio discovery is unavailable right now")).finally(() => { r.busy = false; });
    }
  },
  refill: () => { void refill(); },
  finish: () => refill(true),
});
