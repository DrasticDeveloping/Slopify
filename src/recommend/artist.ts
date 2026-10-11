import { useEffect, useState } from "react";
import { getState, setState } from "../state/store";

export interface ArtistMetadata {
  name: string;
  biography: string;
  genres: string[];
  country: string;
  formed: string;
  formedLabel?: string;
  image?: string;
  banner?: string;
  sourceUrl: string;
  biographyUrl?: string;
  tracks: Array<{ title: string; artist: string; album: string; artwork?: string; sourceUrl: string }>;
  releases: Array<{ id: string; title: string; artist: string; year: string; type: string; artwork?: string; sourceUrl: string }>;
}
interface Result { status: string; collaboration: boolean; profiles: ArtistMetadata[] }
export function useArtistMetadata(id: string, name: string) {
  const [result, setResult] = useState<Result | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setResult(null); setLoading(true); setError("");
    const key = `slopify.artist.${name.toLowerCase()}`;
    const apply = (value: Result) => {
      setResult(value);
      const p = !value.collaboration ? value.profiles[0] : undefined;
      const artist = getState().artists[id];
      if (artist && p?.image && artist.image !== p.image) setState((s) => ({ artists: { ...s.artists, [id]: { ...s.artists[id], image: p.image } } }));
    };
    try {
      const cached = JSON.parse(localStorage.getItem(key) ?? "null");
      if (!retry && cached?.at > Date.now() - 86_400_000 && Array.isArray(cached.value?.profiles)) { apply(cached.value); setLoading(false); return () => controller.abort(); }
    } catch { /* refetch malformed cache */ }
    void fetch("/api/metadata/artist", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name }), signal: AbortSignal.any([controller.signal, AbortSignal.timeout(50_000)]) }).then(async (res) => {
      const body = await res.json();
      if (!res.ok || !body.ok || !Array.isArray(body.result?.profiles)) throw new Error("Artist metadata is unavailable.");
      if (controller.signal.aborted) return;
      apply(body.result);
      if (body.result.status === "available") try { localStorage.setItem(key, JSON.stringify({ at: Date.now(), value: body.result })); } catch { /* session cache only */ }
    }).catch(() => { if (!controller.signal.aborted) setError("Couldn't reach artist metadata services."); }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [id, name, retry]);
  return { result, loading, error, retry: () => setRetry((n) => n + 1) };
}
