import { useEffect, useRef, type RefObject } from "react";
import { engine } from "../audio/engine";
import { onLiveFrame } from "../lib/live";

/** Opacity steps the bars are drawn in: one fill per step, rather than one per bar. */
const SHADES = 8;
/** How often the theme's colours are read again (they change only with the theme or the song's palette). */
const COLOURS_EVERY = 1000;

/**
 * Frequency bars drawn from the shared analyser. Also publishes a smoothed
 * bass "energy" value as a CSS variable on `pulseTarget` so artwork can breathe
 * with the music. With reduced motion it draws its bars once, at rest. Once paused
 * and settled it stops drawing until playback moves again (see lib/live.ts).
 */
export function Visualizer({ pulseTarget, bars = 64, reduced }: { pulseTarget?: RefObject<HTMLElement | null>; bars?: number; reduced?: boolean }) {
  const canvas = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const el = canvas.current;
    if (!el) return;
    const ctx = el.getContext("2d");
    if (!ctx) return;
    let energy = 0;
    let shownEnergy = "";
    const heights = new Float32Array(bars);
    let data: Uint8Array<ArrayBuffer> | null = null;
    let fill: CanvasGradient | null = null;
    let coloursAt = -Infinity;
    let last = 0;

    const colours = (h: number, now: number) => {
      if (fill && now - coloursAt < COLOURS_EVERY) return fill;
      const style = getComputedStyle(el);
      const a = style.getPropertyValue("--accent").trim() || "#8b5cf6";
      const b = style.getPropertyValue("--accent-2").trim() || "#ec4899";
      fill = ctx.createLinearGradient(0, h, 0, 0);
      fill.addColorStop(0, a);
      fill.addColorStop(1, b);
      coloursAt = now;
      return fill;
    };

    const resize = () => {
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      el.width = el.clientWidth * dpr;
      el.height = el.clientHeight * dpr;
      fill = null;
      draw();
    };
    const draw = () => {
      const now = performance.now();
      // The bars ease by time, not per frame, so they move the same at any frame rate (see lib/live.ts).
      const frames = last ? Math.min(4, (now - last) / (1000 / 60)) : 1;
      last = now;
      const rise = 1 - 0.5 ** frames;
      const fall = 1 - 0.88 ** frames;
      const analyser = reduced ? null : engine.analyser;
      const w = el.width;
      const h = el.height;
      ctx.clearRect(0, 0, w, h);
      if (analyser) {
        if (!data || data.length !== analyser.frequencyBinCount) data = new Uint8Array(analyser.frequencyBinCount);
        analyser.getByteFrequencyData(data);
      }
      const playing = engine.playing;
      ctx.fillStyle = colours(h, now);
      const gap = Math.max(2, w / bars / 4);
      const bw = w / bars - gap;
      const radius = Math.min(4, bw / 2);
      const shades: number[][] = Array.from({ length: SHADES + 1 }, () => []);
      let bass = 0;
      let moving = false;
      for (let i = 0; i < bars; i++) {
        // Log-spaced bins so low and mid frequencies get most of the width.
        const bin = data ? Math.min(data.length - 1, Math.floor(Math.pow(i / bars, 1.7) * data.length * 0.7) + 1) : 0;
        const v = data && playing ? data[bin] / 255 : 0;
        if (i < 6) bass += v / 6;
        heights[i] += (v - heights[i]) * (v > heights[i] ? rise : fall);
        if (heights[i] > 0.002) moving = true;
        shades[Math.round(heights[i] * SHADES)].push(i);
      }
      // Taller bars are more opaque; bars of a like height are filled together.
      shades.forEach((group, shade) => {
        if (!group.length) return;
        ctx.globalAlpha = 0.35 + (shade / SHADES) * 0.65;
        ctx.beginPath();
        for (const i of group) {
          const bh = Math.max(2, heights[i] * h * 0.95);
          ctx.roundRect(i * (bw + gap) + gap / 2, h - bh, bw, bh, radius);
        }
        ctx.fill();
      });
      ctx.globalAlpha = 1;
      energy += (bass - energy) * (1 - 0.82 ** frames);
      // Only a visible change touches the page: each one restyles the artwork and its glow.
      const next = energy.toFixed(2);
      if (pulseTarget?.current && !reduced && next !== shownEnergy) {
        shownEnergy = next;
        pulseTarget.current.style.setProperty("--energy", next);
      }
      // Still falling back to rest after a pause: keep drawing until it's there.
      return moving || energy > 0.002;
    };
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(el);
    const stop = reduced ? () => undefined : onLiveFrame(draw);
    return () => {
      stop();
      ro.disconnect();
    };
  }, [bars, pulseTarget, reduced]);

  return <canvas ref={canvas} className="visualizer" aria-hidden="true" />;
}
