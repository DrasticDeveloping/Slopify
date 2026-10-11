import { useEffect, useState } from "react";
import { hashString, paletteFromSeed } from "../data/library";
import { navigate } from "../state/actions";
import { getState, setState } from "../state/store";
import { Shelf } from "./Shelf";
import { Art } from "./Artwork";

interface ArtistResult {
  id: string;
  name: string;
  musicBrainzId?: string;
  image?: string;
  description: string;
}

export function ExternalArtists({ query, showStatus = true }: { query: string; showStatus?: boolean }) {
  const [result, setResult] = useState<{ query: string; artists: ArtistResult[]; partial: boolean } | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setResult(null); setLoading(true); setError("");
    const timer = window.setTimeout(() => {
      void fetch("/api/metadata/artists", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ query }), signal: AbortSignal.any([controller.signal, AbortSignal.timeout(25_000)]) }).then(async (res) => {
        const body = await res.json();
        if (!res.ok || !body.ok || !Array.isArray(body.result?.artists)) throw new Error(body.error?.message || "Artist search is unavailable. Try again.");
        if (!controller.signal.aborted) setResult({ query, ...body.result });
      }).catch((e: unknown) => { if (!controller.signal.aborted) setError(e instanceof Error ? e.message : "Couldn't search artists."); }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    }, 650);
    return () => { window.clearTimeout(timer); controller.abort(); };
  }, [query, retry]);
  const open = (found: ArtistResult) => {
    const s = getState();
    const existing = Object.values(s.artists).find((a) => a.name.toLowerCase() === found.name.toLowerCase() && (!a.musicBrainzId || a.musicBrainzId === found.musicBrainzId));
    const seed = hashString(found.id);
    const artist = { ...(existing || { id: `ar_online_${found.id}`, name: found.name, genre: "indie" as const, listeners: 0, palette: paletteFromSeed(seed) }), ...(found.image ? { image: found.image } : {}), ...(found.musicBrainzId ? { musicBrainzId: found.musicBrainzId } : {}) };
    setState({ artists: { ...s.artists, [artist.id]: artist } });
    navigate({ name: "artist", id: artist.id });
  };
  const artists = result?.query === query ? result.artists : [];
  if (!showStatus && !artists.length) return null;
  return <section className="external-artists" aria-label="Artists from online metadata">
    {loading ? <p className="muted search-progress" role="status"><span className="spinner" />Searching artists…</p> : null}
    {error ? <p className="muted" role="alert">{error} <button type="button" className="text-btn" onClick={() => setRetry((n) => n + 1)}>Retry</button></p> : null}
    {artists.length ? <Shelf title="Artists online" subtitle={result?.partial ? "Some artist sources are temporarily unavailable" : "Open an artist to see their profile, popular songs and releases"}>{artists.map((a) => <button type="button" className="card round online-artist-card" key={a.id} aria-label={`Open artist ${a.name}${a.description ? `, ${a.description}` : ""}`} onClick={() => open(a)}><span className="card-art"><Art palette={paletteFromSeed(hashString(a.id))} glyph={4} round image={a.image} /></span><span className="card-link"><strong>{a.name}</strong><span>{a.description || "Artist"}</span></span></button>)}</Shelf> : !loading && !error ? <p className="muted">No artists found for “{query}”. Try another name.</p> : null}
  </section>;
}
