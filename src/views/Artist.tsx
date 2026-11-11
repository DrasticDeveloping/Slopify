import { creditsArtist } from "../lib/credits";
import { useEffect, useMemo, useState, type CSSProperties } from "react";
import { Art } from "../components/Artwork";
import { discographyOf, ReleaseCards, useOwnedReleases } from "../components/Discography";
import { DiscoveryShelf } from "../components/DiscoveryShelf";
import { Icon } from "../components/Icon";
import { Card, PlayFab, Shelf, SkeletonCards } from "../components/Shelf";
import { TrackList } from "../components/TrackList";
import { hashString, paletteFromSeed } from "../data/library";
import type { Artist } from "../data/types";
import { plural } from "../lib/format";
import { openArtist, useArtistMetadata, type ArtistMetadata, type ArtistProfiles } from "../recommend/artist";
import { artistName, cleanArtist, type DiscoveryQuery } from "../recommend/discover";
import { relatedFor } from "../recommend/service";
import { navigate, startCollectionRadio } from "../state/actions";
import { useStore, type Route } from "../state/store";
import { Missing } from "./Collection";

export function ArtistView({ id }: { id: string }) {
  const artist = useStore((s) => s.artists[id]);
  // Keyed, so another artist's page starts with fresh metadata state.
  return artist ? <ArtistPage key={id} artist={artist} /> : <Missing what="artist" />;
}

function ArtistPage({ artist }: { artist: Artist }) {
  const { id } = artist;
  // "Eggtan - Topic" (a YouTube channel name) is shown, looked up and counted as "Eggtan".
  const name = artistName(artist.name);
  const tracks = useStore((s) => s.tracks);
  const artists = useStore((s) => s.artists);
  const metadata = useArtistMetadata(id, name, artist.musicBrainzId);
  const profiles = useMemo(() => metadata.result?.profiles ?? [], [metadata.result]);
  const route: Route = { name: "artist", id };
  // Library songs only; streamed suggestions are not in the library.
  const popular = useMemo(
    () => Object.values(tracks)
      .filter((t) => !t.stream && (creditsArtist(t, id) || cleanArtist(artists[t.artistId]?.name) === cleanArtist(name)))
      .sort((a, b) => b.plays - a.plays)
      .map((t) => t.id),
    [tracks, artists, id, name],
  );
  // A single verified profile's picture; a collaboration has no one picture.
  // Without one (the profile couldn't be loaded, say), the artist's saved picture.
  const image = (!metadata.result?.collaboration && profiles.length === 1 ? profiles[0].banner || profiles[0].image : undefined) ?? artist.image;

  return (
    <div className="view">
      <header className="artist-hero" style={{ "--a": artist.palette.a, "--b": artist.palette.b, "--c": artist.palette.c } as CSSProperties}>
        <div className="artist-hero-bg" aria-hidden="true">
          <Art palette={artist.palette} glyph={4} image={image} />
        </div>
        <div className="artist-hero-copy">
          <span className="verified">Artist</span>
          <h1 className="hero-title lg">{name}</h1>
          <p>{[`${plural(popular.length, "song")} in your library`, profiles[0]?.country].filter(Boolean).join(" · ")}</p>
        </div>
      </header>
      <div className="action-bar">
        <PlayFab ids={popular} label={name} route={route} size="lg" />
        <button type="button" className="btn" onClick={() => startCollectionRadio(popular, name)}>
          <Icon name="radio" size={18} />
          Artist radio
        </button>
      </div>
      <MetadataStatus metadata={metadata} />
      {popular.length ? (
        <>
          <h2 className="section-title">In your library</h2>
          <TrackList ids={popular.slice(0, 10)} context={{ label: name, route }} showAlbum={false} sortable={false} />
        </>
      ) : null}
      <DiscoveryShelf title="Popular" subtitle="Their best-known songs, from your library and online" queries={popularQueries(name, profiles)} limit={12} route={route} withOwned hideWhenEmpty fixedSubtitle openSong />
      <Discography artistId={id} profiles={profiles} loading={metadata.loading} />
      {profiles.filter((p) => p.biography.trim()).map((p) => (
        <About key={p.name} profile={p} heading={metadata.result?.collaboration ? `About ${p.name}` : "About"} />
      ))}
      <FansAlsoLike name={name} />
    </div>
  );
}

