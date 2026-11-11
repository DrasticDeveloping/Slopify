import { useMemo, useState } from "react";
import { ArtistArt } from "../components/Artwork";
import { discographyOf, releaseKind, ReleaseCards, useOwnedReleases } from "../components/Discography";
import { Hero } from "../components/Hero";
import { Icon } from "../components/Icon";
import { SkeletonCards } from "../components/Shelf";
import type { Artist } from "../data/types";
import { plural } from "../lib/format";
import { useArtistMetadata } from "../recommend/artist";
import { artistName } from "../recommend/discover";
import { navigate } from "../state/actions";
import { useStore } from "../state/store";
import { Missing } from "./Collection";

type Filter = "all" | "album" | "single" | "other";
const FILTERS: Array<[Filter, string]> = [["all", "All"], ["album", "Albums"], ["single", "Singles and EPs"], ["other", "Other"]];

/** An artist's whole discography on one page: every release, newest first, filtered by kind. */
export function DiscographyView({ id }: { id: string }) {
  const artist = useStore((s) => s.artists[id]);
  return artist ? <DiscographyPage key={id} artist={artist} /> : <Missing what="artist" />;
}

function DiscographyPage({ artist }: { artist: Artist }) {
  const name = artistName(artist.name);
  const metadata = useArtistMetadata(artist.id, name, artist.musicBrainzId);
  const releases = useMemo(() => discographyOf(metadata.result?.profiles ?? []), [metadata.result]);
  const owned = useOwnedReleases();
  const [filter, setFilter] = useState<Filter>("all");
  const [oldestFirst, setOldestFirst] = useState(false);

  const counts = useMemo(() => {
    const c: Record<Filter, number> = { all: releases.length, album: 0, single: 0, other: 0 };
    for (const r of releases) c[releaseKind(r)]++;
    return c;
  }, [releases]);
  const shown = useMemo(() => {
    const list = filter === "all" ? releases : releases.filter((r) => releaseKind(r) === filter);
    if (!oldestFirst) return list;
    // Releases without a date stay at the end either way.
    const dated = (r: (typeof list)[number]) => !!(r.released || r.year);
    return [...list.filter(dated).reverse(), ...list.filter((r) => !dated(r))];
  }, [releases, filter, oldestFirst]);
  const years = releases.map((r) => Number(r.year)).filter((y) => y > 0);
  const span = years.length ? `${Math.min(...years)}–${Math.max(...years)}` : "";

  return (
    <div className="view">
      <Hero
        art={<ArtistArt artist={artist} />}
        round
        kind="Discography"
        title={name}
        tint={artist.palette.b}
        meta={
          <>
            <button type="button" className="link strong" onClick={() => navigate({ name: "artist", id: artist.id })}>Artist page</button>
            {releases.length ? <span>{plural(releases.length, "release")}</span> : null}
            {span ? <span>{span}</span> : null}
          </>
        }
      />
      <div className="action-bar page-filters">
        <div className="chips" role="group" aria-label="Show">
          {FILTERS.filter(([key]) => key === "all" || counts[key]).map(([key, label]) => (
            <button key={key} type="button" className={`chip${filter === key ? " on" : ""}`} aria-pressed={filter === key} onClick={() => setFilter(key)}>
              {label} <span className="chip-count">{counts[key]}</span>
            </button>
          ))}
        </div>
        <button type="button" className="btn ghost sm sort-toggle" onClick={() => setOldestFirst(!oldestFirst)} aria-label={`Sorted ${oldestFirst ? "oldest" : "newest"} first. Change order`}>
          <Icon name="sort" size={16} />
          {oldestFirst ? "Oldest first" : "Newest first"}
        </button>
      </div>
      {metadata.loading && !releases.length ? (
        <div className="card-grid"><SkeletonCards count={12} label="Finding releases…" /></div>
      ) : metadata.error && !releases.length ? (
        <div className="inline-error" role="status">
          <Icon name="globe" size={18} />
          <span><strong>The discography isn't available right now</strong><small>Releases load from online services, which didn't answer.</small></span>
          <button type="button" className="btn sm" onClick={metadata.retry}><Icon name="sync" size={15} />Try again</button>
        </div>
      ) : !releases.length ? (
        <p className="muted" role="status">No releases found for {name}.</p>
      ) : (
        <div className="card-grid">
          <ReleaseCards releases={shown} owned={owned} />
        </div>
      )}
      {releases.length ? <p className="fine-print">Releases from MusicBrainz and TheAudioDB. Opening one finds it in the music catalog.</p> : null}
    </div>
  );
}
