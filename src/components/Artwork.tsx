import { memo, useEffect, useRef, useState, type CSSProperties } from "react";
import type { Palette, Playlist } from "../data/types";
import { useCurrentVideo } from "../audio/video";
import { onLiveFrame } from "../lib/live";
import { useStore } from "../state/store";
import { Icon } from "./Icon";

const glyphs = [
  // rings
  <g key="0" fill="none" stroke="#fff" strokeOpacity=".22" strokeWidth="1.4"><circle cx="70" cy="62" r="14" /><circle cx="70" cy="62" r="24" /><circle cx="70" cy="62" r="34" /><circle cx="70" cy="62" r="44" strokeOpacity=".12" /></g>,
  // sun over horizon
  <g key="1"><circle cx="50" cy="56" r="24" fill="#fff" fillOpacity=".24" />{[0, 1, 2, 3, 4].map((i) => <rect key={i} x="0" y={62 + i * 7} width="100" height={2 + i * 0.6} fill="#000" fillOpacity=".16" />)}<path d="M0 74h100" stroke="#fff" strokeOpacity=".35" /></g>,
  // waves
  <g key="2" fill="none" stroke="#fff" strokeOpacity=".24" strokeWidth="1.6">{[0, 1, 2, 3, 4, 5].map((i) => <path key={i} d={`M-5 ${30 + i * 10} C 20 ${20 + i * 10}, 40 ${44 + i * 10}, 60 ${32 + i * 10} S 95 ${24 + i * 10}, 110 ${34 + i * 10}`} />)}</g>,
  // dot grid
  <g key="3" fill="#fff" fillOpacity=".22">{Array.from({ length: 36 }, (_, i) => <circle key={i} cx={18 + (i % 6) * 13} cy={18 + Math.floor(i / 6) * 13} r={1.2 + ((i * 7) % 5) * 0.5} />)}</g>,
  // orb
  <g key="4"><circle cx="32" cy="34" r="30" fill="#fff" fillOpacity=".14" /><circle cx="74" cy="78" r="18" fill="#000" fillOpacity=".18" /></g>,
  // prism
  <g key="5"><path d="M50 14 88 84H12z" fill="#fff" fillOpacity=".14" /><path d="M50 14 88 84H50z" fill="#000" fillOpacity=".12" /></g>,
];

interface ArtProps {
  palette: Palette;
  glyph?: number;
  className?: string;
  round?: boolean;
  label?: string;
  style?: CSSProperties;
  icon?: string;
  /** Real cover image, layered over the generated art (which shows if it fails to load). */
  image?: string;
}

function CoverImage({ src }: { src: string }) {
  const [failed, setFailed] = useState(false);
  if (failed) return null;
  return <img className="art-img" src={src} alt="" loading="lazy" decoding="async" draggable={false} onError={() => setFailed(true)} />;
}

