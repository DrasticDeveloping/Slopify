import { useMemo, useState, type CSSProperties } from "react";
import { paletteFromSeed } from "../data/library";
import { mixSeed, mixSongs, type Mix } from "../recommend/mixes";
import { useStore } from "../state/store";
import { navigate } from "../state/actions";
import { Art } from "./Artwork";
import { Card } from "./Shelf";

const KIND = { weekly: "Weekly", daily: "Daily", repeat: "On repeat" } as const;

/** The covers and artist names of a mix's songs (library songs first, then its new finds), each once. */
export function useMixFaces(mix: Mix) {
  const tracks = useStore((s) => s.tracks);
  const albums = useStore((s) => s.albums);
  const artists = useStore((s) => s.artists);
  return useMemo(() => {
    const images: string[] = [];
    const names: string[] = [];
    // One name per artist: a credit like "Beyoncé, JAY-Z" counts as each of them, however it's spelled.
    const seen = new Set<string>();
    const add = (image: string | undefined, credit: string | undefined) => {
      if (image && !images.includes(image)) images.push(image);
      for (const part of credit?.split(/\s*(?:,|&|\bfeat\.?|\bft\.|\bwith\b)\s*/iu) ?? []) {
        const name = part.trim();
        const key = name.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase();
        if (key && !seen.has(key)) {
          seen.add(key);
          names.push(name);
        }
      }
    };
    for (const id of mix.libraryIds) {
      const t = tracks[id];
      if (t) add(albums[t.albumId]?.artworkUrl, artists[t.artistId]?.name);
    }
    for (const song of mixSongs(mix)) add(song.artwork, song.artist);
    // A few spare covers, so one that won't load can be swapped out of a collage.
    return { images: images.slice(0, 8), names };
  }, [mix, tracks, albums, artists]);
}

/** "Treb, Lady Gaga and Tanger": who's in a mix, as a mix card's subtitle says it. */
export function featuring(names: string[], max = 3) {
  const shown = names.slice(0, max);
  if (shown.length < 2) return shown[0] ?? "";
  return names.length > max ? `${shown.join(", ")} and more` : `${shown.slice(0, -1).join(", ")} and ${shown.at(-1)}`;
}

/**
 * A mix's cover, made from its own music: four of its songs' covers (or one, if it has fewer),
 * with a band in the mix's colour carrying its name, as Spotify's Daily Mix covers do.
 * `bare` leaves the name off (where the name is set beside the cover).
 */
/** Covers that failed to load this session, so no collage shows a broken image (some sources expire). */
const failedCovers = new Set<string>();

export function MixArt({ mix, bare, className }: { mix: Mix; bare?: boolean; className?: string }) {
  const faces = useMixFaces(mix).images;
  const [, setFailures] = useState(0);
  const images = faces.filter((src) => !failedCovers.has(src)).slice(0, 4);
  const fail = (src: string) => {
    failedCovers.add(src);
    setFailures((n) => n + 1);
  };
  const palette = paletteFromSeed(mixSeed(mix));
  const glyph = mix.kind === "weekly" ? 5 : 2;
  return (
    <div className={`mix-cover${className ? ` ${className}` : ""}`} style={{ "--band": palette.b, "--band-2": palette.c } as CSSProperties}>
      {images.length >= 4 ? (
        <div className="mix-collage" aria-hidden="true">
          {images.map((src) => <img key={src} src={src} alt="" loading="lazy" decoding="async" referrerPolicy="no-referrer" onError={() => fail(src)} />)}
        </div>
      ) : (
        <Art palette={palette} glyph={glyph} image={images[0]} />
      )}
      {bare ? null : (
        <span className="mix-band">
          <span className="mix-tag">{KIND[mix.kind]}</span>
          <span className="mix-label">{mix.name}</span>
        </span>
      )}
    </div>
  );
}

/** A Made for you card: the mix's cover, and who's in it. */
export function MixCard({ mix }: { mix: Mix }) {
  const { names } = useMixFaces(mix);
  return <Card art={<MixArt mix={mix} />} title={mix.name} subtitle={names.length ? featuring(names) : mix.description} onOpen={() => navigate({ name: "mix", id: mix.id })} />;
}
