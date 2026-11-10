import { useEffect, useMemo, useState } from "react";
import { BlurredTrackArt } from "../components/Artwork";
import { MixArt } from "../components/MixArt";
import { Hero } from "../components/Hero";
import { PlayFab } from "../components/Shelf";
import { TrackList } from "../components/TrackList";
import { paletteFromSeed } from "../data/library";
import { fillMix, mixIds, mixSeed, mixSongs, useMixes, type Mix } from "../recommend/mixes";
import { registerStreams } from "../state/importer";
import { shufflePlay } from "../state/actions";
import { Icon } from "../components/Icon";
import { useStore, type Route } from "../state/store";
import { Missing } from "./Collection";

function emptyText(mix: Mix, loading: boolean) {
  if (loading) return "Finding new music…";
  if (mix.kind === "weekly") return "No new songs found for this edition. Import or like more songs to shape next week's picks.";
  return "No songs in this mix yet.";
}

export function MixView({ id }: { id: string }) {
  const mix = useMixes().find((m) => m.id === id);
  const tracks = useStore((s) => s.tracks);
  const albums = useStore((s) => s.albums);
  const tasteRev = useStore((s) => s.taste.rev);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    let live = true;
    setLoading(true);
    void fillMix(id).finally(() => live && setLoading(false));
    return () => {
      live = false;
    };
  }, [id, mix?.edition]);

  // New songs become tracks the player knows, so they list and play like library songs.
  useEffect(() => {
    if (mix) registerStreams(mixSongs(mix));
  }, [mix, tasteRev]);
  // Follows saves, hides and dismissals without changing the edition.
  const ids = useMemo(() => (mix ? mixIds(mix) : []), [mix, tracks, tasteRev]);

  if (!mix) return <Missing what="mix" />;
  const route: Route = { name: "mix", id };
  const palette = paletteFromSeed(mixSeed(mix));
  const washId = mix.libraryIds.find((t) => tracks[t] && albums[tracks[t].albumId]?.artworkUrl);
  return (
    <div className="view">
      <Hero
        art={<MixArt mix={mix} bare />}
        kind="Made for you"
        title={mix.name}
        description={mix.description}
        tint={palette.b}
        wash={washId ? <BlurredTrackArt trackId={washId} /> : undefined}
        meta={
          <>
            <span>{ids.length} songs</span>
            <span>New edition {new Date(mix.expires).toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" })}</span>
          </>
        }
        play={{ ids, label: mix.name, route }}
      />
      <div className="action-bar">
        <PlayFab ids={ids} label={mix.name} route={route} size="lg" />
        <button type="button" className="icon-btn lg" disabled={!ids.length} onClick={() => shufflePlay(ids, { label: mix.name, route })} aria-label={`Shuffle ${mix.name}`} title="Shuffle play">
          <Icon name="shuffle" size={24} />
        </button>
        <span className="muted">{loading ? "Finding songs for this edition…" : mix.note}</span>
      </div>
      <TrackList ids={ids} context={{ label: mix.name, route }} sortable={false} empty={<p className="mix-empty muted">{emptyText(mix, loading)}</p>} />
    </div>
  );
}
