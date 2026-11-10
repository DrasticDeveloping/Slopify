import { creditLine } from "../../lib/credits";
import { useEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent, type PointerEvent } from "react";
import { DETAIL_RATE, videoFrames, waveDetail, type WaveDetail } from "../../audio/analysis";
import { engine } from "../../audio/engine";
import { rng } from "../../data/library";
import { fadeLevel, type ClipRange, type FadeShape } from "../../data/types";
import { formatTime } from "../../lib/format";
import { onLiveFrame } from "../../lib/live";
import { useMediaQuery } from "../../lib/hooks";
import { closeModal, isPlayable, libraryIds, mediaUrlOf, previewClip, saveClip, seek, setClipDraft, toast, togglePlay } from "../../state/actions";
import { getState, useStore } from "../../state/store";
import { BlurredTrackArt, TrackArt } from "../Artwork";
import { Icon } from "../Icon";
import { Shell } from "./Shell";

const FRAMES = 8;
/** The shortest clip: long enough to loop a beat. */
const MIN_LEN = 0.5;
const MAX_FADE = 30;
/** How much of the end "Ending" plays. */
const ENDING = 4;
/** Below this loudness (the loudest moment being 1) a song's start or end counts as silence. */
const SILENCE = 0.03;
const QUICK = [15, 30, 60];
const HISTORY = 60;
/** How close (in pixels) an edge has to come to where a sound starts to snap to it. */
const SNAP_PX = 9;
const SHAPES: Array<[FadeShape, string]> = [["smooth", "Smooth"], ["linear", "Linear"], ["scurve", "S-curve"]];

interface Clip { start: number; end: number; fadeIn: number; fadeOut: number; shape: FadeShape }
type Grab = "start" | "end" | "fadeIn" | "fadeOut";

const same = (a: Clip, b: Clip) => a.start === b.start && a.end === b.end && a.fadeIn === b.fadeIn && a.fadeOut === b.fadeOut && a.shape === b.shape;
/** Clips are kept to the hundredth of a second. */
const round = (v: number) => Math.round(v * 100) / 100;

/** A clip as it's saved: fades and their shape only when there are fades. */
function toRange(c: Clip): ClipRange {
  return { start: c.start, end: c.end, ...(c.fadeIn ? { fadeIn: c.fadeIn } : {}), ...(c.fadeOut ? { fadeOut: c.fadeOut } : {}), ...((c.fadeIn || c.fadeOut) && c.shape !== "smooth" ? { fadeShape: c.shape } : {}) };
}

/** "1:05.40": a time to the hundredth of a second (or the tenth, for labels). */
function exact(t: number, digits: 1 | 2 = 2) {
  const scale = digits === 2 ? 100 : 10;
  const n = Math.round(Math.max(0, t) * scale);
  const s = Math.floor(n / scale);
  return `${formatTime(s)}.${String(n % scale).padStart(digits, "0")}`;
}

/** The song's loudness in fine detail (and where its sounds start), and frames from a video, read from its file. */
function useAnalysis(id: string | undefined, video: boolean) {
  const [result, setResult] = useState<{ id?: string; detail?: WaveDetail; frames?: string[]; failed?: boolean }>({});
  useEffect(() => {
    const url = id ? mediaUrlOf(id) : undefined;
    if (!id || !url) {
      setResult({ id, failed: true });
      return;
    }
    let live = true;
    setResult({ id });
    waveDetail(url).then(
      (detail) => live && setResult((r) => (r.id === id ? { ...r, detail } : r)),
      () => live && setResult((r) => (r.id === id ? { ...r, failed: true } : r)),
    );
    if (video) {
      videoFrames(url, FRAMES).then(
        (frames) => live && setResult((r) => (r.id === id ? { ...r, frames } : r)),
        () => undefined,
      );
    }
    return () => {
      live = false;
    };
  }, [id, video]);
  return result.id === id ? result : {};
}

/** Accepts plain seconds ("123"), or m:ss and h:mm:ss as formatTime shows them, with optional decimals. */
function parseTime(text: string) {
  const m = text.trim().match(/^(?:(\d+):)?(?:(\d+):)?(\d+(?:\.\d+)?)$/);
  if (!m) return null;
  const [hours, minutes] = m[2] === undefined ? [0, Number(m[1] ?? 0)] : [Number(m[1]), Number(m[2])];
  const seconds = Number(m[3]);
  // After a colon, seconds (and minutes that follow hours) stay under 60.
  if ((m[1] !== undefined && seconds >= 60) || (m[2] !== undefined && minutes >= 60)) return null;
  return hours * 3600 + minutes * 60 + seconds;
}

/** A time field with nudge buttons and, while the song plays here, a button to take the playhead's time. */
function TimeField({ label, value, onCommit, onNudge, onMark, markLabel, markIcon, canMark }: {
  label: string; value: number; onCommit: (v: number) => void; onNudge: (delta: number) => void;
  onMark: () => void; markLabel: string; markIcon: string; canMark: boolean;
}) {
  // Typing makes the field yours until Enter or leaving it; until then it follows the clip.
  const [text, setText] = useState<string | null>(null);
  const shown = text ?? exact(value);
  const commit = () => {
    if (text === null) return;
    const v = parseTime(text);
    setText(null);
    if (v !== null) onCommit(v);
  };
  const nudge = (sign: 1 | -1) => (e: { shiftKey: boolean; altKey: boolean }) => onNudge(sign * (e.shiftKey ? 1 : e.altKey ? 0.01 : 0.1));
  return (
    <div className="ce-field">
      <span className="ce-label">{label}</span>
      <div className="ce-time">
        <button type="button" className="icon-btn sm" onClick={nudge(-1)} aria-label={`${label} 0.1 seconds earlier`} title="0.1s earlier (Shift 1s, Alt 0.01s)">
          <Icon name="chevronLeft" size={16} />
        </button>
        <input
          value={shown}
          onBlur={commit}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") commit();
            else if (e.key === "Escape" && text !== null) {
              e.stopPropagation();
              setText(null);
            }
          }}
          inputMode="decimal"
          aria-label={`${label} time`}
          spellCheck={false}
        />
        <button type="button" className="icon-btn sm" onClick={nudge(1)} aria-label={`${label} 0.1 seconds later`} title="0.1s later (Shift 1s, Alt 0.01s)">
          <Icon name="chevronRight" size={16} />
        </button>
      </div>
      <button type="button" className="ce-mark" onClick={onMark} disabled={!canMark} title={canMark ? markLabel : "Play the song here to mark from the playhead"}>
        <Icon name={markIcon} size={15} />{markLabel}
      </button>
    </div>
  );
}

