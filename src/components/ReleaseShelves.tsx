import { hashString, paletteFromSeed } from "../data/library";
import { useReleaseShelves, type Release } from "../recommend/releases";
import { navigate } from "../state/actions";
import { Art } from "./Artwork";
import { Card, Shelf, SkeletonCards } from "./Shelf";

const TYPES: Record<string, string> = { album: "Album", single: "Single", ep: "EP", compile: "Compilation" };

/** "Today", "3 days ago", "2 weeks ago" for recent releases. */
function since(released: string) {
  const days = Math.round((Date.now() - new Date(`${released}T12:00:00`).getTime()) / 86_400_000);
  if (days <= 0) return "Today";
  if (days === 1) return "Yesterday";
  if (days < 14) return `${days} days ago`;
  return `${Math.round(days / 7)} weeks ago`;
}

function ReleaseCard({ release, subtitle }: { release: Release; subtitle: string }) {
  const seed = hashString(release.id);
  return (
    <Card
      art={<Art palette={paletteFromSeed(seed)} glyph={seed % 6} image={release.artwork} label={`${release.title} cover`} />}
      title={release.title}
      subtitle={subtitle}
      onOpen={() => navigate({ name: "release", id: release.id })}
    />
  );
}

/** Release Radar and Albums for you, from the music catalog. Nothing shows until there's something to show. */
export function ReleaseShelves() {
  const { shelves, loading } = useReleaseShelves();
  if (!shelves) {
    if (!loading) return null;
    return (
      <Shelf title="Release Radar" subtitle="New music from artists you play">
        <SkeletonCards label="Looking for new releases…" />
      </Shelf>
    );
  }
  // Nothing at all (the catalog failing, or a quiet week): Home moves on to what it has.
  return (
    <>
      {shelves.radar.length ? (
        <Shelf title="Release Radar" subtitle="New music from artists you play, from the last eight weeks">
          {shelves.radar.map((r) => <ReleaseCard key={r.id} release={r} subtitle={`${TYPES[r.type] ?? "Release"} · ${r.artist} · ${since(r.released)}`} />)}
        </Shelf>
      ) : null}
      {shelves.albums.length ? (
        <Shelf title="Albums for you" subtitle="Albums by artists you play, and by artists like them">
          {shelves.albums.map((r) => <ReleaseCard key={r.id} release={r} subtitle={`${r.artist} · ${r.released.slice(0, 4)}`} />)}
        </Shelf>
      ) : null}
    </>
  );
}
