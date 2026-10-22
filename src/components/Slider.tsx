import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import { onLiveFrame } from "../lib/live";

interface SliderProps {
  value?: number;
  max: number;
  step?: number;
  /** Reads a live value as playback moves (used by the seek bars; see lib/live.ts) instead of `value`. */
  poll?: () => number;
  onInput?: (v: number) => void;
  onCommit?: (v: number) => void;
  label: string;
  format?: (v: number) => string;
  disabled?: boolean;
  className?: string;
  showTooltip?: boolean;
}

export function Slider({ value, max, step, poll, onInput, onCommit, label, format = (v) => String(Math.round(v)), disabled, className, showTooltip }: SliderProps) {
  const root = useRef<HTMLDivElement>(null);
  const tip = useRef<HTMLSpanElement>(null);
  const drag = useRef<number | null>(null);
  const lastText = useRef("");
  const [dragging, setDragging] = useState(false);
  const safeMax = max > 0 ? max : 1;

  const paint = (v: number) => {
    const el = root.current;
    if (!el) return;
    const p = Math.max(0, Math.min(1, v / safeMax));
    el.style.setProperty("--p", p.toFixed(4));
    const text = format(v);
    if (text !== lastText.current) {
      lastText.current = text;
      el.setAttribute("aria-valuenow", String(Math.round(v * 100) / 100));
      el.setAttribute("aria-valuetext", text);
    }
  };

  useLayoutEffect(() => {
    if (drag.current === null && value !== undefined) paint(value);
  });

  useEffect(() => {
    if (!poll) return;
    return onLiveFrame(() => {
      if (drag.current === null) paint(poll());
    });
    // paint closes over max/format; restart when they change.
  }, [poll, safeMax, format]);

  const valueAt = (clientX: number) => {
    const rect = root.current!.getBoundingClientRect();
    const p = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
    const raw = p * safeMax;
    return step ? Math.round(raw / step) * step : raw;
  };

  const down = (e: PointerEvent<HTMLDivElement>) => {
    if (disabled || e.button !== 0) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    const v = valueAt(e.clientX);
    drag.current = v;
    setDragging(true);
    paint(v);
    onInput?.(v);
  };

  const move = (e: PointerEvent<HTMLDivElement>) => {
    if (showTooltip && tip.current && root.current) {
      const v = valueAt(e.clientX);
      const rect = root.current.getBoundingClientRect();
      tip.current.textContent = format(v);
      tip.current.style.left = `${Math.max(0, Math.min(rect.width, e.clientX - rect.left))}px`;
    }
    if (drag.current === null) return;
    const v = valueAt(e.clientX);
    drag.current = v;
    paint(v);
    onInput?.(v);
  };

  const up = () => {
    if (drag.current === null) return;
    const v = drag.current;
    drag.current = null;
    setDragging(false);
    onCommit?.(v);
  };

  const key = (e: KeyboardEvent<HTMLDivElement>) => {
    if (disabled) return;
    const current = poll ? poll() : value ?? 0;
    const inc = step ?? safeMax / 20;
    let v: number | null = null;
    if (e.key === "ArrowRight" || e.key === "ArrowUp") v = current + inc;
    else if (e.key === "ArrowLeft" || e.key === "ArrowDown") v = current - inc;
    else if (e.key === "PageUp") v = current + safeMax / 10;
    else if (e.key === "PageDown") v = current - safeMax / 10;
    else if (e.key === "Home") v = 0;
    else if (e.key === "End") v = safeMax;
    if (v === null) return;
    e.preventDefault();
    e.stopPropagation();
    v = Math.max(0, Math.min(safeMax, v));
    paint(v);
    onInput?.(v);
    onCommit?.(v);
  };

  return (
    <div
      ref={root}
      className={`slider${dragging ? " dragging" : ""}${disabled ? " disabled" : ""}${className ? ` ${className}` : ""}`}
      role="slider"
      tabIndex={disabled ? -1 : 0}
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={Math.round(safeMax * 100) / 100}
      aria-disabled={disabled || undefined}
      onPointerDown={down}
      onPointerMove={move}
      onPointerUp={up}
      onPointerCancel={up}
      onLostPointerCapture={up}
      onKeyDown={key}
    >
      <div className="slider-track">
        <div className="slider-fill" />
      </div>
      <div className="slider-thumb" />
      {showTooltip ? <span ref={tip} className="slider-tip" aria-hidden="true" /> : null}
    </div>
  );
}