/** A fade length, in half seconds. `onStep` adds to the current length (so quick presses each count). */
function FadeField({ label, value, max, onStep }: { label: string; value: number; max: number; onStep: (delta: number) => void }) {
  return (
    <div className="ce-fade">
      <span className="ce-label">{label}</span>
      <div className="ce-stepper">
        <button type="button" className="icon-btn sm" onClick={() => onStep(-0.5)} disabled={value <= 0} aria-label={`Shorter ${label.toLowerCase()}`}>−</button>
        <output aria-live="polite">{value ? `${value.toFixed(1)}s` : "Off"}</output>
        <button type="button" className="icon-btn sm" onClick={() => onStep(0.5)} disabled={value >= max} aria-label={`Longer ${label.toLowerCase()}`}>+</button>
      </div>
    </div>
  );
}

/** Tick spacing for the ruler: a round step leaving at least `gap` pixels between labels. */
function tickStep(span: number, width: number, gap = 76) {
  const steps = [0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600];
  return steps.find((s) => (s / span) * width >= gap) ?? 600;
}

/** The loudest reading between two times, from the fine detail. */
function peakBetween(fine: ArrayLike<number>, t0: number, t1: number) {
  const i0 = Math.max(0, Math.floor(t0 * DETAIL_RATE));
  const i1 = Math.min(fine.length, Math.max(i0 + 1, Math.ceil(t1 * DETAIL_RATE)));
  let v = 0;
  for (let i = i0; i < i1; i++) if (fine[i] > v) v = fine[i];
  return v;
}

/** The average loudness between two times: tells a verse from a chorus where the peaks are all alike. */
function averageBetween(fine: ArrayLike<number>, t0: number, t1: number) {
  const i0 = Math.max(0, Math.floor(t0 * DETAIL_RATE));
  const i1 = Math.min(fine.length, Math.max(i0 + 1, Math.ceil(t1 * DETAIL_RATE)));
  let sum = 0;
  for (let i = i0; i < i1; i++) sum += fine[i];
  return i1 > i0 ? sum / (i1 - i0) : 0;
}

