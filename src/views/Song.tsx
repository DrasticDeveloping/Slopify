import { useMemo, useState, type ReactNode } from "react";
import { Art, BlurredTrackArt, TrackArt } from "../components/Artwork";
import { DiscoveryShelf } from "../components/DiscoveryShelf";
import { Hero } from "../components/Hero";
import { Icon } from "../components/Icon";
import { hashString, paletteFromSeed } from "../data/library";
import { formatTime } from "../lib/format";
import { usePlays } from "../lib/plays";
import { openArtist } from "../recommend/artist";
import { discoveryKey } from "../recommend/discover";
import { ownedIndex } from "../recommend/owned";
import { formatPopularity, notableVersion, POPULARITY_MAX, useSongStats, type SongStats } from "../recommend/popular";
import { resolveSong } from "../recommend/releases";
import { openTrackMenu } from "../lib/menus";
import { isLiked, navigate, playList, songRoute, startRadio, toast, toggleLike, togglePlay } from "../state/actions";
import { getState, useStore } from "../state/store";

const TYPES: Record<string, string> = { album: "album", single: "single", ep: "EP", compile: "compilation" };

/** One song: its statistics from the music catalog, and songs that listeners of it also play. */
export function SongView({ artist, title, id }: { artist: string; title: string; id?: string }) {
  const tracks = useStore((s) => s.tracks);
  /** A copy found to play from this page. */
  const [foundId, setFoundId] = useState<string>();
  // The song the page was opened from, else your library's copy of it, else one found to play.
  const trackId = useMemo(
    () => (id && tracks[id] ? id : ownedIndex(getState()).find({ artist, title })[0] ?? (foundId && tracks[foundId] ? foundId : undefined)),
    [id, tracks, artist, title, foundId],
  );
  const track = trackId ? tracks[trackId] : undefined;
  const stats = useSongStats(artist, title);
  const s = stats.value;
  const route = songRoute(artist, title, id);
  const seeds = useMemo(() => ({ songs: [{ name: artist, title, weight: 1 }], artists: [{ name: artist, title, weight: 1 }] }), [artist, title]);
  const exclude = useMemo(() => [discoveryKey(artist, title)], [artist, title]);
  const seed = hashString(`${artist}|${title}`);
  const palette = paletteFromSeed(seed);
  const [finding, setFinding] = useState(false);
  const liked = useStore((st) => !!trackId && isLiked(trackId, st));
  const plays = usePlays(trackId);
  // The album it's on in your library, when that's more than this one song (a single's page is this page).
  const albums = useStore((st) => st.albums);
  const libraryAlbum = useMemo(() => {
    const album = track && !track.stream ? albums[track.albumId] : undefined;
    return album && Object.values(tracks).some((t) => t.albumId === album.id && t.id !== track!.id) ? album : undefined;
  }, [track, albums, tracks]);
  const current = useStore((st) => !!trackId && st.currentId === trackId);
  const playing = useStore((st) => st.isPlaying) && current;

  /** This song's track, looked for on YouTube or SoundCloud if the app doesn't have one yet. */
  const playable = async () => {
    if (trackId) return trackId;
    setFinding(true);
    const found = await resolveSong({ title: s?.title ?? title, artist, durationSeconds: s?.durationSeconds ?? null, artwork: s?.artwork, album: s?.origin?.album ?? s?.album, released: s?.origin?.released });
    setFinding(false);
    if (found.state === "ready") {
      setFoundId(found.id);
      return found.id;
    }
    toast(`Couldn't find “${title}” to play`, { detail: found.state === "failed" ? "Music search isn't responding. Try again later." : "It isn't on YouTube or SoundCloud under that name.", tone: "error" });
    return null;
  };
  const play = async () => {
    if (current) return togglePlay();
    const found = await playable();
    if (found) playList([found], found, { label: title, route });
  };
  const radio = async () => {
    const found = await playable();
    if (found) startRadio(found);
  };

  const origin = s?.origin;
  const year = (origin?.released ?? s?.released ?? "").slice(0, 4);
  const duration = s?.durationSeconds ?? track?.duration ?? 0;
  const version = s ? notableVersion(s.version) : "";

  return (
    <div className="view">
      <Hero
        art={trackId ? <TrackArt trackId={trackId} /> : <Art palette={palette} glyph={seed % 6} image={s?.artwork} label={`${title} cover`} />}
        wash={trackId ? <BlurredTrackArt trackId={trackId} /> : undefined}
        kind={version ? `Song · ${version.replace(/^\(|\)$/g, "")}` : "Song"}
        title={title}
        tint={palette.b}
        meta={
          <>
            <button type="button" className="link strong" onClick={() => openArtist({ name: artist })}>{artist}</button>
            {libraryAlbum ? (
              <span>
                <button type="button" className="link" onClick={() => navigate({ name: "album", id: libraryAlbum.id })}>{libraryAlbum.title}</button>
              </span>
            ) : origin ? (
              <span>
                <button type="button" className="link" onClick={() => navigate({ name: "release", id: origin.albumId })}>{origin.album}</button>
              </span>
            ) : null}
            {year ? <span>{year}</span> : null}
            {duration ? <span>{formatTime(duration)}</span> : null}
          </>
        }
      />
      <div className="action-bar">
        <button type="button" className={`play-fab lg${playing ? " is-playing" : ""}${finding ? " loading" : ""}`} onClick={() => void play()} disabled={finding} aria-label={`${playing ? "Pause" : "Play"} ${title}`}>
          <Icon name={playing ? "pause" : "play"} size={26} />
        </button>
        <button type="button" className="btn" onClick={() => void radio()} disabled={finding}>
          <Icon name="radio" size={18} />
          Song radio
        </button>
        {trackId ? (
          <button type="button" className={`icon-btn lg like-btn${liked ? " on" : ""}`} onClick={() => toggleLike(trackId)} aria-pressed={liked} aria-label={liked ? "Remove from Liked Songs" : "Add to Liked Songs"} title={liked ? "Remove from Liked Songs" : "Add to Liked Songs"}>
            <Icon name={liked ? "heartFill" : "heart"} size={24} />
          </button>
        ) : null}
        {trackId ? (
          <button type="button" className="icon-btn lg" onClick={(e) => openTrackMenu(e.currentTarget, [trackId], { context: { label: title, route, ids: [trackId] } })} aria-label={`More options for ${title}`} title="More options">
            <Icon name="more" size={24} />
          </button>
        ) : null}
        {s ? (
          <a className="icon-btn lg" href={s.sourceUrl} target="_blank" rel="noreferrer" aria-label="Open in Deezer" title="Open in Deezer">
            <Icon name="external" size={22} />
          </a>
        ) : null}
        {finding ? <span className="muted small" role="status">Finding “{title}” to play…</span> : null}
      </div>

      <section className="song-stats" aria-labelledby="song-stats-title">
        <h2 className="section-title" id="song-stats-title">Statistics</h2>
        {stats.loading ? (
          <div className="stat-grid" role="status" aria-label="Loading statistics">
            {Array.from({ length: 6 }, (_, i) => <span key={i} className="stat sk" />)}
          </div>
        ) : stats.error ? (
          <div className="inline-error" role="status">
            <Icon name="globe" size={18} />
            <span><strong>Statistics aren't available right now</strong><small>{stats.error}</small></span>
            <button type="button" className="btn sm" onClick={stats.retry}><Icon name="sync" size={15} />Try again</button>
          </div>
        ) : (
          <div className="stat-grid">
            {s ? <StatTiles stats={s} artist={artist} /> : null}
            <Stat label="Your plays" value={plays.toLocaleString()} detail={track && !track.stream ? "In your library" : "Not in your library"} />
          </div>
        )}
        {!stats.loading && !stats.error && !s ? <p className="muted small">The music catalog doesn't have this song, so it has no popularity or tempo figures.</p> : null}
      </section>

      <DiscoveryShelf
        title="Similar songs"
        subtitle={`Songs that listeners of “${title}” also play`}
        seeds={seeds}
        exclude={exclude}
        limit={24}
        route={route}
        grid
        openSong
      />
      {s ? <p className="fine-print">Popularity, tempo and release from Deezer; similar songs from ListenBrainz listening data.</p> : null}
    </div>
  );
}

function StatTiles({ stats: s, artist }: { stats: SongStats; artist: string }) {
  const released = s.origin?.released ?? s.released;
  return (
    <>
      <Stat label="Popularity" value={formatPopularity(s.rank)} detail="out of 1M on Deezer" meter={s.rank / POPULARITY_MAX} />
      {s.position ? <Stat label="Rank" value={`#${s.position}`} detail={`of ${s.of} ${s.artist || artist} songs`} /> : null}
      {s.bpm ? <Stat label="Tempo" value={String(s.bpm)} detail="beats per minute" /> : null}
      {s.durationSeconds ? <Stat label="Length" value={formatTime(s.durationSeconds)} detail={s.explicit ? "Explicit" : "Clean"} /> : null}
      {released ? (
        <Stat
          label="Released"
          value={new Date(`${released}T12:00:00`).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" })}
          detail={s.origin ? `On the ${TYPES[s.origin.type] ?? "release"} ${s.origin.album}` : s.album}
        />
      ) : null}
    </>
  );
}

function Stat({ label, value, detail, meter }: { label: string; value: ReactNode; detail?: string; meter?: number }) {
  return (
    <div className="stat">
      <span className="stat-label">{label}</span>
      <strong className="stat-value">{value}</strong>
      {meter !== undefined ? <span className="pop-meter" aria-hidden="true"><span style={{ width: `${Math.max(2, Math.min(1, meter) * 100)}%` }} /></span> : null}
      {detail ? <span className="stat-detail">{detail}</span> : null}
    </div>
  );
}
