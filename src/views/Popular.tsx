import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type MouseEvent } from "react";
import { Art, ArtistArt } from "../components/Artwork";
import { Hero } from "../components/Hero";
import { Icon } from "../components/Icon";
import { PlayFab } from "../components/Shelf";
import { hashString, paletteFromSeed } from "../data/library";
import type { Artist } from "../data/types";
import { formatCount, formatTime, plural } from "../lib/format";
import { openTrackMenu } from "../lib/menus";
import { allTimePlays } from "../lib/plays";
import { ownedIndex } from "../recommend/owned";
import { artistName } from "../recommend/discover";
import { formatPopularity, notableVersion, POPULARITY_MAX, useTopSongs, type TopSong } from "../recommend/popular";
import { popularFinder, type Finder } from "../recommend/finder";
import type { TrackStatus } from "../recommend/releases";
import { navigate, playList, shufflePlay, songRoute, toast, togglePlay } from "../state/actions";
import { getState, useStore, type Route } from "../state/store";
import { Missing } from "./Collection";

/** Rows past the last one in view that are looked for too. */
const AHEAD = 8;

/** An artist's songs ranked by popularity, each with its statistics. */
export function PopularView({ id }: { id: string }) {
  const artist = useStore((s) => s.artists[id]);
  return artist ? <PopularPage key={id} artist={artist} /> : <Missing what="artist" />;
}

/** The page's view of its artist's finder (recommend/finder), which outlives the page while its list plays. */
function useFinder(songs: TopSong[], route: Route, artist: string) {
  const [finder, setFinder] = useState<Finder | null>(null);
  const [status, setStatus] = useState<Array<TrackStatus | undefined>>([]);
  // Before the first paint, so the page never shows (or drops a click in) a frame without its finder.
  useLayoutEffect(() => {
    if (!songs.length) {
      setFinder(null);
      setStatus([]);
      return;
    }
    // Made and held together, so nothing can find it unheld and stop it before the page takes hold.
    const found = popularFinder(route, artist, songs);
    const release = found.hold();
    const show = () => setStatus([...found.status()]);
    const unwatch = found.watch(show);
    setFinder(found);
    show();
    return () => {
      unwatch();
      release();
    };
  }, [songs]);
  return { status, finder };
}

