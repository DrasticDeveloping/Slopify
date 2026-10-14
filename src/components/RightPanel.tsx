import { useState, type CSSProperties } from "react";
import { formatTime, plural } from "../lib/format";
import { useCurrent } from "../lib/hooks";
import { openTrackMenu } from "../lib/menus";
import { clearUpNext, isLiked, togglePlay, jumpToOrderIndex, jumpToUpNext, navigate, nextTrackId, openModal, playTrackNow, removeFromUpNext, toggleLike } from "../state/actions";
import { setState, useStore } from "../state/store";
import { ArtistLinks } from "./ArtistLinks";
import { Art, TrackArt } from "./Artwork";
import { Bars, Icon } from "./Icon";
import { PlatformBadge } from "./TrackList";
import { VideoSurface } from "./VideoSurface";
import { useSlippedIn } from "../state/slipins";

function QueueRow({ id, onPlay, onRemove, current, index }: { id: string; onPlay: () => void; onRemove?: () => void; current?: boolean; index?: number }) {
  const track = useStore((s) => s.tracks[id]);
  const artist = useStore((s) => (track ? s.artists[track.artistId] : undefined));
  const isPlaying = useStore((s) => s.isPlaying);
  if (!track) return null;
  return (
    <div className={`q-row${current ? " current" : ""}`} style={index !== undefined ? ({ "--i": Math.min(index, 12) } as CSSProperties) : undefined} onContextMenu={(e) => openTrackMenu(e, [id])}>
      <button type="button" className="q-hit" onClick={onPlay} aria-label={current && isPlaying ? `Pause ${track.title}` : `Play ${track.title}`} />
      <div className="q-art">
        <TrackArt trackId={id} />
        {current ? <span className="q-eq"><Bars paused={!isPlaying} /></span> : <span className="q-play"><Icon name="play" size={14} /></span>}
      </div>
      <span className="title-text">
        <span className={`t-name${current ? " accent" : ""}`}>{track.title}<PlatformBadge track={track} /></span>
        <span className="t-sub">{artist?.name}</span>
      </span>
      <span className="q-dur">{formatTime(track.duration)}</span>
      {onRemove ? (
        <button type="button" className="icon-btn sm q-remove" onClick={onRemove} aria-label={`Remove ${track.title} from queue`}>
          <Icon name="close" size={14} />
        </button>
      ) : null}
    </div>
  );
}

export function QueueView() {
  const currentId = useStore((s) => s.currentId);
  const upNext = useStore((s) => s.upNext);
  const order = useStore((s) => s.order);
  const index = useStore((s) => s.index);
  const context = useStore((s) => s.context);
  const history = useStore((s) => s.history);
  const repeat = useStore((s) => s.repeat);
  const [tab, setTab] = useState<"queue" | "recent">("queue");
  const rest = order.slice(index + 1, index + 61);
  // With repeat-all the queue wraps around to the start of the context.
  const wrap = repeat === "all" && rest.length < 60 ? order.slice(0, Math.max(0, Math.min(index, 60 - rest.length))) : [];

  return (
    <>
      <div className="tabs" role="tablist" aria-label="Queue view">
        <button type="button" role="tab" aria-selected={tab === "queue"} className={tab === "queue" ? "on" : ""} onClick={() => setTab("queue")}>Queue</button>
        <button type="button" role="tab" aria-selected={tab === "recent"} className={tab === "recent" ? "on" : ""} onClick={() => setTab("recent")}>Recently played</button>
        <span className="tab-pill" style={{ "--x": tab === "queue" ? 0 : 1 } as CSSProperties} />
      </div>
      {tab === "queue" ? (
        <div className="q-scroll" role="tabpanel">
          {currentId ? (
            <section>
              <h3 className="q-head">Now playing</h3>
              <QueueRow id={currentId} current onPlay={togglePlay} />
            </section>
          ) : (
            <p className="muted small q-empty">Nothing is playing. Start a song and your queue shows up here.</p>
          )}
          {upNext.length ? (
            <section>
              <h3 className="q-head">
                Next in queue
                <button type="button" className="text-btn" onClick={clearUpNext}>Clear</button>
              </h3>
              {upNext.map((id, i) => (
                <QueueRow key={`${id}-${i}`} id={id} index={i} onPlay={() => jumpToUpNext(i)} onRemove={() => removeFromUpNext(i)} />
              ))}
            </section>
          ) : null}
          {rest.length || wrap.length ? (
            <section>
              <h3 className="q-head">
                Next from: <button type="button" className="link strong" onClick={() => context?.route && navigate(context.route)}>{context?.label}</button>
              </h3>
              {rest.map((id, i) => (
                <QueueRow key={`${id}-${index + 1 + i}`} id={id} index={i} onPlay={() => jumpToOrderIndex(index + 1 + i)} />
              ))}
              {wrap.map((id, i) => (
                <QueueRow key={`wrap-${id}-${i}`} id={id} index={rest.length + i} onPlay={() => jumpToOrderIndex(i)} />
              ))}
            </section>
          ) : null}
        </div>
      ) : (
        <div className="q-scroll" role="tabpanel">
          {history.length ? history.map((id, i) => <QueueRow key={`${id}-${i}`} id={id} index={i} onPlay={() => playTrackNow(id)} />) : <p className="muted small q-empty">Songs you play will show up here.</p>}
        </div>
      )}
    </>
  );
}