export function ClipEditorModal({ trackId }: { trackId?: string }) {
  const tracks = useStore((s) => s.tracks);
  const artists = useStore((s) => s.artists);
  const clips = useStore((s) => s.clips);
  const currentId = useStore((s) => s.currentId);
  const isPlaying = useStore((s) => s.isPlaying);
  const touch = useMediaQuery("(hover: none) and (pointer: coarse)");
  const phone = useMediaQuery("(max-width: 680px)");
  // Library songs to switch between, and the one opened here even when it isn't in the library (a song streamed from search).
  const options = useMemo(() => {
    const ids = libraryIds(getState()).filter((id) => isPlayable(tracks[id]) && tracks[id].duration > MIN_LEN * 2);
    return trackId && tracks[trackId] && !ids.includes(trackId) ? [trackId, ...ids] : ids;
  }, [tracks, trackId]);
  const [id, setId] = useState(() => (trackId && tracks[trackId] ? trackId : currentId && options.includes(currentId) ? currentId : options[0]));
  const track = id ? tracks[id] : undefined;
  const duration = track?.duration ?? 0;

  const fromSaved = (tid: string, d: number): Clip => {
    const c = clips[tid];
    return c
      ? { start: c.start, end: c.end, fadeIn: c.fadeIn ?? 0, fadeOut: c.fadeOut ?? 0, shape: c.fadeShape ?? "smooth" }
      : { start: 0, end: d, fadeIn: 0, fadeOut: 0, shape: "smooth" };
  };
  const [clip, setClipRaw] = useState<Clip>(() => (id ? fromSaved(id, duration) : { start: 0, end: 0, fadeIn: 0, fadeOut: 0, shape: "smooth" }));
  const clipRef = useRef(clip);
  clipRef.current = clip;
  /** Sets the clip and its ref together, so several changes in one go (key repeat, quick presses) each build on the last. */
  const setClipState = (next: Clip | ((c: Clip) => Clip)) => {
    const value = typeof next === "function" ? next(clipRef.current) : next;
    clipRef.current = value;
    setClipRaw(value);
  };
  const [undo, setUndo] = useState<Clip[]>([]);
  const [redo, setRedo] = useState<Clip[]>([]);
  const [view, setViewState] = useState({ from: 0, to: duration || 1 });
  const viewRef = useRef(view);
  viewRef.current = view;
  const [loop, setLoop] = useState(true);
  const [snap, setSnap] = useState(true);
  const [snapAt, setSnapAt] = useState<number | null>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });

  const wave = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const mini = useRef<HTMLCanvasElement>(null);
  const head = useRef<HTMLSpanElement>(null);
  const miniHead = useRef<HTMLSpanElement>(null);
  const drag = useRef<{ kind: Grab | "select" | "pending" | "move" | "pan"; from: Clip; x: number; t: number; inside?: boolean } | null>(null);
  const pendingSeek = useRef<number | null>(null);
  const lastScrub = useRef(0);
  const wheelRef = useRef<((e: WheelEvent) => void) | null>(null);

  // A song opened before its length was known starts as the whole song once the length arrives.
  useEffect(() => {
    if (!duration) return;
    setClipState((c) => (c.end === 0 ? { ...c, end: duration } : c));
    setViewState((v) => (v.to <= 1 ? { from: 0, to: duration } : v));
  }, [duration]);

  // Keep the live player honouring the draft (range, fades and their shape) while the editor is open.
  useEffect(() => {
    if (id) setClipDraft(id, toRange(clip));
  }, [id, clip]);

  // Looping applies only to this song (the engine checks), and only while the editor is open with it on.
  useEffect(() => {
    engine.loopTrack = loop && id ? id : null;
    return () => {
      engine.loopTrack = null;
    };
  }, [loop, id]);

  useEffect(() => {
    const el = wave.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setSize({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    // Not passive, so scrolling over the waveform zooms it instead of scrolling the dialog.
    const onWheel = (e: WheelEvent) => wheelRef.current?.(e);
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => {
      ro.disconnect();
      el.removeEventListener("wheel", onWheel);
    };
  }, [id]);

  // The playhead (on the waveform and the overview), drawn on the shared frame clock; and the loop and a pending jump.
  useEffect(() => onLiveFrame(() => {
    const here = engine.loadedTrackId === id && Boolean(duration);
    if (here && pendingSeek.current !== null && engine.playing) {
      const t = pendingSeek.current;
      pendingSeek.current = null;
      seek(t);
    }
    const v = viewRef.current;
    const pos = engine.position;
    const x = (pos - v.from) / (v.to - v.from);
    if (head.current) {
      head.current.style.opacity = here && x >= 0 && x <= 1 ? "1" : "0";
      if (here) head.current.style.transform = `translateX(${x * 100}%)`;
    }
    if (miniHead.current) {
      miniHead.current.style.opacity = here ? "1" : "0";
      if (here) miniHead.current.style.transform = `translateX(${(pos / duration) * 100}%)`;
    }
  }), [id, duration]);

  const analysis = useAnalysis(id, track?.kind === "video");
  const fine = useMemo<ArrayLike<number>>(() => {
    if (analysis.detail) return analysis.detail.fine;
    if (!track || !duration) return [];
    // Until the file is read (or if it can't be), an outline of a typical song.
    const r = rng(track.seed);
    const n = Math.max(1, Math.round(duration * 20));
    const out = new Float32Array(Math.round(duration * DETAIL_RATE));
    const coarse = Array.from({ length: n }, (_, i) => {
      const t = i / n;
      const section = 0.55 + 0.45 * Math.abs(Math.sin(t * Math.PI * (2 + (track.seed % 3))));
      return Math.min(1, t * 6) * Math.min(1, (1 - t) * 8) * section * (0.55 + r() * 0.45);
    });
    for (let i = 0; i < out.length; i++) out[i] = coarse[Math.min(n - 1, Math.floor((i / out.length) * n))];
    return out;
  }, [track, duration, analysis.detail]);
  const onsets = analysis.detail?.onsets ?? [];
  const real = Boolean(analysis.detail);

  /** The clip's fade level at time t (0–1), as the engine plays it. */
  const envelope = (t: number, c: Clip) => {
    if (t < c.start || t > c.end) return 0;
    const rise = c.fadeIn ? (t - c.start) / c.fadeIn : 1;
    const fall = c.fadeOut ? (c.end - t) / c.fadeOut : 1;
    return fadeLevel(Math.min(rise, fall), c.shape);
  };

  // The waveform: a filled, mirrored shape drawn on a canvas when the clip, the zoom or the size changes (never per frame).
  useEffect(() => {
    const el = canvas.current;
    if (!el || !size.w || !duration || !fine.length) return;
    const dpr = window.devicePixelRatio || 1;
    el.width = Math.round(size.w * dpr);
    el.height = Math.round(size.h * dpr);
    const ctx = el.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, size.w, size.h);
    const { from, to } = view;
    const span = to - from;
    const w = size.w;
    const mid = size.h / 2;
    // The loudest moment reaches 85% of the height, leaving room for the fade curves above it.
    const amp = size.h * 0.425;
    // Two tones, as in Audition: each pixel's peak (drawn faintly) and its average loudness (drawn solid).
    const peaks = new Float32Array(w + 1);
    const levels = new Float32Array(w + 1);
    for (let x = 0; x <= w; x++) {
      const t0 = from + (x / w) * span;
      const t1 = from + ((x + 1) / w) * span;
      peaks[x] = peakBetween(fine, t0, t1);
      levels[x] = Math.min(peaks[x], averageBetween(fine, t0, t1) * 1.35);
    }
    const xAt = (t: number) => ((t - from) / span) * w;
    const shape = (scale: (x: number) => number, of: Float32Array = levels) => {
      ctx.beginPath();
      ctx.moveTo(0, mid);
      for (let x = 0; x <= w; x++) ctx.lineTo(x, mid - Math.max(0.5, of[x] * amp * scale(x)));
      for (let x = w; x >= 0; x--) ctx.lineTo(x, mid + Math.max(0.5, of[x] * amp * scale(x)));
      ctx.closePath();
    };
    const xs = xAt(clip.start);
    const xe = xAt(clip.end);
    const tAt = (x: number) => from + (x / w) * span;
    // Outside the clip: the song, faint.
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, 0, Math.max(0, xs), size.h);
    ctx.rect(Math.min(w, xe), 0, w, size.h);
    ctx.clip();
    shape(() => 1, peaks);
    ctx.fillStyle = "rgba(255,255,255,0.1)";
    ctx.fill();
    shape(() => 1);
    ctx.fillStyle = "rgba(255,255,255,0.2)";
    ctx.fill();
    ctx.restore();
    // Inside: the full shape faintly behind the faded one, so a fade shows how much quieter it makes the song.
    ctx.save();
    ctx.beginPath();
    ctx.rect(Math.max(0, xs), 0, Math.max(0, Math.min(w, xe) - Math.max(0, xs)), size.h);
    ctx.clip();
    const accent = getComputedStyle(document.documentElement).getPropertyValue("--accent").trim() || "#a78bfa";
    const fadeSpans: Array<[number, number]> = [[clip.start, clip.start + clip.fadeIn], [clip.end - clip.fadeOut, clip.end]];
    // Faded parts get a wash of the accent colour, so a fade shows even at whole-song zoom.
    ctx.globalAlpha = 0.22;
    ctx.fillStyle = accent;
    for (const [a, b] of fadeSpans) if (b > a) ctx.fillRect(xAt(a), 0, xAt(b) - xAt(a), size.h);
    ctx.globalAlpha = 1;
    shape((x) => envelope(tAt(x), clip), peaks);
    ctx.fillStyle = "rgba(255,255,255,0.4)";
    ctx.fill();
    if (clip.fadeIn || clip.fadeOut) {
      shape(() => 1);
      ctx.fillStyle = "rgba(255,255,255,0.18)";
      ctx.fill();
    }
    shape((x) => envelope(tAt(x), clip));
    ctx.fillStyle = "#fff";
    ctx.fill();
    ctx.restore();
    // The fade curves, in the accent colour.
    ctx.strokeStyle = accent;
    ctx.lineWidth = 2.5;
    ctx.lineJoin = "round";
    for (const [a, b] of fadeSpans) {
      if (b - a <= 0) continue;
      ctx.beginPath();
      for (let k = 0; k <= 40; k++) {
        const t = a + ((b - a) * k) / 40;
        const y = 3 + (1 - envelope(t, clip)) * (size.h - 6);
        if (k) ctx.lineTo(xAt(t), y);
        else ctx.moveTo(xAt(t), y);
      }
      ctx.stroke();
    }
  }, [fine, view, clip, size, duration]);

  // The overview: the whole song, small, with the clip in white (redrawn when the clip changes).
  useEffect(() => {
    const el = mini.current;
    if (!el || !duration || !fine.length) return;
    const w = el.clientWidth;
    const h = el.clientHeight;
    if (!w) return;
    const dpr = window.devicePixelRatio || 1;
    el.width = Math.round(w * dpr);
    el.height = Math.round(h * dpr);
    const ctx = el.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    const level = (x: number) => Math.min(1, averageBetween(fine, (x / w) * duration, ((x + 1) / w) * duration) * 1.35);
    const draw = (x0: number, x1: number, color: string) => {
      ctx.beginPath();
      ctx.moveTo(x0, h / 2);
      for (let x = x0; x <= x1; x++) ctx.lineTo(x, h / 2 - Math.max(0.5, level(x) * (h / 2 - 2)));
      for (let x = x1; x >= x0; x--) ctx.lineTo(x, h / 2 + Math.max(0.5, level(x) * (h / 2 - 2)));
      ctx.closePath();
      ctx.fillStyle = color;
      ctx.fill();
    };
    const xs = Math.round((clip.start / duration) * w);
    const xe = Math.round((clip.end / duration) * w);
    draw(0, w, "rgba(255,255,255,0.22)");
    draw(xs, xe, "rgba(255,255,255,0.9)");
  }, [fine, clip, duration, size.w]);

  if (!track || !id) {
    return (
      <Shell title="Edit clip" icon="scissors" size="lg">
        <div className="empty"><strong>No songs to edit yet</strong><p>Import or download a song, then come back to set its playback range.</p></div>
      </Shell>
    );
  }

  /** Keeps a clip valid: inside the song, at least MIN_LEN long, fades fitting inside it. `which` is the edge being moved. */
  const fit = (c: Clip, which: Grab | "both" = "both"): Clip => {
    let { start, end } = c;
    start = Math.max(0, Math.min(start, duration - MIN_LEN));
    end = Math.min(duration, Math.max(end, MIN_LEN));
    if (end - start < MIN_LEN) {
      if (which === "start") start = end - MIN_LEN;
      else end = start + MIN_LEN;
    }
    start = round(start);
    end = round(end);
    const span = end - start;
    let fadeIn = Math.max(0, Math.min(c.fadeIn, MAX_FADE, span));
    let fadeOut = Math.max(0, Math.min(c.fadeOut, MAX_FADE, span));
    if (fadeIn + fadeOut > span) {
      if (which === "fadeOut") fadeOut = span - fadeIn;
      else fadeIn = span - fadeOut;
    }
    return { ...c, start, end, fadeIn: round(fadeIn), fadeOut: round(fadeOut) };
  };

  /** A change worth undoing: the clip before it goes on the undo list. */
  const commit = (next: Clip, before = clipRef.current) => {
    if (same(next, before)) {
      setClipState(next);
      return;
    }
    setUndo((u) => [...u.slice(-HISTORY + 1), before]);
    setRedo([]);
    setClipState(next);
  };
  const change = (update: (c: Clip) => Clip, which: Grab | "both" = "both") => commit(fit(update(clipRef.current), which));
  const stepBack = () => {
    const prev = undo.at(-1);
    if (!prev) return;
    setUndo(undo.slice(0, -1));
    setRedo((r) => [...r, clipRef.current]);
    setClipState(prev);
  };
  const stepForward = () => {
    const next = redo.at(-1);
    if (!next) return;
    setRedo(redo.slice(0, -1));
    setUndo((u) => [...u, clipRef.current]);
    setClipState(next);
  };

  /* ── zoom and pan ── */
  const setView = (from: number, to: number) => {
    const span = Math.max(0.5, Math.min(duration, to - from));
    const f = Math.max(0, Math.min(duration - span, from));
    setViewState({ from: f, to: f + span });
  };
  const zoom = (factor: number, at?: number) => {
    const { from, to } = viewRef.current;
    const span = to - from;
    const anchor = at ?? (engine.loadedTrackId === id ? engine.position : (clip.start + clip.end) / 2);
    const next = Math.max(0.5, Math.min(duration, span * factor));
    const ratio = span ? (anchor - from) / span : 0.5;
    setView(anchor - ratio * next, anchor - ratio * next + next);
  };
  const fitAll = () => setView(0, duration);
  const toClip = () => {
    const pad = Math.max(0.25, (clip.end - clip.start) * 0.08);
    setView(clip.start - pad, clip.end + pad);
  };
  const span = view.to - view.from;
  const zoomed = span < duration - 0.5;

  // Wheel to zoom around the pointer (pinch on a trackpad too); Shift or a sideways swipe pans.
  wheelRef.current = (e: WheelEvent) => {
    const el = wave.current;
    if (!el) return;
    e.preventDefault();
    const { from, to } = viewRef.current;
    const s = to - from;
    const rect = el.getBoundingClientRect();
    if (e.shiftKey || Math.abs(e.deltaX) > Math.abs(e.deltaY)) {
      const d = ((e.shiftKey ? e.deltaY : e.deltaX) / rect.width) * s;
      setView(from + d, to + d);
    } else {
      const at = from + ((e.clientX - rect.left) / rect.width) * s;
      zoom(Math.exp(e.deltaY * (e.ctrlKey ? 0.01 : 0.0018)), at);
    }
  };

  /* ── snapping: an edge dragged or marked near where a sound starts lands exactly on it ── */
  const snapTime = (t: number, bypass: boolean, maxReach = Infinity) => {
    if (!snap || bypass || !onsets.length || !size.w) return { t, snapped: false };
    const reach = Math.min(maxReach, (SNAP_PX / size.w) * (viewRef.current.to - viewRef.current.from));
    let best = t;
    let gap = reach;
    for (const o of onsets) {
      const d = Math.abs(o - t);
      if (d < gap) {
        gap = d;
        best = o;
      }
      if (o > t + reach) break;
    }
    return { t: best, snapped: best !== t };
  };

  /* ── pointer: handles, drawing or moving a selection, clicking to hear from a point ── */
  const timeAt = (clientX: number) => {
    const rect = wave.current!.getBoundingClientRect();
    const { from, to } = viewRef.current;
    return Math.max(0, Math.min(duration, from + ((clientX - rect.left) / rect.width) * (to - from)));
  };
  /** While the clip is playing here, dragging an edge plays from it, so you hear where it lands. */
  const scrub = (t: number) => {
    const now = performance.now();
    if (now - lastScrub.current < 140 || engine.loadedTrackId !== id || !engine.playing) return;
    lastScrub.current = now;
    seek(t);
  };
  const grab = (kind: Grab) => (e: PointerEvent<HTMLElement>) => {
    e.stopPropagation();
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = { kind, from: clipRef.current, x: e.clientX, t: timeAt(e.clientX) };
  };
  const moveGrab = (e: PointerEvent<HTMLElement>) => {
    const d = drag.current;
    if (!d) return;
    const raw = timeAt(e.clientX);
    const c = clipRef.current;
    if (d.kind === "start" || d.kind === "end") {
      const { t, snapped } = snapTime(raw, e.altKey);
      setSnapAt(snapped ? t : null);
      const next = fit({ ...c, [d.kind]: t }, d.kind);
      setClipState(next);
      scrub(d.kind === "start" ? next.start : Math.max(next.start, next.end - 1.5));
    } else if (d.kind === "fadeIn") setClipState(fit({ ...c, fadeIn: raw - c.start }, "fadeIn"));
    else if (d.kind === "fadeOut") setClipState(fit({ ...c, fadeOut: c.end - raw }, "fadeOut"));
  };
  const endGrab = () => {
    const d = drag.current;
    drag.current = null;
    setSnapAt(null);
    if (d) commit(clipRef.current, d.from);
  };
  const waveDown = (e: PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    const t = timeAt(e.clientX);
    const c = clipRef.current;
    // A drag inside the clip moves it; but when the clip fills the song or everything in view (a fresh song, or zoomed
    // into a long clip) there's no "outside" to draw in, so a drag draws a new part, as in an audio editor.
    const { from, to } = viewRef.current;
    const fills = (c.start <= 0.01 && c.end >= duration - 0.01) || (c.start <= from && c.end >= to);
    drag.current = { kind: "pending", from: c, x: e.clientX, t, inside: !fills && !e.shiftKey && t > c.start && t < c.end };
  };
  const waveMove = (e: PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d || (d.kind !== "pending" && d.kind !== "select" && d.kind !== "move")) return;
    if (d.kind === "pending") {
      if (Math.abs(e.clientX - d.x) < 5) return;
      // Inside the clip, a drag moves it (length and fades kept); outside, it draws a new one, as in an audio editor.
      d.kind = d.inside ? "move" : "select";
    }
    const t = timeAt(e.clientX);
    if (d.kind === "move") {
      const len = d.from.end - d.from.start;
      const start = Math.max(0, Math.min(duration - len, d.from.start + (t - d.t)));
      setClipState({ ...d.from, start: round(start), end: round(start + len) });
      scrub(start);
      return;
    }
    setClipState(fit({ ...d.from, start: Math.min(d.t, t), end: Math.max(d.t, t) }, t < d.t ? "start" : "end"));
  };
  const waveUp = (e: PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    drag.current = null;
    if (!d) return;
    if (d.kind === "select" || d.kind === "move") return commit(clipRef.current, d.from);
    // A click: hear the clip from there.
    const t = timeAt(e.clientX);
    const c = clipRef.current;
    if (t >= c.start && t <= c.end) hearFrom(t);
  };
  const handleKey = (which: Grab) => (e: KeyboardEvent<HTMLElement>) => {
    const step = e.shiftKey ? 1 : e.altKey ? 0.01 : 0.1;
    const delta = e.key === "ArrowRight" || e.key === "ArrowUp" ? step : e.key === "ArrowLeft" || e.key === "ArrowDown" ? -step : 0;
    if (!delta) return;
    e.preventDefault();
    e.stopPropagation();
    change((c) => (which === "start" || which === "end" ? { ...c, [which]: c[which] + delta } : which === "fadeIn" ? { ...c, fadeIn: c.fadeIn + delta } : { ...c, fadeOut: c.fadeOut - delta }), which);
  };

  // Dragging the overview pans the waveform.
  const miniPan = (e: PointerEvent<HTMLDivElement>) => {
    if (e.type === "pointerdown") {
      e.currentTarget.setPointerCapture(e.pointerId);
      drag.current = { kind: "pan", from: clipRef.current, x: e.clientX, t: 0 };
    } else if (drag.current?.kind !== "pan") return;
    const rect = e.currentTarget.getBoundingClientRect();
    const t = ((e.clientX - rect.left) / rect.width) * duration;
    const s = viewRef.current.to - viewRef.current.from;
    setView(t - s / 2, t + s / 2);
  };

  /* ── listening ── */
  const here = currentId === id;
  const previewing = here && isPlaying;
  /** Plays the clip from `t` (inside it), loading the song if it isn't the one playing. */
  function hearFrom(t: number) {
    const s = getState();
    if (engine.loadedTrackId === id && s.currentId === id) {
      seek(t);
      if (!s.isPlaying) togglePlay();
      return;
    }
    previewClip(id!);
    pendingSeek.current = t;
  }
  const playPause = () => (previewing ? togglePlay() : hearFrom(here && engine.loadedTrackId === id ? Math.max(clip.start, engine.position) : clip.start));
  const hearEnding = () => hearFrom(Math.max(clip.start, clip.end - ENDING));
  const canMark = here && engine.loadedTrackId === id;
  // A mark placed by ear only snaps to a sound starting right there (not seconds away in a quiet passage).
  const markStart = (bypass = false) => canMark && change((c) => ({ ...c, start: snapTime(engine.position, bypass, 0.15).t }), "start");
  const markEnd = (bypass = false) => canMark && change((c) => ({ ...c, end: snapTime(engine.position, bypass, 0.15).t }), "end");

  /* ── tools ── */
  const trimSilence = () => {
    let first = 0;
    while (first < fine.length && fine[first] <= SILENCE) first++;
    let last = fine.length - 1;
    while (last > first && fine[last] <= SILENCE) last--;
    if (first >= fine.length) return;
    commit(fit({ ...clip, start: Math.max(0, first / DETAIL_RATE - 0.05), end: Math.min(duration, (last + 1) / DETAIL_RATE + 0.05) }));
  };
  const quick = (n: number) => change((c) => {
    const start = c.start + n > duration ? Math.max(0, duration - n) : c.start;
    return { ...c, start, end: Math.min(duration, start + n) };
  });

  const pick = (next: string) => {
    setClipDraft(id, null);
    setId(next);
    const d = tracks[next].duration;
    setClipState(fromSaved(next, d));
    setUndo([]);
    setRedo([]);
    setViewState({ from: 0, to: d });
  };

  // Keyboard, as in an editor: Space plays, I/O mark (Alt: without snapping), L loops, S snaps, +/−/0 zoom, Ctrl+Z / Ctrl+Shift+Z.
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const target = e.target as HTMLElement;
    if (["INPUT", "SELECT", "TEXTAREA"].includes(target.tagName)) return;
    const mod = e.ctrlKey || e.metaKey;
    const k = e.key.toLowerCase();
    const act = (run: () => void) => {
      e.preventDefault();
      e.stopPropagation();
      run();
    };
    if (mod && k === "z") act(e.shiftKey ? stepForward : stepBack);
    else if (mod && k === "y") act(stepForward);
    else if (mod) return;
    else if (e.key === " " && target.tagName !== "BUTTON") act(playPause);
    else if (k === "i") act(() => markStart(e.altKey));
    else if (k === "o") act(() => markEnd(e.altKey));
    else if (k === "l") act(() => setLoop((v) => !v));
    else if (k === "s") act(() => setSnap((v) => !v));
    else if (k === "=" || k === "+") act(() => zoom(0.5));
    else if (k === "-") act(() => zoom(2));
    else if (k === "0") act(fitAll);
  };

  const full = clip.start <= 0.05 && clip.end >= duration - 0.05;
  const plain = full && !clip.fadeIn && !clip.fadeOut;
  const dirty = !same(fromSaved(id, duration), clip);
  const pct = (t: number) => ((t - view.from) / span) * 100;
  const step = tickStep(span, size.w || 600);
  const ticks: number[] = [];
  for (let t = Math.ceil(view.from / step - 1e-9) * step; t <= view.to + 1e-6; t += step) ticks.push(Math.round(t * 100) / 100);
  const labelDigits = step < 0.1 ? 2 : 1;
  const chipsTight = ((clip.end - clip.start) / span) * (size.w || 1) < 150;
  const startOut = size.w - (pct(clip.start) / 100) * size.w < 76;
  const endOut = (pct(clip.end) / 100) * size.w < 76;
  const fadeMax = Math.min(MAX_FADE, clip.end - clip.start);
  /** Zoomed in, a handle off the visible part is hidden rather than pinned to the edge. */
  const offView = (t: number) => t < view.from - span * 0.005 || t > view.to + span * 0.005;
  const chipDigits = span < 20 ? 2 : 1;

  return (
    <Shell
      title="Edit clip"
      subtitle={<><strong>{track.title}</strong> · {creditLine(track, artists)}</>}
      art={<TrackArt trackId={id} />}
      size="xl"
      className="clip-modal"
      footer={
        <>
          <button type="button" className="btn ghost" onClick={() => commit({ start: 0, end: duration, fadeIn: 0, fadeOut: 0, shape: "smooth" })} disabled={plain}>Reset</button>
          <span className="spacer" />
          <button type="button" className="btn ghost" onClick={closeModal}>Cancel</button>
          <button
            type="button"
            className="btn primary"
            disabled={!dirty}
            onClick={() => {
              saveClip(id, plain ? null : toRange(clip));
              toast(plain ? "Clip removed" : `Clip saved · ${exact(clip.end - clip.start, 1)}`, { tone: "success", detail: track.title });
              closeModal();
            }}
          >
            Save clip
          </button>
        </>
      }
    >
      <div className="ce" onKeyDown={onKey}>
        <div className="ce-toolbar">
          {options.length > 1 ? (
            <label className="select ce-switch">
              <span className="sr-only">Song</span>
              <select value={id} onChange={(e) => pick(e.target.value)} aria-label="Choose a song to clip">
                {options.map((o) => (
                  <option key={o} value={o}>{tracks[o].title} — {creditLine(tracks[o], artists)}{clips[o] ? " ✂" : ""}</option>
                ))}
              </select>
            </label>
          ) : <span />}
          <div className="ce-tools" role="toolbar" aria-label="Editing tools">
            <button type="button" className="icon-btn" onClick={stepBack} disabled={!undo.length} aria-label="Undo" title="Undo (Ctrl Z)"><Icon name="undo" size={18} /></button>
            <button type="button" className="icon-btn" onClick={stepForward} disabled={!redo.length} aria-label="Redo" title="Redo (Ctrl Shift Z)"><Icon name="redo" size={18} /></button>
            <span className="ce-sep" />
            <button type="button" className="icon-btn" onClick={() => zoom(2)} disabled={!zoomed} aria-label="Zoom out" title="Zoom out (−)"><Icon name="zoomOut" size={18} /></button>
            <button type="button" className="icon-btn" onClick={() => zoom(0.5)} disabled={span <= 0.51} aria-label="Zoom in" title="Zoom in (+)"><Icon name="zoomIn" size={18} /></button>
            <button type="button" className="icon-btn" onClick={toClip} aria-label="Zoom to the clip" title="Zoom to the clip"><Icon name="zoomClip" size={18} /></button>
            <button type="button" className="icon-btn" onClick={fitAll} disabled={!zoomed} aria-label="Show the whole song" title="Whole song (0)"><Icon name="fitWidth" size={18} /></button>
            <span className="ce-sep" />
            <button type="button" className={`ce-pill${snap ? " on" : ""}`} onClick={() => setSnap(!snap)} aria-pressed={snap} title={real ? "Snap edges to where sounds start (S; hold Alt to place freely)" : "Waits for the waveform"} disabled={!real}>
              <Icon name="magnet" size={15} /><span>Snap</span>
            </button>
            <button type="button" className="ce-pill" onClick={trimSilence} disabled={!real} title={real ? "Start and end where the sound does" : "Waits for the waveform"}>
              <Icon name="sparkle" size={15} /><span>Trim silence</span>
            </button>
          </div>
        </div>

        <div className="clip-stage">
          {/* The song's own artwork, blurred once into a still canvas (as the full player's backdrop), behind the waveform. */}
          <BlurredTrackArt trackId={id} className="clip-backdrop" />
          <div className="ce-ruler" aria-hidden="true">
            {ticks.map((t) => {
              const p = pct(t);
              // Labels at the very edges sit inside the ruler instead of half off it.
              const edge = p < 4 ? " first" : p > 96 ? " last" : "";
              return <span key={t} className={edge} style={{ left: `${p}%` }}>{step < 1 ? exact(t, labelDigits) : formatTime(t)}</span>;
            })}
          </div>
          {analysis.frames?.length && !zoomed ? (
            <div className="clip-frames" aria-hidden="true">
              {analysis.frames.map((src, i) => <img key={i} src={src} alt="" />)}
            </div>
          ) : null}
          <div
            ref={wave}
            className={`ce-wave${real ? "" : " estimated"}${chipsTight ? " tight" : ""}${startOut ? " start-out" : ""}${endOut ? " end-out" : ""}`}
            onPointerDown={waveDown}
            onPointerMove={waveMove}
            onPointerUp={waveUp}
            onPointerCancel={() => { drag.current = null; }}
            style={{ "--s": `${pct(clip.start)}%`, "--e": `${pct(clip.end)}%`, "--fi": `${pct(clip.start + clip.fadeIn)}%`, "--fo": `${pct(clip.end - clip.fadeOut)}%` } as CSSProperties}
          >
            <canvas ref={canvas} className="ce-canvas" aria-hidden="true" />
            <span className="ce-shade left" aria-hidden="true" />
            <span className="ce-shade right" aria-hidden="true" />
            <span className="ce-window" aria-hidden="true" />
            {snapAt !== null ? <span className="ce-snap" style={{ left: `${pct(snapAt)}%` }} aria-hidden="true" /> : null}
            <span ref={head} className="clip-head-rail" aria-hidden="true"><span className="clip-head" /></span>
            {(["start", "end"] as const).map((which) => (
              <button
                key={which}
                type="button"
                className={`clip-handle ${which}${offView(clip[which]) ? " off" : ""}`}
                role="slider"
                aria-label={`Clip ${which}`}
                aria-valuemin={0}
                aria-valuemax={Math.round(duration)}
                aria-valuenow={Math.round(clip[which])}
                aria-valuetext={exact(clip[which])}
                onPointerDown={grab(which)}
                onPointerMove={moveGrab}
                onPointerUp={endGrab}
                onPointerCancel={endGrab}
                onKeyDown={handleKey(which)}
              >
                <span className="grip" />
                <span className="handle-time">{exact(clip[which], chipDigits)}</span>
              </button>
            ))}
            {(["fadeIn", "fadeOut"] as const).map((which) => (
              <button
                key={which}
                type="button"
                className={`ce-fade-knob ${which}${offView(which === "fadeIn" ? clip.start + clip.fadeIn : clip.end - clip.fadeOut) ? " off" : ""}`}
                role="slider"
                aria-label={which === "fadeIn" ? "Fade in length" : "Fade out length"}
                aria-valuemin={0}
                aria-valuemax={fadeMax}
                aria-valuenow={clip[which]}
                aria-valuetext={clip[which] ? `${clip[which].toFixed(1)} seconds` : "Off"}
                title={`${which === "fadeIn" ? "Fade in" : "Fade out"}: drag sideways`}
                onPointerDown={grab(which)}
                onPointerMove={moveGrab}
                onPointerUp={endGrab}
                onPointerCancel={endGrab}
                onKeyDown={handleKey(which)}
              />
            ))}
          </div>
          <div className="ce-mini" onPointerDown={miniPan} onPointerMove={miniPan} onPointerUp={() => { drag.current = null; }} title="Drag to move along the song" style={{ "--vf": view.from / duration, "--vt": view.to / duration } as CSSProperties}>
            <canvas ref={mini} aria-hidden="true" />
            <span className="ce-viewport" aria-hidden="true" />
            <span ref={miniHead} className="ce-mini-head" aria-hidden="true" />
          </div>
        </div>

        <div className="ce-transport">
          <TimeField label="Start" value={clip.start} onCommit={(v) => change((c) => ({ ...c, start: v }), "start")} onNudge={(d) => change((c) => ({ ...c, start: c.start + d }), "start")} onMark={() => markStart()} markLabel="Start here" markIcon="markIn" canMark={canMark} />
          <div className="ce-center">
            <div className="ce-play">
              <button type="button" className={`icon-btn ce-loop${loop ? " on" : ""}`} onClick={() => setLoop(!loop)} aria-pressed={loop} aria-label="Loop the clip" title="Loop while previewing (L)">
                <Icon name="repeat" size={20} />
              </button>
              <button
                type="button"
                className={`play-main clip-preview${previewing ? " playing" : ""}`}
                data-autofocus
                onClick={playPause}
                aria-label={previewing ? "Pause" : "Preview the clip"}
                title={previewing ? "Pause (Space)" : "Preview (Space)"}
              >
                <span className="pm-icon pm-play"><Icon name="play" size={22} /></span>
                <span className="pm-icon pm-pause"><Icon name="pause" size={22} /></span>
              </button>
              <button type="button" className="ce-pill ce-ending" onClick={hearEnding} title={`Hear the last ${ENDING} seconds`}>
                <Icon name="markOut" size={15} />Ending
              </button>
            </div>
            <div className="clip-length">
              <small>{plain ? "Whole song" : "Clip"}</small>
              <strong>{exact(clip.end - clip.start, span < 20 ? 2 : 1)}</strong>
              {plain || phone ? null : <span className="muted small">of {formatTime(duration)}</span>}
            </div>
          </div>
          <TimeField label="End" value={clip.end} onCommit={(v) => change((c) => ({ ...c, end: v }), "end")} onNudge={(d) => change((c) => ({ ...c, end: c.end + d }), "end")} onMark={() => markEnd()} markLabel="End here" markIcon="markOut" canMark={canMark} />
        </div>

        <div className="ce-extras">
          <FadeField label="Fade in" value={clip.fadeIn} max={Math.max(0, fadeMax - clip.fadeOut)} onStep={(d) => change((c) => ({ ...c, fadeIn: Math.max(0, Math.round((c.fadeIn + d) * 2) / 2) }), "fadeIn")} />
          <FadeField label="Fade out" value={clip.fadeOut} max={Math.max(0, fadeMax - clip.fadeIn)} onStep={(d) => change((c) => ({ ...c, fadeOut: Math.max(0, Math.round((c.fadeOut + d) * 2) / 2) }), "fadeOut")} />
          <div className="ce-fade">
            <span className="ce-label">Fade shape</span>
            <div className="segmented sm ce-shapes" role="group" aria-label="Fade shape">
              {SHAPES.map(([value, label]) => (
                <button key={value} type="button" className={clip.shape === value ? "on" : ""} aria-pressed={clip.shape === value} disabled={!clip.fadeIn && !clip.fadeOut} onClick={() => change((c) => ({ ...c, shape: value }))}>{label}</button>
              ))}
            </div>
          </div>
          <div className="ce-quick">
            <span className="ce-label">Length</span>
            <div className="chips">
              {QUICK.filter((n) => n < duration).map((n) => (
                <button key={n} type="button" className={`chip${Math.abs(clip.end - clip.start - n) < 0.05 ? " on" : ""}`} onClick={() => quick(n)} aria-pressed={Math.abs(clip.end - clip.start - n) < 0.05}>{n}s</button>
              ))}
            </div>
          </div>
        </div>

        <p className="muted small clip-help">
          <span className="ce-status" role="status">{real ? "" : analysis.failed ? "This song's file couldn't be read, so the waveform is only an outline; snapping and trimming silence need it. " : "Reading the song's waveform… "}</span>
          <span className="ce-howto">{touch
            ? "Drag the handles or dots to trim and fade, drag inside the clip to move it, or drag outside it to choose a new part."
            : <>Drag inside the clip to move it, outside (or with Shift) to choose a new part. Scroll to zoom. <kbd className="kbd">Space</kbd> play · <kbd className="kbd">I</kbd> <kbd className="kbd">O</kbd> mark · <kbd className="kbd">L</kbd> loop · <kbd className="kbd">Alt</kbd> no snap</>}</span>
        </p>
      </div>
    </Shell>
  );
}
