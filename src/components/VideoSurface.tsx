import { useLayoutEffect, useRef, useSyncExternalStore } from "react";
import { attachVideoHost, useHasVideo } from "../audio/video";
import { TrackArt } from "./Artwork";

/**
 * Shows the playing video in place of cover art. The art stays underneath until
 * the video has loaded (e.g. after a reload, before Play is pressed).
 */
export function VideoSurface({ trackId, priority, label }: { trackId: string; priority: number; label?: boolean }) {
  const host = useRef<HTMLDivElement>(null);
  const hasVideo = useHasVideo();

  useLayoutEffect(() => {
    if (!host.current) return;
    return attachVideoHost(host.current, priority);
  }, [priority]);

  return (
    <div className={`video-surface${hasVideo ? " has-video" : ""}`}>
      <TrackArt trackId={trackId} label={label} />
      <div ref={host} className="video-host" />
    </div>
  );
}

/**
 * Full screen covers the whole app rather than the bare <video>, so the player's
 * own controls, menus and toasts keep working on top of it.
 */
export function toggleFullscreen() {
  if (document.fullscreenElement) void document.exitFullscreen().catch(() => undefined);
  else if (document.fullscreenEnabled) void document.documentElement.requestFullscreen().catch(() => undefined);
}

function subscribeFullscreen(listener: () => void) {
  document.addEventListener("fullscreenchange", listener);
  return () => document.removeEventListener("fullscreenchange", listener);
}

export function useIsFullscreen() {
  return useSyncExternalStore(subscribeFullscreen, () => document.fullscreenElement !== null);
}
