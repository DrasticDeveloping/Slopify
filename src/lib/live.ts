import { engine } from "../audio/engine";
import { getState, subscribe } from "../state/store";

/*
 * One shared frame loop for everything that follows the playhead (times, seek bars, the visualizer).
 * It only runs while music plays and the window can be seen; otherwise each painter runs once whenever
 * something changes (a seek, a new song, play/pause), so an idle app draws no frames at all.
 */

/** Paints one frame; returns true if it still needs more frames even with nothing playing (e.g. bars settling). */
type Painter = () => boolean | void;

const painters = new Set<Painter>();
let raf = 0;
let shown = true;

const frame = () => {
  raf = 0;
  let busy = false;
  for (const paint of painters) if (paint()) busy = true;
  if (shown && (engine.playing || busy)) raf = requestAnimationFrame(frame);
};

/** Paints on the next frame, and keeps going while there is something to follow. */
export function wakeLive() {
  if (shown && !raf && painters.size) raf = requestAnimationFrame(frame);
}

export function onLiveFrame(paint: Painter): () => void {
  painters.add(paint);
  wakeLive();
  return () => {
    painters.delete(paint);
    if (!painters.size && raf) {
      cancelAnimationFrame(raf);
      raf = 0;
    }
  };
}

/** The desktop app keeps the page "visible" in the tray (so playback keeps time), so it says when the window really is. */
export function setWindowShown(next: boolean) {
  shown = next;
  if (next) delete document.documentElement.dataset.window;
  else document.documentElement.dataset.window = "hidden";
  wakeLive();
}

engine.onChange = wakeLive;
let playing: boolean | null = null;
const notePlaying = () => {
  const s = getState();
  if (s.isPlaying !== playing) {
    playing = s.isPlaying;
    // Lets CSS run its slow ambient animations only while music plays.
    if (playing) document.documentElement.dataset.playing = "";
    else delete document.documentElement.dataset.playing;
  }
  wakeLive();
};
subscribe(notePlaying);
notePlaying();