export const Art = memo(function Art({ palette, glyph = 0, className, round, label, style, icon, image }: ArtProps) {
  return (
    <div
      className={`art${round ? " round" : ""}${className ? ` ${className}` : ""}`}
      style={{ "--a": palette.a, "--b": palette.b, "--c": palette.c, ...style } as CSSProperties}
      role={label ? "img" : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
    >
      {icon ? (
        <Icon name={icon} className="art-icon" />
      ) : (
        <svg viewBox="0 0 100 100" preserveAspectRatio="xMidYMid slice">{glyphs[glyph % glyphs.length]}</svg>
      )}
      {image ? <CoverImage key={image} src={image} /> : null}
    </div>
  );
});

export function TrackArt({ trackId, className, label }: { trackId: string; className?: string; label?: boolean }) {
  const track = useStore((s) => s.tracks[trackId]);
  const album = useStore((s) => (track ? s.albums[track.albumId] : undefined));
  if (!track || !album) return <div className={`art ${className ?? ""}`} />;
  return <Art palette={album.palette} glyph={album.glyph} image={album.artworkUrl} className={className} label={label ? `${album.title} artwork` : undefined} />;
}

/** Pixels down the backdrop's canvas: heavily blurred, it needs no more, and stretching it costs nothing. */
const BACKDROP_SIZE = 96;
/** New frames a second for a video's backdrop: blurred this much, more would look no different. */
const VIDEO_BACKDROP_FPS = 10;
/** Slack for the frame loop, which lands on display refreshes: a frame due a few ms from now is taken now. */
const EARLY_FRAME = 4;

/** Draws `source` over the whole canvas and `pad` past each edge, cropped from its middle to fit (as object-fit: cover). */
function drawCovered(ctx: CanvasRenderingContext2D, source: CanvasImageSource, sw: number, sh: number, pad: number) {
  const w = ctx.canvas.width + pad * 2;
  const h = ctx.canvas.height + pad * 2;
  const scale = Math.max(w / sw, h / sh);
  ctx.drawImage(source, (sw - w / scale) / 2, (sh - h / scale) / 2, w / scale, h / scale, -pad, -pad, w, h);
}

/**
 * A song's art as a soft wash of colour (the full player's backdrop). It's blurred once, into a small canvas
 * stretched to fill, because a CSS blur that size was recomputed on every frame the player drew.
 *
 * With `video`, the playing video shows through instead, a few frames a second. Blurring the video itself
 * meant blurring the whole screen again for every frame of the video.
 */
export function BlurredTrackArt({ trackId, className, video = false }: { trackId: string; className?: string; video?: boolean }) {
  const track = useStore((s) => s.tracks[trackId]);
  const album = useStore((s) => (track ? s.albums[track.albumId] : undefined));
  const canvas = useRef<HTMLCanvasElement>(null);
  const palette = album?.palette;
  const image = album?.artworkUrl;
  const playing = useCurrentVideo();
  const source = video ? playing : null;
  const height = BACKDROP_SIZE;
  // A video's wash is as wide as the video, so it fills the screen as the video would.
  const width = video ? Math.round((height * 16) / 9) : height;

  useEffect(() => {
    const ctx = canvas.current?.getContext("2d");
    if (!ctx || !palette) return;
    // Blurred past its edges as well as inside, so the wash stays solid to the canvas edge.
    const pad = height * 0.25;
    const filter = `blur(${height / 18}px) saturate(1.4)`;
    let showingVideo = false;
    const paint = (cover?: HTMLImageElement) => {
      // Once the video shows, a cover that loads late doesn't cover it up again.
      if (showingVideo) return;
      const w = width;
      const h = height;
      const r = Math.max(w, h);
      ctx.clearRect(0, 0, w, h);
      ctx.filter = filter;
      // The generated art (see .art in app.css), beneath any cover.
      const clear = (color: string) => {
        ctx.fillStyle = color;
        const solid = ctx.fillStyle;
        // Normalised to #rrggbb or rgba(): the same colour, fully transparent, so gradients fade without greying.
        return solid.startsWith("#") ? `${solid}00` : solid.replace(/[\d.]+\)$/, "0)");
      };
      const base = ctx.createLinearGradient(-pad, -pad, w + pad, h + pad);
      base.addColorStop(0, palette.b);
      base.addColorStop(1, palette.c);
      ctx.fillStyle = base;
      ctx.fillRect(-pad, -pad, w + pad * 2, h + pad * 2);
      const corner = ctx.createRadialGradient(w, h, 0, w, h, r * 0.7);
      corner.addColorStop(0, palette.c);
      corner.addColorStop(1, clear(palette.c));
      ctx.fillStyle = corner;
      ctx.fillRect(-pad, -pad, w + pad * 2, h + pad * 2);
      const glow = ctx.createRadialGradient(w * 0.15, h * 0.1, 0, w * 0.15, h * 0.1, r * 0.72);
      glow.addColorStop(0, palette.a);
      glow.addColorStop(1, clear(palette.a));
      ctx.fillStyle = glow;
      ctx.fillRect(-pad, -pad, w + pad * 2, h + pad * 2);
      // Cropped from its middle, as the cover shows elsewhere.
      if (cover) drawCovered(ctx, cover, cover.naturalWidth, cover.naturalHeight, pad);
      ctx.filter = "none";
    };
    paint();

    let last = -Infinity;
    const frame = () => {
      if (!source || source.readyState < HTMLMediaElement.HAVE_CURRENT_DATA || !source.videoWidth) return;
      last = performance.now();
      showingVideo = true;
      ctx.filter = filter;
      drawCovered(ctx, source, source.videoWidth, source.videoHeight, pad);
      ctx.filter = "none";
    };
    // Follows playback on the shared frame loop, taking every few frames; a seek or a first frame shows at once.
    const stopFrames = source
      ? onLiveFrame(() => {
          if (performance.now() - last >= 1000 / VIDEO_BACKDROP_FPS - EARLY_FRAME) frame();
        })
      : undefined;
    source?.addEventListener("loadeddata", frame);
    source?.addEventListener("seeked", frame);

    // Covers from elsewhere still draw (the canvas is only shown, never read back).
    const cover = image ? new Image() : null;
    let live = true;
    if (cover && image) {
      cover.decoding = "async";
      cover.onload = () => {
        if (live) paint(cover);
      };
      cover.src = image;
    }
    return () => {
      live = false;
      if (cover) cover.onload = null;
      stopFrames?.();
      source?.removeEventListener("loadeddata", frame);
      source?.removeEventListener("seeked", frame);
    };
  }, [palette, image, source, width, height]);

  return <canvas ref={canvas} width={width} height={height} className={className} aria-hidden="true" />;
}

export function PlaylistArt({ playlist, className }: { playlist: Playlist; className?: string }) {
  const tracks = useStore((s) => s.tracks);
  const albums = useStore((s) => s.albums);
  if (playlist.id === "liked") return <Art palette={playlist.palette} icon="heartFill" className={`liked-art ${className ?? ""}`} />;
  const covers: string[] = [];
  for (const id of playlist.trackIds) {
    const albumId = tracks[id]?.albumId;
    if (albumId && albums[albumId] && !covers.includes(albumId)) covers.push(albumId);
    if (covers.length === 4) break;
  }
  if (!covers.length) return <Art palette={playlist.palette} glyph={playlist.name.length % 6} className={className} />;
  if (covers.length === 1) {
    const album = albums[covers[0]];
    return <Art palette={album.palette} glyph={album.glyph} image={album.artworkUrl} className={className} />;
  }
  // 2 covers sit side by side, 3 put the first one tall on the left, 4 make a grid.
  return (
    <div className={`art mosaic mosaic-${covers.length} ${className ?? ""}`} aria-hidden="true">
      {covers.map((id) => <Art key={id} palette={albums[id].palette} glyph={albums[id].glyph} image={albums[id].artworkUrl} />)}
    </div>
  );
}
