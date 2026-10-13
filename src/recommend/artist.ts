import { useEffect, useState } from "react";
import { hashString, paletteFromSeed } from "../data/library";
import type { Artist } from "../data/types";
import { navigate } from "../state/actions";
import { getState, setState } from "../state/store";

export interface ArtistTrack { title: string; artist: string; album: string; artwork?: string; sourceUrl: string }
export interface ArtistRelease { id: string; title: string; artist: string; year: string; type: string; artwork?: string; sourceUrl: string }

export interface ArtistMetadata {
  name: string;
  biography: string;
  genres: string[];
  country: string;
  formed: string;
  /** "Born", "Formed" or "Active since". */
  formedLabel?: string;
  image?: string;
  banner?: string;
  sourceUrl: string;
  biographyUrl?: string;
  tracks: ArtistTrack[];
  releases: ArtistRelease[];
}

export interface ArtistProfiles {
  status: "available" | "partial" | "unavailable";
  /** The name is a collaboration credit, profiled one artist at a time. */
  collaboration: boolean;
  profiles: ArtistMetadata[];
}

const DAY = 86_400_000;
const cacheKey = (name: string, musicBrainzId?: string) => `slopify.artist.v3.${name.toLowerCase()}${musicBrainzId ? `.${musicBrainzId}` : ""}`;

/** A complete profile from the last day, if this browser has one. */
function cached(key: string): ArtistProfiles | null {
  try {
    const entry = JSON.parse(localStorage.getItem(key) ?? "null");
    return entry?.at > Date.now() - DAY && Array.isArray(entry.value?.profiles) ? entry.value : null;
  } catch {
    return null;
  }
}

async function fetchProfiles(name: string, musicBrainzId: string | undefined, signal: AbortSignal): Promise<ArtistProfiles> {
  const res = await fetch("/api/metadata/artist", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, musicBrainzId }),
    signal: AbortSignal.any([signal, AbortSignal.timeout(50_000)]),
  });
  const body = await res.json();
  if (!res.ok || !body.ok || !Array.isArray(body.result?.profiles)) throw new Error("Artist metadata is unavailable.");
  return body.result;
}

/** The library artist's picture follows their verified profile, so it shows on cards and search results too. */
function adoptImage(artistId: string, result: ArtistProfiles) {
  const image = !result.collaboration ? result.profiles[0]?.image : undefined;
  const artist = getState().artists[artistId];
  if (artist && image && artist.image !== image) setState((s) => ({ artists: { ...s.artists, [artistId]: { ...s.artists[artistId], image } } }));
}

/**
 * Opens the artist page for an artist found online (search, "Fans also like"),
 * reusing the library artist of that name unless their MusicBrainz ids differ.
 */
export function openArtist(found: { name: string; musicBrainzId?: string; image?: string }) {
  const s = getState();
  const same = (a: Artist) => a.name.toLowerCase() === found.name.toLowerCase() && (!a.musicBrainzId || !found.musicBrainzId || a.musicBrainzId === found.musicBrainzId);
  const seed = hashString(`${found.name}|${found.musicBrainzId ?? ""}`);
  const base: Artist = Object.values(s.artists).find(same) ?? { id: `ar_online_${seed.toString(36)}`, name: found.name, genre: "indie", listeners: 0, palette: paletteFromSeed(seed) };
  const artist: Artist = { ...base, ...(found.image ? { image: found.image } : {}), ...(found.musicBrainzId ? { musicBrainzId: found.musicBrainzId } : {}) };
  if (JSON.stringify(artist) !== JSON.stringify(s.artists[artist.id])) setState({ artists: { ...s.artists, [artist.id]: artist } });
  navigate({ name: "artist", id: artist.id });
}

/** Online profiles for an artist, kept in this browser for a day once complete. */
export function useArtistMetadata(id: string, name: string, musicBrainzId?: string) {
  const [result, setResult] = useState<ArtistProfiles | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    const key = cacheKey(name, musicBrainzId);
    const show = (value: ArtistProfiles) => {
      setResult(value);
      adoptImage(id, value);
    };
    setError("");
    // Retry always asks the services again.
    const hit = attempt ? null : cached(key);
    if (hit) {
      show(hit);
      setLoading(false);
      return;
    }
    const controller = new AbortController();
    setResult(null);
    setLoading(true);
    fetchProfiles(name, musicBrainzId, controller.signal)
      .then((value) => {
        if (controller.signal.aborted) return;
        show(value);
        if (value.status !== "available") return;
        try {
          localStorage.setItem(key, JSON.stringify({ at: Date.now(), value }));
        } catch {
          // Shown for this visit only.
        }
      })
      .catch(() => {
        if (!controller.signal.aborted) setError("Couldn't reach artist metadata services.");
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [id, name, musicBrainzId, attempt]);

  return { result, loading, error, retry: () => setAttempt((n) => n + 1) };
}
