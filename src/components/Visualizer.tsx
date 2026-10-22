import { useEffect, useRef, type RefObject } from "react";
import { engine } from "../audio/engine";
import { onLiveFrame } from "../lib/live";

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
    const heights = new Float32Array(bars);
    let data: Uint8Array<ArrayBuffer> | null = null;

    const resize = () => {
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      el.width = el.clientWidth * dpr;
      el.height = el.clientHeight * dpr;
      draw();
    };
    const draw = () => {
      const analyser = reduced ? null : engine.analyser;
      const w = el.width;
      const h = el.height;
      ctx.clearRect(0, 0, w, h);
      if (analyser) {
        if (!data || data.length !== analyser.frequencyBinCount) data = new Uint8Array(analyser.frequencyBinCount);
        analyser.getByteFrequencyData(data);
      }
      const playing = engine.playing;
      const style = getComputedStyle(el);
      const a = style.getPropertyValue("--accent").trim() || "#8b5cf6";
      const b = style.getPropertyValue("--accent-2").trim() || "#ec4899";
      const grad = ctx.createLinearGradient(0, h, 0, 0);
      grad.addColorStop(0, a);
      grad.addColorStop(1, b);
      ctx.fillStyle = grad;
      const gap = Math.max(2, w / bars / 4);
      const bw = w / bars - gap;
      let bass = 0;
      let moving = false;
      for (let i = 0; i < bars; i++) {
        // Log-spaced bins so low and mid frequencies get most of the width.
        const bin = data ? Math.min(data.length - 1, Math.floor(Math.pow(i / bars, 1.7) * data.length * 0.7) + 1) : 0;
        const v = data && playing ? data[bin] / 255 : 0;
        if (i < 6) bass += v / 6;
        heights[i] += (v - heights[i]) * (v > heights[i] ? 0.5 : 0.12);
        if (heights[i] > 0.002) moving = true;
        const bh = Math.max(2, heights[i] * h * 0.95);
        const x = i * (bw + gap) + gap / 2;
        ctx.globalAlpha = 0.35 + heights[i] * 0.65;
        ctx.beginPath();
        ctx.roundRect(x, h - bh, bw, bh, Math.min(4, bw / 2));
        ctx.fill();
      }
      ctx.globalAlpha = 1;
      energy += (bass - energy) * 0.18;
      if (pulseTarget?.current && !reduced) pulseTarget.current.style.setProperty("--energy", energy.toFixed(3));
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
