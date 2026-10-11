import { useLayoutEffect, useRef } from "react";
import { attachVideoHost, currentVideo, useHasVideo } from "../audio/video";
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

export function enterVideoFullscreen() {
  const el = currentVideo();
  if (el && document.fullscreenEnabled) void el.requestFullscreen().catch(() => undefined);
}
