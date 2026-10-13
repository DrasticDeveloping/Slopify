import { useEffect, useState } from "react";
import { hashString, paletteFromSeed } from "../data/library";
import { openArtist } from "../recommend/artist";
import { Art } from "./Artwork";
import { Shelf } from "./Shelf";

interface ArtistResult {
  id: string;
  name: string;
  musicBrainzId?: string;
  image?: string;
  description: string;
}
interface SearchResult { query: string; artists: ArtistResult[]; partial: boolean }

/** Waits this long after typing stops before searching. */
const DEBOUNCE = 650;

async function searchArtists(query: string, signal: AbortSignal): Promise<SearchResult> {
  const res = await fetch("/api/metadata/artists", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query }),
    signal: AbortSignal.any([signal, AbortSignal.timeout(25_000)]),
  });
  const body = await res.json();
  if (!res.ok || !body.ok || !Array.isArray(body.result?.artists)) throw new Error(body.error?.message || "Artist search is unavailable. Try again.");
  return { query, ...body.result };
}

/** Artists matching a search, from online metadata. Without `showStatus` it shows only when there are results. */
export function ExternalArtists({ query, showStatus = true }: { query: string; showStatus?: boolean }) {
  const [result, setResult] = useState<SearchResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    const live = () => !controller.signal.aborted;
    setResult(null);
    setLoading(true);
    setError("");
    const timer = window.setTimeout(() => {
      searchArtists(query, controller.signal)
        .then((found) => live() && setResult(found))
        .catch((e: unknown) => live() && setError(e instanceof Error ? e.message : "Couldn't search artists."))
        .finally(() => live() && setLoading(false));
    }, DEBOUNCE);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [query, attempt]);

  const artists = result?.query === query ? result.artists : [];
  if (!showStatus && !artists.length) return null;
  return (
    <section className="external-artists" aria-label="Artists from online metadata">
      {loading ? <p className="muted search-progress" role="status"><span className="spinner" />Searching artists…</p> : null}
      {error ? (
        <p className="muted" role="alert">
          {error} <button type="button" className="text-btn" onClick={() => setAttempt((n) => n + 1)}>Retry</button>
        </p>
      ) : null}
      {artists.length ? (
        <Shelf title="Artists online" subtitle={result?.partial ? "Some artist sources are temporarily unavailable" : "Open an artist to see their profile, popular songs and releases"}>
          {artists.map((a) => (
            <button type="button" className="card round online-artist-card" key={a.id} aria-label={`Open artist ${a.name}${a.description ? `, ${a.description}` : ""}`} onClick={() => openArtist(a)}>
              <span className="card-art">
                <Art palette={paletteFromSeed(hashString(a.id))} glyph={4} round image={a.image} />
              </span>
              <span className="card-link">
                <strong>{a.name}</strong>
                <span>{a.description || "Artist"}</span>
              </span>
            </button>
          ))}
        </Shelf>
      ) : !loading && !error ? (
        <p className="muted">No artists found for “{query}”. Try another name.</p>
      ) : null}
    </section>
  );
}
