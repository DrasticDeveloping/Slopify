import { useEffect, useMemo, useRef, useState, type CSSProperties, type MouseEvent } from "react";
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
import { resolveSong, type TrackStatus } from "../recommend/releases";
import { extendContext, navigate, playList, shufflePlay, songRoute, toast, togglePlay } from "../state/actions";
import { getState, useStore, type Route } from "../state/store";
import { Missing } from "./Collection";

/** Songs looked for straight away; the rest as they scroll into view (or are played). */
const FIRST = 12;
const AHEAD = 8;

/** An artist's songs ranked by popularity, each with its statistics. */
export function PopularView({ id }: { id: string }) {
  const artist = useStore((s) => s.artists[id]);
  return artist ? <PopularPage key={id} artist={artist} /> : <Missing what="artist" />;
}

interface Finder {
  /** Look for songs up to this rank. */
  want: (upTo: number) => void;
  /** This song's playable copy, looked for first if it hasn't been yet. */
  request: (i: number) => Promise<TrackStatus>;
  /** Songs found so far, in rank order. */
  ready: () => string[];
}

/**
 * Finds playable copies of ranked songs, three at a time and most popular
 * first, only as far down the list as someone has looked: each one is a search
 * on YouTube or SoundCloud, and most people never scroll to song 80.
 */
function useFinder(songs: TopSong[]) {
  const [status, setStatus] = useState<Array<TrackStatus | undefined>>([]);
  const finder = useRef<Finder | null>(null);
  useEffect(() => {
    let live = true;
    const results: Array<TrackStatus | undefined> = songs.map(() => undefined);
    const waiting = new Map<number, Array<(s: TrackStatus) => void>>();
    const priority: number[] = [];
    const owned = ownedIndex(getState());
    let wanted = FIRST;
    let running = 0;
    setStatus([]);
    const pump = () => {
      while (live && running < 3) {
        const i = priority.find((p) => !results[p]) ?? results.findIndex((r, n) => !r && n < wanted);
        if (i === undefined || i < 0) break;
        const song = songs[i];
        results[i] = { state: "finding" };
        running++;
        void resolveSong({ title: song.title, artist: song.artist, durationSeconds: song.durationSeconds, artwork: song.artwork, album: song.album }, owned).then((found) => {
          if (!live) return;
          running--;
          results[i] = found;
          setStatus([...results]);
          waiting.get(i)?.forEach((done) => done(found));
          waiting.delete(i);
          pump();
        });
      }
      if (live) setStatus([...results]);
    };
    finder.current = {
      want: (upTo) => {
        if (upTo <= wanted) return;
        wanted = upTo;
        pump();
      },
      request: (i) => {
        // A search that failed (music search was down) is tried again when someone asks for the song.
        if (results[i]?.state === "failed") results[i] = undefined;
        const now = results[i];
        if (now && now.state !== "finding") return Promise.resolve(now);
        return new Promise((resolve) => {
          waiting.set(i, [...(waiting.get(i) ?? []), resolve]);
          if (!now) priority.unshift(i);
          pump();
        });
      },
      ready: () => results.flatMap((r) => (r?.state === "ready" ? [r.id] : [])),
    };
    pump();
    return () => {
      live = false;
    };
  }, [songs]);
  return { status, finder };
}

function PopularPage({ artist }: { artist: Artist }) {
  const name = artistName(artist.name);
  const top = useTopSongs(name);
  const songs = useMemo(() => top.value?.songs ?? [], [top.value]);
  const { status, finder } = useFinder(songs);
  const tracks = useStore((s) => s.tracks);
  const owned = useMemo(() => ownedIndex(getState()), [tracks]);
  const listens = useStore((s) => s.taste.listens);
  // The same count as Your stats: the play counter, or the listening history if that has more.
  const allPlays = useMemo(() => allTimePlays(tracks, listens), [tracks, listens]);
  const [pending, setPending] = useState<number | null>(null);
  const route: Route = { name: "popular", id: artist.id };
  const label = `${name}: Popular`;
  const ids = useMemo(() => status.flatMap((s) => (s?.state === "ready" ? [s.id] : [])), [status]);
  const list = useRef<HTMLDivElement>(null);
  // Songs found after playback started join the queue, in rank order.
  useEffect(() => extendContext(route, ids), [ids.join()]);

  // Rows coming into view (and a few past them) are looked for.
  useEffect(() => {
    const el = list.current;
    if (!el || !songs.length) return;
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) if (e.isIntersecting) finder.current?.want(Number((e.target as HTMLElement).dataset.index) + 1 + AHEAD);
      },
      { root: el.closest(".main-scroll"), rootMargin: "200px 0px" },
    );
    el.querySelectorAll(".pop-row").forEach((row) => io.observe(row));
    return () => io.disconnect();
  }, [songs]);

  const play = async (i: number) => {
    const song = songs[i];
    const known = status[i];
    if (known?.state === "ready" && getState().currentId === known.id) return togglePlay();
    if (pending === i) return;
    setPending(i);
    const found = await finder.current!.request(i);
    setPending((p) => (p === i ? null : p));
    if (found.state !== "ready") {
      toast(`Couldn't find “${song.title}” to play`, { detail: found.state === "failed" ? "Music search isn't responding. Try again later." : "It isn't on YouTube or SoundCloud under that name.", tone: "error" });
      return;
    }
    playList(finder.current!.ready(), found.id, { label, route });
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
        <PlayFab ids={ids} label={label} route={route} size="lg" />
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