function PopularPage({ artist }: { artist: Artist }) {
  const name = artistName(artist.name);
  const top = useTopSongs(name);
  const songs = useMemo(() => top.value?.songs ?? [], [top.value]);
  const tracks = useStore((s) => s.tracks);
  const owned = useMemo(() => ownedIndex(getState()), [tracks]);
  const listens = useStore((s) => s.taste.listens);
  // The same count as Your stats: the play counter, or the listening history if that has more.
  const allPlays = useMemo(() => allTimePlays(tracks, listens), [tracks, listens]);
  const [pending, setPending] = useState<number | null>(null);
  /** The latest click to play a song: only it plays, and a newer one calls off its search if that hasn't gone out yet. */
  const click = useRef<AbortController | null>(null);
  const route: Route = useMemo(() => ({ name: "popular", id: artist.id }), [artist.id]);
  const { status, finder } = useFinder(songs, route, name);
  const label = `${name}: Popular`;
  const ids = useMemo(() => status.flatMap((s) => (s?.state === "ready" ? [s.id] : [])), [status]);
  const list = useRef<HTMLDivElement>(null);

  // Rows coming into view (and a few past them) are looked for.
  useEffect(() => {
    const el = list.current;
    if (!el || !songs.length) return;
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) if (e.isIntersecting) finder?.want(Number((e.target as HTMLElement).dataset.index) + 1 + AHEAD);
      },
      { root: el.closest(".main-scroll"), rootMargin: "200px 0px" },
    );
    el.querySelectorAll(".pop-row").forEach((row) => io.observe(row));
    return () => io.disconnect();
  }, [songs, finder]);

  const play = async (i: number) => {
    if (!finder) return;
    const song = songs[i];
    const known = status[i];
    if (known?.state === "ready" && getState().currentId === known.id) {
      // Pausing (or resuming) the playing song is the latest click: one still waiting doesn't start afterwards.
      click.current?.abort();
      click.current = null;
      setPending(null);
      return togglePlay();
    }
    if (pending === i) return;
    click.current?.abort();
    const mine = new AbortController();
    click.current = mine;
    setPending(i);
    // Something else started playing meanwhile (from another page, say): that stands.
    const playingFrom = JSON.stringify(getState().context?.route ?? null);
    const found = await finder.request(i, mine.signal);
    if (mine.signal.aborted) return;
    if (JSON.stringify(getState().context?.route ?? null) !== playingFrom) {
      click.current = null;
      setPending(null);
      return;
    }
    click.current = null;
    setPending(null);
    if (found.state !== "ready") {
      toast(`Couldn't find “${song.title}” to play`, { detail: found.state === "failed" ? "Music search isn't responding. Try again later." : "It isn't on YouTube or SoundCloud under that name.", tone: "error" });
      return;
    }
    const ready = finder.ready();
    playList(ready.includes(found.id) ? ready : [found.id, ...ready], found.id, { label, route });
  };

  const fans = top.value?.artist?.fans ?? 0;
  const max = songs[0]?.rank ?? 0;
  const finding = status.filter((s) => s?.state === "finding").length;

  return (
    <div className="view">
      <Hero
        art={<ArtistArt artist={artist} />}
        round
        kind="Popular songs"
        title={name}
        tint={artist.palette.b}
        play={{ ids, label, route }}
        meta={
          <>
            <button type="button" className="link strong" onClick={() => navigate({ name: "artist", id: artist.id })}>Artist page</button>
            {songs.length ? <span>{plural(songs.length, "song")}, most popular first</span> : null}
            {fans ? <span>{formatCount(fans)} fans on Deezer</span> : null}
          </>
        }
      />
      <div className="action-bar">
        <PlayFab ids={ids} label={label} route={route} size="lg" onEmpty={songs.length ? () => void play(Math.max(0, status.findIndex((s) => s?.state !== "missing"))) : undefined} />
        <button type="button" className="icon-btn lg" disabled={!ids.length} onClick={() => shufflePlay(ids, { label, route })} aria-label={`Shuffle ${label}`} title="Shuffle play">
          <Icon name="shuffle" size={24} />
        </button>
        {top.value?.artist ? (
          <a className="icon-btn lg" href={top.value.artist.sourceUrl} target="_blank" rel="noreferrer" aria-label="Open in Deezer" title="Open in Deezer">
            <Icon name="external" size={22} />
          </a>
        ) : null}
        <span className="muted small" role="status">{finding ? `Finding ${plural(finding, "song")} to play…` : ""}</span>
      </div>

      {top.loading ? (
        <div className="skeleton-list" role="status" aria-label="Loading popular songs">
          {Array.from({ length: 8 }, (_, i) => <span key={i} className="sk sk-row" />)}
        </div>
      ) : top.error ? (
        <div className="inline-error" role="status">
          <Icon name="globe" size={18} />
          <span><strong>Popular songs aren't available right now</strong><small>{top.error} Your connection may have dropped, or the catalog is busy.</small></span>
          <button type="button" className="btn sm" onClick={top.retry}><Icon name="sync" size={15} />Try again</button>
        </div>
      ) : !songs.length ? (
        <p className="muted" role="status">The music catalog doesn't know {name}'s songs, so they can't be ranked.</p>
      ) : (
        <div className="pop-list" role="table" aria-label={`${name}'s songs by popularity`} ref={list}>
          <div className="pop-head" role="row">
            <span role="columnheader" className="num">#</span>
            <span role="columnheader">Title</span>
            <span role="columnheader" className="pop-col" title="Deezer's popularity score for the song, out of 1,000,000">Popularity</span>
            <span role="columnheader" className="plays-col" title="How often you've played it">Your plays</span>
            <span role="columnheader" className="dur-col">Length</span>
          </div>
          {songs.map((song, i) => {
            const s = status[i];
            const id = s?.state === "ready" ? s.id : undefined;
            const mine = owned.find({ artist: song.artist, title: song.title })[0];
            const plays = mine ? allPlays.get(mine) ?? 0 : null;
            return (
              <PopRow
                key={song.id}
                index={i}
                song={song}
                id={id}
                missing={s?.state === "missing"}
                finding={pending === i}
                plays={plays}
                relative={max ? song.rank / max : 0}
                onPlay={() => void play(i)}
                onMenu={id ? (e) => openTrackMenu(e, [id], { context: { label, route, ids } }) : undefined}
              />
            );
          })}
        </div>
      )}
      {songs.length ? <p className="fine-print">Popularity is Deezer's score for each song, out of 1,000,000. Songs play from your library, YouTube or SoundCloud.</p> : null}
    </div>
  );
}

