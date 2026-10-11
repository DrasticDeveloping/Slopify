import { useEffect, useMemo, useState, type CSSProperties } from "react";
import { Art } from "../components/Artwork";
import { DiscoveryShelf } from "../components/DiscoveryShelf";
import { Card, PlayFab, Shelf } from "../components/Shelf";
import { TrackList } from "../components/TrackList";
import { Icon } from "../components/Icon";
import { hashString, paletteFromSeed } from "../data/library";
import { useArtistMetadata } from "../recommend/artist";
import { relatedFor, seedsForIds } from "../recommend/service";
import { navigate, startCollectionRadio } from "../state/actions";
import { getState, setState, useStore, type Route } from "../state/store";
import { Missing } from "./Collection";

export function ArtistView({ id }: { id: string }) {
  const artist = useStore((s) => s.artists[id]);
  return artist ? <ArtistPage key={id} id={id} name={artist.name} /> : <Missing what="artist" />;
}
function ArtistPage({ id, name }: { id: string; name: string }) {
  const artist = useStore((s) => s.artists[id]);
  const tracks = useStore((s) => s.tracks);
  const metadata = useArtistMetadata(id, name);
  const [fans, setFans] = useState<string[]>([]);
  const popular = useMemo(() => Object.values(tracks).filter((t) => t.artistId === id && !t.stream).sort((a, b) => b.plays - a.plays).map((t) => t.id), [tracks, id]);
  const profiles = metadata.result?.profiles ?? [];
  const image = !metadata.result?.collaboration && profiles.length === 1 ? profiles[0].banner || profiles[0].image : undefined;
  const onlineTracks = profiles.flatMap((p) => p.tracks);
  const queries = onlineTracks.length ? onlineTracks.map((t) => ({ text: `${t.artist} ${t.title}`, artist: t.artist, title: t.title, because: `Popular on TheAudioDB · ${t.artist}`, affinity: 1, kind: "discover-song" as const })) : (profiles.length ? profiles.map((p) => p.name) : [name]).map((n) => ({ text: n, artist: n, because: `More from ${n}`, affinity: 0, kind: "discover-search" as const }));
  const fanKey = JSON.stringify([name, popular[0]]);
  useEffect(() => {
    const controller = new AbortController();
    const seeds = seedsForIds(popular);
    if (!seeds.artists.length) seeds.artists = [{ name, title: "", weight: 1 }];
    void relatedFor({ songs: [], artists: seeds.artists.slice(0, 1) }, controller.signal).then((r) => { if (!controller.signal.aborted) setFans(r.artists[0]?.artists.slice(0, 8).map((a) => a.name) ?? []); }).catch(() => {});
    return () => controller.abort();
  }, [fanKey]);
  const route: Route = { name: "artist", id };
  const openArtist = (artistName: string) => {
    const s = getState();
    let found = Object.values(s.artists).find((a) => a.name.toLowerCase() === artistName.toLowerCase());
    if (!found) { const seed = hashString(artistName); found = { id: `ar_${seed}`, name: artistName, genre: "indie", listeners: 0, palette: paletteFromSeed(seed) }; setState({ artists: { ...s.artists, [found.id]: found } }); }
    navigate({ name: "artist", id: found.id });
  };
  return <div className="view">
    <header className="artist-hero" style={{ "--a": artist.palette.a, "--b": artist.palette.b, "--c": artist.palette.c } as CSSProperties}>
      <div className="artist-hero-bg" aria-hidden="true"><Art palette={artist.palette} glyph={4} image={image} /></div>
      <div className="artist-hero-copy"><span className="verified">Artist</span><h1 className="hero-title lg">{name}</h1><p>{popular.length} songs in your library{profiles[0]?.country ? ` · ${profiles[0].country}` : ""}</p></div>
    </header>
    <div className="action-bar"><PlayFab ids={popular} label={name} route={route} size="lg" /><button type="button" className="btn" onClick={() => startCollectionRadio(popular, name)}><Icon name="radio" size={18} />Artist radio</button></div>
    {metadata.loading ? <p className="muted" role="status">Finding artist details online…</p> : metadata.error || !profiles.length ? <p className="muted" role="status">{metadata.error || "No verified artist profile found yet."} <button type="button" className="text-btn" onClick={metadata.retry}>Retry</button></p> : null}
    {metadata.result?.status === "partial" ? <p className="muted" role="status">Some artist details couldn't be loaded. <button type="button" className="text-btn" onClick={metadata.retry}>Retry</button></p> : null}
    {profiles.map((p) => <section className="artist-about panel" key={p.name}>
      {p.image ? <img src={p.image} alt={p.name} loading="lazy" /> : null}
      <div><h2>{metadata.result?.collaboration ? `About ${p.name}` : "About"}</h2><p className="muted">{[p.country, p.formed && p.formed !== "0" ? `${p.formedLabel ?? "Since"} ${p.formed}` : "", ...p.genres].filter(Boolean).join(" · ")}</p>{p.biography ? <p className="artist-bio">{p.biography}</p> : <p className="muted">No biography available from this source.</p>}<a className="link" href={p.sourceUrl} target="_blank" rel="noreferrer">Artist metadata source</a>{p.biographyUrl ? <p><a className="link" href={p.biographyUrl} target="_blank" rel="noreferrer">Biography · Wikipedia (CC BY-SA)</a></p> : null}</div>
    </section>)}
    {popular.length ? <><h2 className="section-title">In your library</h2><TrackList ids={popular.slice(0, 10)} context={{ label: name, route }} showAlbum={false} sortable={false} /></> : null}
    <DiscoveryShelf title="Popular" subtitle="Online tracks you can play in full or save" queries={queries} limit={10} />
    <Shelf title="Discography" subtitle="Verified releases from online metadata">
      {profiles.flatMap((p) => p.releases).map((a) => <div className="card" key={a.id}><div className="card-art"><Art palette={paletteFromSeed(hashString(a.id))} glyph={3} image={a.artwork} /></div><a className="card-link" href={a.sourceUrl} target="_blank" rel="noreferrer"><strong>{a.title}</strong><span>{[a.year, a.type, a.artist].filter(Boolean).join(" · ")}</span></a><span className="small muted">{Object.values(tracks).filter((t) => !t.stream && getState().albums[t.albumId]?.title.toLowerCase() === a.title.toLowerCase() && getState().artists[t.artistId]?.name.toLowerCase() === a.artist.toLowerCase()).length} tracks in your library</span></div>)}
      {!profiles.some((p) => p.releases.length) ? <p className="muted shelf-empty">{metadata.loading ? "Finding releases…" : "No verified releases available."}</p> : null}
    </Shelf>
    {fans.length ? <Shelf title="Fans also like" subtitle={`Related to ${name} · ListenBrainz`}>{fans.map((n) => <Card key={n} round art={<Art palette={paletteFromSeed(hashString(n))} glyph={4} round />} title={n} subtitle="Artist" onOpen={() => openArtist(n)} />)}</Shelf> : null}
  </div>;
}