function DetailsView() {
  const { id, track, artist, album, range } = useCurrent();
  const liked = useStore((s) => (id ? isLiked(id, s) : false));
  const slipped = useSlippedIn();
  const nextId = useStore((s) => (s.currentId ? nextTrackId() : null));
  const nextTrack = useStore((s) => (nextId ? s.tracks[nextId] : null));
  const nextArtist = useStore((s) => (nextTrack ? s.artists[nextTrack.artistId] : null));
  const albumCount = useStore((s) => (album ? Object.values(s.tracks).filter((t) => t.albumId === album.id).length : 0));
  const clipped = Boolean(track && (range.start > 0 || range.end < track.duration - 0.5));
  if (!track || !artist || !album) {
    return (
      <div className="np-empty">
        <Art palette={{ a: "hsl(260 60% 40%)", b: "hsl(290 50% 30%)", c: "hsl(230 40% 15%)" }} glyph={0} />
        <strong>Nothing playing</strong>
        <p className="muted small">Play something and its details, artist, and what's next will show up here.</p>
      </div>
    );
  }
  return (
    <div className="q-scroll np-details" key={track.id}>
      {track.kind === "video" && (track.mediaUrl || track.fileUrl) ? (
        <button type="button" className="np-art video" onClick={() => setState({ fullPlayer: true })} aria-label="Open full screen player">
          <VideoSurface trackId={track.id} priority={1} />
        </button>
      ) : (
        <button type="button" className="np-art" onClick={() => setState({ fullPlayer: true })} aria-label="Open full screen player">
          <TrackArt trackId={track.id} />
        </button>
      )}
      <div className="np-title-row">
        <div className="title-text">
          <button type="button" className="link np-title" onClick={() => navigate({ name: "album", id: album.id })}>{track.title}</button>
          <span className="np-artist"><ArtistLinks track={track} /></span>
          {slipped === track.id ? <span className="small muted slipped-note" title="A song you marked to slip into your listening. Skip it if you're not feeling it; your list carries on next.">Slipped in</span> : null}
        </div>
        <button type="button" className={`icon-btn like-btn${liked ? " on" : ""}`} onClick={() => toggleLike(track.id)} aria-pressed={liked} aria-label={liked ? "Remove from Liked Songs" : "Add to Liked Songs"}>
          <Icon name={liked ? "heartFill" : "heart"} size={22} />
        </button>
      </div>

      <div className="info-card">
        <h3>Details</h3>
        <dl className="kv">
          <dt>Album</dt><dd><button type="button" className="link" onClick={() => navigate({ name: "album", id: album.id })}>{album.title}</button>{album.year ? ` · ${album.year}` : ""}</dd>
          <dt>Format</dt><dd>{track.kind === "video" ? "Video" : "Audio"} · {track.storage === "server" ? "Streaming" : track.storage === "downloads" ? "Downloaded" : "Local file"}</dd>
          <dt>Plays</dt><dd>{track.plays.toLocaleString("en")}</dd>
          <dt>Clip</dt>
          <dd>
            {clipped ? `${formatTime(range.start)} – ${formatTime(range.end)}` : "Full song"}{" "}
            <button type="button" className="text-btn" onClick={() => openModal({ type: "clipEditor", trackId: track.id })}>Edit</button>
          </dd>
        </dl>
      </div>

      <button type="button" className="artist-card" style={{ "--a": artist.palette.a, "--b": artist.palette.b, "--c": artist.palette.c } as CSSProperties} onClick={() => navigate({ name: "artist", id: artist.id })}>
        <span className="artist-card-bg"><Art palette={artist.palette} glyph={4} /></span>
        <span className="artist-card-label">About the artist</span>
        <span className="artist-card-body">
          <strong>{artist.name}</strong>
          <small>{plural(albumCount, "song")} on “{album.title}”</small>
        </span>
      </button>

      <div className="info-card">
        <h3>
          Next up
          <button type="button" className="text-btn" onClick={() => setState({ panel: "queue" })}>Open queue</button>
        </h3>
        {nextTrack ? (
          <div className="q-row">
            <div className="q-art"><TrackArt trackId={nextTrack.id} /></div>
            <span className="title-text">
              <span className="t-name">{nextTrack.title}</span>
              <span className="t-sub">{nextArtist?.name}</span>
            </span>
            <span className="q-dur">{formatTime(nextTrack.duration)}</span>
          </div>
        ) : (
          <p className="muted small">End of queue. Turn on repeat or add more songs.</p>
        )}
      </div>
    </div>
  );
}

/** The side panel that's open: Now playing waits for a song, rather than taking up the screen with nothing in it. */
export const usePanel = () => useStore((s) => (s.panel === "details" && !s.currentId ? null : s.panel));

export function RightPanel() {
  const panel = usePanel();
  const label = useStore((s) => s.context?.label);
  if (!panel) return null;
  return (
    <aside className="right-panel" aria-label={panel === "queue" ? "Queue" : "Now playing"}>
      <header className="rp-head">
        <div>
          <h2>{panel === "queue" ? "Queue" : "Now playing"}</h2>
          {panel === "details" && label ? <span className="muted small">From {label}</span> : null}
        </div>
        <div className="rp-actions">
          <button type="button" className="icon-btn sm" onClick={() => setState({ panel: panel === "queue" ? "details" : "queue" })} aria-label={panel === "queue" ? "Show now playing" : "Show queue"} title={panel === "queue" ? "Now playing" : "Queue"}>
            <Icon name={panel === "queue" ? "nowPlaying" : "queue"} size={18} />
          </button>
          <button type="button" className="icon-btn sm" onClick={() => setState({ panel: null })} aria-label="Close panel">
            <Icon name="close" size={18} />
          </button>
        </div>
      </header>
      {panel === "queue" ? <QueueView /> : <DetailsView />}
    </aside>
  );
}

