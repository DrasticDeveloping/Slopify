import { engine } from "../audio/engine";
import { subscribe } from "../state/store";

/*
 * One shared frame loop for everything that follows the playhead (times, seek bars, the visualizer).
 * It only runs while music plays and the window can be seen; otherwise each painter runs once whenever
 * something changes (a seek, a new song, play/pause), so an idle app draws no frames at all.
 *
 * While playing it paints 30 frames a second (seek bars move a pixel or so a second, and the visualizer's
 * bars ease by time), and 15 while the window isn't focused. Each frame drawn means the whole glassy window
 * is composited again, and on a 144 Hz display drawing every refresh kept a playing window at about a core
 * of CPU and another of GPU.
 */

/** Paints one frame; returns true if it still needs more frames even with nothing playing (e.g. bars settling). */
type Painter = () => boolean | void;

/** Frames a second while following playback. */
const FOLLOW_FPS = 30;
/** The most frames a second while the window isn't focused (it may still be seen, on another screen say). */
const AWAY_FPS = 15;
/** How early the timer asks for a frame, so the display refresh that follows lands near when it's due. */
const EARLY = 4;

const painters = new Set<Painter>();
let raf = 0;
let wait = 0;
/** When the next frame may be painted, on the requestAnimationFrame clock. */
let due = 0;
/** Something changed (a seek, play/pause): the next frame paints whenever it comes. */
let urgent = false;
let shown = true;
let focused = typeof document === "undefined" || document.hasFocus();

/** Milliseconds between frames. */
const interval = () => 1000 / (focused ? FOLLOW_FPS : AWAY_FPS);

const request = () => {
  wait = 0;
  raf = requestAnimationFrame(frame);
};

const frame = () => {
  raf = 0;
  // Timed by when the callback runs, not the frame's own timestamp, which can be a refresh earlier: by that,
  // the frame the timer asked for looked early and was let go, so the loop ran twice as many callbacks.
  const at = performance.now();
  // A display refresh that comes well before the frame is due is let go. The timer asks EARLY ms ahead, so the
  // refresh it gets is taken; a frame painted a little early still keeps the average to the rate (see below).
  if (!urgent && at < due - EARLY) {
    raf = requestAnimationFrame(frame);
    return;
  }
  // Paced from when each frame was due, not when it landed, so frames average out to the rate
  // on any display; after a pause (or a late frame), pacing starts again from now.
  const step = interval();
  due = urgent || due + step <= at ? at + step : due + step;
  urgent = false;
  let busy = false;
  for (const paint of painters) if (paint()) busy = true;
  if (!shown || !painters.size || !(engine.playing || busy)) return;
  // Asks for the next frame a little early, so it lands on the display refresh nearest its time.
  const next = due - performance.now() - EARLY;
  if (next > 0) wait = window.setTimeout(request, next);
  else request();
};

/** Paints on the next frame, and keeps going while there is something to follow. */
export function wakeLive() {
  if (!shown || !painters.size) return;
  urgent = true;
  if (raf) return;
  clearTimeout(wait);
  request();
}

export function onLiveFrame(paint: Painter): () => void {
  painters.add(paint);
  wakeLive();
  return () => {
    painters.delete(paint);
    if (!painters.size) stopFrames();
  };
}

function stopFrames() {
  cancelAnimationFrame(raf);
  clearTimeout(wait);
  raf = 0;
  wait = 0;
  urgent = false;
}

/** The desktop app keeps the page "visible" in the tray (so playback keeps time), so it says when the window really is. */
export function setWindowShown(next: boolean) {
  shown = next;
  if (next) delete document.documentElement.dataset.window;
  else {
    document.documentElement.dataset.window = "hidden";
    stopFrames();
  }
  wakeLive();
}

// A window that isn't focused draws less, and its decorative loops (the equalizer bars) hold still (see app.css).
function setFocused(next: boolean) {
  focused = next;
  if (next) delete document.documentElement.dataset.away;
  else document.documentElement.dataset.away = "";
}
if (typeof window !== "undefined") {
  window.addEventListener("focus", () => setFocused(true));
  window.addEventListener("blur", () => setFocused(false));
  setFocused(focused);
}

engine.onChange = wakeLive;
// Any app change may move what's shown, but one already following playback paints it on its next frame,
// so frequent changes (an import's progress, say) don't add frames.
subscribe(() => {
  if (!wait && !raf) wakeLive();
});
