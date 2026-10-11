import { useEffect, useState } from "react";
import { Art } from "../components/Artwork";
import { Hero } from "../components/Hero";
import { PlayFab } from "../components/Shelf";
import { TrackList } from "../components/TrackList";
import { paletteFromSeed } from "../data/library";
import { ensureMixes, fillMix, mixIds, mixSeed, useMixes } from "../recommend/mixes";
import { useStore, type Route } from "../state/store";
import { Missing } from "./Collection";

export function MixView({ id }: { id: string }) {
  const mixes = useMixes();
  const mix = mixes.find((m) => m.id === id);
  const tracks = useStore((s) => s.tracks);
  const taste = useStore((s) => s.taste.rev);
  const [loading, setLoading] = useState(false);
  const [ids, setIds] = useState<string[]>([]);
  useEffect(() => { const timer = window.setInterval(() => ensureMixes(), 60_000); return () => clearInterval(timer); }, []);
  useEffect(() => {
    let live = true;
    setLoading(true);
    void fillMix(id).finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
  }, [id, mix?.edition]);
  useEffect(() => { if (mix) { const next = mixIds(mix); setIds((prev) => JSON.stringify(prev) === JSON.stringify(next) ? prev : next); } }, [mix, tracks, taste]);
  if (!mix) return <Missing what="mix" />;
  const route: Route = { name: "mix", id };
  const palette = paletteFromSeed(mixSeed(mix));
  return <div className="view">
    <Hero art={<Art palette={palette} glyph={mix.kind === "weekly" ? 5 : 2} />} kind="Made for you" title={mix.name} description={mix.description} tint={palette.b} meta={<><span>{ids.length} songs</span><span>Next edition {new Date(mix.expires).toLocaleDateString()}</span></>} play={{ ids, label: mix.name, route }} />
    <div className="action-bar"><PlayFab ids={ids} label={mix.name} route={route} size="lg" /><span className="muted">{loading ? "Finding songs for this edition…" : mix.note}</span></div>
    <TrackList ids={ids} context={{ label: mix.name, route }} sortable={false} empty={<p className="mix-empty muted">{loading ? "Finding new music…" : mix.kind === "weekly" ? "No new songs found for this edition. Import or like more songs to shape next week's picks." : "No songs in this mix yet."}</p>} />
  </div>;
}
