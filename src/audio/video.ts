import { useSyncExternalStore } from "react";

/*
 * The engine plays video tracks through a <video> element. It must stay in the
 * document the whole time (removing a media element pauses it), so it lives in a
 * hidden parking spot and moves into whichever on-screen host has the highest
 * priority: the full-screen player over the side panel.
 */

let current: HTMLVideoElement | null = null;
let park: HTMLDivElement | null = null;
const hosts: Array<{ el: HTMLElement; priority: number }> = [];
const listeners = new Set<() => void>();

function parking() {
  if (!park) {
    park = document.createElement("div");
    park.className = "video-park";
    park.setAttribute("aria-hidden", "true");
    document.body.appendChild(park);
  }
  return park;
}

function place() {
  if (!current) return;
  // Highest priority wins; among equals, the most recently attached host.
  let best: (typeof hosts)[number] | null = null;
  for (const h of hosts) if (!best || h.priority >= best.priority) best = h;
  const target = best?.el ?? parking();
  if (current.parentElement !== target) target.appendChild(current);
}

function notify() {
  listeners.forEach((l) => l());
}

/** Makes `el` the visible video (or clears it). Called by the engine. */
export function setCurrentVideo(el: HTMLVideoElement | null) {
  if (current === el) return;
  if (current) parking().appendChild(current);
  current = el;
  place();
  notify();
}

/** An outgoing video keeps playing out of sight while it fades, then is removed. */
export function releaseVideo(el: HTMLVideoElement, removeAfterMs: number) {
  if (current === el) {
    current = null;
    notify();
  }
  parking().appendChild(el);
  window.setTimeout(() => el.remove(), removeAfterMs);
}

export function attachVideoHost(el: HTMLElement, priority: number) {
  const entry = { el, priority };
  hosts.push(entry);
  place();
  return () => {
    const i = hosts.indexOf(entry);
    if (i >= 0) hosts.splice(i, 1);
    if (current?.parentElement === el) parking().appendChild(current);
    place();
  };
}

export function currentVideo() {
  return current;
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Whether a video is loaded in the player right now. */
export function useHasVideo() {
  return useSyncExternalStore(subscribe, () => current !== null);
}

// Live audio and app state cannot be swapped in place: when this module (or anything it imports) changes, reload the page.
if (import.meta.hot) import.meta.hot.accept(() => location.reload());
