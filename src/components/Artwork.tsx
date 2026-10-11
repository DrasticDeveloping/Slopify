import { memo, useState, type CSSProperties } from "react";
import type { Palette, Playlist } from "../data/types";
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
  if (covers.length < 4) return <Art palette={playlist.palette} glyph={playlist.name.length % 6} className={className} />;
  return (
    <div className={`art mosaic ${className ?? ""}`} aria-hidden="true">
      {covers.map((id) => <Art key={id} palette={albums[id].palette} glyph={albums[id].glyph} image={albums[id].artworkUrl} />)}
    </div>
  );
}
