import { useMemo, useState } from "react";
import { hashString, paletteFromSeed } from "../data/library";
import type { ArtistMetadata, ArtistRelease } from "../recommend/artist";
import { navigate, toast } from "../state/actions";
import { useStore } from "../state/store";
import { Art } from "./Artwork";
import { Icon } from "./Icon";

/*
 * An artist's discography (from their online profiles): the cards on the
 * artist page's shelf and on the full Discography page, newest first.
 */

/** Newest first, by the most precise date known; releases without a date go last. */
export function byRecency(releases: ArtistRelease[]) {
  const when = (r: ArtistRelease) => r.released || r.year || "";
  return [...releases].sort((a, b) => when(b).localeCompare(when(a)) || a.title.localeCompare(b.title));
}

/** Every release of these profiles (a collaboration has several), newest first, each once. */
export function discographyOf(profiles: ArtistMetadata[]) {
  const seen = new Set<string>();
  return byRecency(profiles.flatMap((p) => p.releases)).filter((r) => !seen.has(r.id) && seen.add(r.id));
}

/** The filter a release falls under on the Discography page. */
export function releaseKind(r: ArtistRelease): "album" | "single" | "other" {
  const type = r.type.toLowerCase();
  if (type === "album") return "album";
  if (type === "single" || type === "ep") return "single";
  return "other";
}

const bareTitle = (s: string) => s.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");

/**
 * Opens a release from the artist's discography on its page in the app: the
 * same release in the music catalog, found by artist and title. One the catalog
 * doesn't have is searched for instead.
 */
async function openRelease(r: ArtistRelease) {
  try {
    const res = await fetch("/api/catalog/releases", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ artists: [r.artist] }) });
    const body = (await res.json()) as { ok?: boolean; result?: { artists: Array<{ releases: Array<{ id: string; title: string }> }> } };
    const releases = body.ok ? body.result?.artists[0]?.releases ?? [] : [];
    const want = bareTitle(r.title);
    // The same title, else one that only adds an edition ("Love Sick (Deluxe)").
    const match = releases.find((x) => bareTitle(x.title) === want) ?? releases.find((x) => want && bareTitle(x.title).startsWith(want));
    if (match) return navigate({ name: "release", id: match.id });
  } catch {
    // The catalog is unreachable: search instead.
  }
  toast(`“${r.title}” isn't in the music catalog`, { detail: "Showing search results for it instead." });
  navigate({ name: "search", q: `${r.artist} ${r.title}` });
}

/** Library songs per release, matched by album title and artist name. */
export function useOwnedReleases() {
  const tracks = useStore((s) => s.tracks);
  const albums = useStore((s) => s.albums);
  const artists = useStore((s) => s.artists);
  return useMemo(() => {
    const counts = new Map<string, number>();
    for (const t of Object.values(tracks)) {
      if (t.stream) continue;
      const key = `${albums[t.albumId]?.title.toLowerCase()}|${artists[t.artistId]?.name.toLowerCase()}`;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    return counts;
  }, [tracks, albums, artists]);
}

export function ReleaseCards({ releases, owned }: { releases: ArtistRelease[]; owned: Map<string, number> }) {
  const [opening, setOpening] = useState<string | null>(null);
  return (
    <>
      {releases.map((r) => (
        <div className="card" key={r.id}>
          <div className="card-art">
            <Art palette={paletteFromSeed(hashString(r.id))} glyph={3} image={r.artwork} />
          </div>
          <button
            type="button"
            className="card-link"
            disabled={opening === r.id}
            onClick={() => {
              setOpening(r.id);
              void openRelease(r).finally(() => setOpening(null));
            }}
          >
            <strong>{r.title}</strong>
            <span>{opening === r.id ? "Opening…" : [r.year, r.type].filter(Boolean).join(" · ")}</span>
          </button>
          {owned.get(`${r.title.toLowerCase()}|${r.artist.toLowerCase()}`) ? <span className="small muted rec-save"><Icon name="check" size={14} />In your library</span> : null}
        </div>
      ))}
    </>
  );
}