interface RowProps {
  index: number;
  song: TopSong;
  id?: string;
  missing: boolean;
  /** Being looked for, to play. */
  finding: boolean;
  plays: number | null;
  /** Popularity relative to the artist's top song, 0–1. */
  relative: number;
  onPlay: () => void;
  onMenu?: (e: MouseEvent) => void;
}

function PopRow({ index, song, id, missing, finding, plays, relative, onPlay, onMenu }: RowProps) {
  const current = useStore((s) => !!id && s.currentId === id);
  const playing = useStore((s) => s.isPlaying) && current;
  const version = notableVersion(song.version);
  const score = song.rank / POPULARITY_MAX;
  return (
    <div
      className={`pop-row${current ? " current" : ""}${missing ? " unavailable" : ""}`}
      role="row"
      data-index={index}
      onDoubleClick={onPlay}
      onContextMenu={onMenu}
      style={{ "--i": Math.min(index, 20) } as CSSProperties}
    >
      <span className="td num" role="cell">
        <span className="num-label">{index + 1}</span>
        <button type="button" className={`row-play${finding ? " busy" : ""}`} onClick={onPlay} aria-label={`${playing ? "Pause" : "Play"} ${song.title}`} title={missing ? "Not found on YouTube or SoundCloud" : undefined}>
          {finding ? <span className="spinner" /> : <Icon name={playing ? "pause" : "play"} size={16} />}
        </button>
      </span>
      <span className="td title" role="cell">
        <Art palette={paletteFromSeed(hashString(song.id))} glyph={hashString(song.id) % 6} image={song.artwork} className="row-art" />
        <span className="title-text">
          <button type="button" className="t-name link" onClick={() => navigate(songRoute(song.artist, song.title, id))} title={`${song.title}: statistics and similar songs`}>
            {song.title}
            {version ? <span className="t-version"> {version}</span> : null}
          </button>
          <span className="t-sub">
            {song.explicit ? <span className="badge" title="Explicit" aria-label="Explicit">E</span> : null}
            <span className="t-artists">{song.album}</span>
          </span>
        </span>
      </span>
      <span className="td pop-col" role="cell" title={`${song.rank.toLocaleString()} out of 1,000,000 · ${Math.round(relative * 100)}% of their top song`}>
        <span className="pop-meter" aria-hidden="true"><span style={{ width: `${Math.max(2, score * 100)}%` }} /></span>
        <span className="pop-score">{formatPopularity(song.rank)}</span>
      </span>
      <span className="td plays-col" role="cell">{plays === null ? <span className="muted" title="Not in your library">—</span> : plays.toLocaleString()}</span>
      <span className="td dur-col" role="cell">{song.durationSeconds ? formatTime(song.durationSeconds) : "–:––"}</span>
    </div>
  );
}
