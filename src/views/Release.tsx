import { useEffect, useMemo, useState } from "react";
import { Art } from "../components/Artwork";
import { Hero } from "../components/Hero";
import { Icon } from "../components/Icon";
import { PlayFab } from "../components/Shelf";
import { TrackList } from "../components/TrackList";
import { hashString, paletteFromSeed } from "../data/library";
import { formatLongDuration, plural } from "../lib/format";
import { fetchRelease, useReleaseTracks, type ReleaseDetail } from "../recommend/releases";
import { openArtist } from "../recommend/artist";
import { extendContext } from "../state/actions";
import type { Route } from "../state/store";
import { Empty } from "./Collection";

const TYPES: Record<string, string> = { album: "Album", single: "Single", ep: "EP", compile: "Compilation" };

/** A release from the music catalog (Release Radar, Albums for you) that you may not have: its songs stream in full. */
export function ReleaseView({ id }: { id: string }) {
  const [release, setRelease] = useState<ReleaseDetail | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    let live = true;
    setRelease(null);
    setError("");
    fetchRelease(id).then((r) => live && setRelease(r), (e: Error) => live && setError(e.message));
    return () => {
      live = false;
    };
  }, [id]);
  const status = useReleaseTracks(release);
  const ids = useMemo(() => status.flatMap((s) => (s.state === "ready" ? [s.id] : [])), [status]);
  const route: Route = { name: "release", id };
  // Songs found after playback started join the queue, in album order.
  useEffect(() => extendContext(route, ids), [ids.join()]);

  if (error) return <div className="view"><Empty icon="help" title="This release couldn't be loaded" body={error} /></div>;
  if (!release) return <div className="view"><p className="muted" role="status">Loading…</p></div>;

  const seed = hashString(release.id);
  const palette = paletteFromSeed(seed);
  const total = release.tracks.reduce((sum, t) => sum + (t.durationSeconds ?? 0), 0);
  const finding = status.filter((s) => s.state === "finding").length;
  const missing = release.tracks.filter((_, i) => status[i]?.state === "missing");
  const failed = release.tracks.filter((_, i) => status[i]?.state === "failed");
  const released = new Date(`${release.released}T12:00:00`).toLocaleDateString(undefined, { day: "numeric", month: "long", year: "numeric" });

  return (
    <div className="view">
      <Hero
        art={<Art palette={palette} glyph={seed % 6} image={release.artwork} label={`${release.title} cover`} />}
        kind={TYPES[release.type] ?? "Album"}
        title={release.title}
        tint={palette.b}
        play={{ ids, label: release.title, route }}
        meta={
          <>
            <button type="button" className="link strong" onClick={() => openArtist({ name: release.artist })}>{release.artist}</button>
            <span>{release.released.slice(0, 4)}</span>
            <span>{plural(release.tracks.length, "song")}, {formatLongDuration(total)}</span>
          </>
        }
      />
      <div className="action-bar">
        <PlayFab ids={ids} label={release.title} route={route} size="lg" />
        <a className="btn" href={release.sourceUrl} target="_blank" rel="noreferrer">
          <Icon name="external" size={18} />
          Deezer
        </a>
      </div>
      <TrackList ids={ids} context={{ label: release.title, route }} showAlbum={false} showAdded={false} sortable={false} empty={finding ? <p className="muted" role="status">Finding these songs…</p> : null} />
      <p className="muted small" role="status">
        {finding
          ? `Finding ${plural(finding, "more song")} on YouTube and SoundCloud…`
          : [
              missing.length ? `Not found to play: ${missing.map((t) => t.title).join(", ")}.` : "",
              failed.length ? `Music search isn't responding, so ${plural(failed.length, "song")} couldn't be looked up. Open this page again later to retry.` : "",
            ].filter(Boolean).join(" ")}
      </p>
      <p className="fine-print">Released {released}{release.label ? ` · ${release.label}` : ""}. Details from Deezer; songs play from YouTube or SoundCloud.</p>
    </div>
  );
}