function MetadataStatus({ metadata }: { metadata: { result: ArtistProfiles | null; loading: boolean; error: string; retry: () => void } }) {
  const retry = <button type="button" className="btn sm" onClick={metadata.retry}><Icon name="sync" size={15} />Try again</button>;
  if (metadata.loading) return <p className="muted metadata-loading" role="status"><span className="spinner" />Finding artist details…</p>;
  // No profile at all is ordinary for smaller artists: the page simply goes without one.
  if (!metadata.error && !metadata.result?.profiles.length) return null;
  if (metadata.error) return <div className="inline-error" role="status"><Icon name="globe" size={18} /><span><strong>Artist details aren't available right now</strong><small>Their bio and releases load from online services, which didn't answer.</small></span>{retry}</div>;
  if (metadata.result?.status === "partial") return <p className="muted small" role="status">Some artist details couldn't be loaded. <button type="button" className="text-btn" onClick={metadata.retry}>Try again</button></p>;
  return null;
}

function About({ profile: p, heading }: { profile: ArtistMetadata; heading: string }) {
  const [more, setMore] = useState(false);
  const formed = p.formed && p.formed !== "0" ? `${p.formedLabel ?? "Active since"} ${p.formed}` : "";
  return (
    <section className="artist-about panel">
      {p.image ? <img src={p.image} alt={p.name} loading="lazy" /> : null}
      <div>
        <h2>{heading}</h2>
        <p className="muted">{[p.country, formed, ...p.genres].filter(Boolean).join(" · ")}</p>
        <p className={`artist-bio${more ? "" : " excerpt"}`}>{p.biography}</p>
        <button type="button" className="text-btn bio-more" onClick={() => setMore(!more)} aria-expanded={more}>{more ? "Show less" : "Read more"}</button>
        <a className="link" href={p.sourceUrl} target="_blank" rel="noreferrer">Artist metadata source</a>
        {p.biographyUrl ? (
          <p>
            <a className="link" href={p.biographyUrl} target="_blank" rel="noreferrer">Biography · Wikipedia (CC BY-SA)</a>
          </p>
        ) : null}
      </div>
    </section>
  );
}

/**
 * The artist's popular songs: the ones TheAudioDB lists first, then whatever the
 * platforms rank highest for the artist's name (TheAudioDB often knows only one
 * or two songs, which may all be in your library already).
 */
function popularQueries(name: string, profiles: ArtistMetadata[]): DiscoveryQuery[] {
  const top: DiscoveryQuery[] = profiles.flatMap((p) => p.tracks).map((t) => ({
    text: `${t.artist} ${t.title}`, artist: t.artist, title: t.title, because: t.artist, reason: `Popular on TheAudioDB · ${t.artist}`, affinity: 1, kind: "discover-song",
  }));
  const names = profiles.length ? profiles.map((p) => p.name) : [name];
  return [...top, ...names.map((n): DiscoveryQuery => ({ text: n, artist: n, because: `Popular · ${n}`, affinity: 0, kind: "discover-search" }))];
}

function Discography({ artistId, profiles, loading }: { artistId: string; profiles: ArtistMetadata[]; loading: boolean }) {
  const owned = useOwnedReleases();
  const releases = useMemo(() => discographyOf(profiles), [profiles]);
  if (!releases.length && !loading) return null;
  return (
    <Shelf title="Discography" subtitle="Albums, EPs and singles, newest first" onShowAll={releases.length ? () => navigate({ name: "discography", id: artistId }) : undefined}>
      <ReleaseCards releases={releases.slice(0, 20)} owned={owned} />
      {!releases.length ? <SkeletonCards label="Finding releases…" /> : null}
    </Shelf>
  );
}

/** Artists whose listeners also play this one, from ListenBrainz. */
function FansAlsoLike({ name }: { name: string }) {
  const [fans, setFans] = useState<string[]>([]);
  const [pictures, setPictures] = useState<Record<string, string | null>>({});
  useEffect(() => {
    const controller = new AbortController();
    relatedFor({ songs: [], artists: [{ name, title: "", weight: 1 }] }, controller.signal)
      .then((related) => {
        const names = related.artists[0]?.artists.slice(0, 8).map((a) => a.name) ?? [];
        setFans(names);
        // Their pictures come from the music catalog; a card keeps its generated art until one arrives.
        if (!names.length) return;
        return fetch("/api/catalog/pictures", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ artists: names }), signal: controller.signal })
          .then((res) => res.json())
          .then((body: { ok?: boolean; result?: { pictures?: Record<string, string | null> } }) => {
            if (body?.ok && body.result?.pictures) setPictures(body.result.pictures);
          });
      })
      .catch(() => {});
    return () => controller.abort();
  }, [name]);
  if (!fans.length) return null;
  return (
    <Shelf title="Fans also like" subtitle={`Related to ${name} · ListenBrainz`}>
      {fans.map((n) => (
        <Card key={n} round art={<Art palette={paletteFromSeed(hashString(n))} glyph={4} round image={pictures[n] ?? undefined} label={n} />} title={n} subtitle="Artist" onOpen={() => openArtist({ name: n, image: pictures[n] ?? undefined })} />
      ))}
    </Shelf>
  );
}
