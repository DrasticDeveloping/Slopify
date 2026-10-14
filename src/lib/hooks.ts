import { useEffect, useRef, useState, type RefObject } from "react";
import { engine } from "../audio/engine";
import { effectiveRange, positionOf } from "../state/actions";
import { getState, useStore } from "../state/store";

/** Writes a live value into an element's text every frame without re-rendering React. */
export function useLiveText<T extends HTMLElement>(read: () => string): RefObject<T | null> {
  const ref = useRef<T>(null);
  const readRef = useRef(read);
  readRef.current = read;
  useEffect(() => {
    let raf = 0;
    let last = "";
    const loop = () => {
      const text = readRef.current();
      if (text !== last && ref.current) {
        ref.current.textContent = text;
        last = text;
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, []);
  return ref;
}

export function useCurrent() {
  const id = useStore((s) => s.currentId);
  const track = useStore((s) => (s.currentId ? s.tracks[s.currentId] : null));
  const artist = useStore((s) => (track ? s.artists[track.artistId] : null));
  const album = useStore((s) => (track ? s.albums[track.albumId] : null));
  const clip = useStore((s) => (s.currentId ? s.clips[s.currentId] : undefined));
  const draft = useStore((s) => s.clipDraft);
  const range = id ? effectiveRange(id) : { start: 0, end: 0 };
  // clip/draft are read so the component re-renders when the range changes.
  void clip;
  void draft;
  return { id, track, artist, album, range };
}

/** Polls the playing position (or where a cued song will start); stable function identity for Slider.poll. */
export const pollPosition = () => {
  const id = getState().currentId;
  return id ? positionOf(id) : engine.position;
};

export function useMediaQuery(query: string) {
  const [match, setMatch] = useState(() => window.matchMedia(query).matches);
  useEffect(() => {
    const mq = window.matchMedia(query);
    const on = () => setMatch(mq.matches);
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, [query]);
  return match;
}

export function useOnClickOutside(ref: RefObject<HTMLElement | null>, handler: () => void, active = true) {
  useEffect(() => {
    if (!active) return;
    const on = (e: PointerEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) handler();
    };
    document.addEventListener("pointerdown", on, true);
    return () => document.removeEventListener("pointerdown", on, true);
  }, [ref, handler, active]);
}
