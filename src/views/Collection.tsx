import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Art, PlaylistArt } from "../components/Artwork";
import { Hero } from "../components/Hero";
import { Icon } from "../components/Icon";
import { PlayFab } from "../components/Shelf";
import { TrackList } from "../components/TrackList";
import { formatLongDuration, plural } from "../lib/format";
import { openPlaylistMenu, openTrackMenu } from "../lib/menus";
import { downloadTracks, navigate, openModal, toggleShuffle } from "../state/actions";
import { useStore, type Route } from "../state/store";

function ShuffleToggle() {
  const shuffle = useStore((s) => s.shuffle);
  return (
    <button type="button" className={`icon-btn lg${shuffle ? " on" : ""}`} onClick={toggleShuffle} aria-pressed={shuffle} aria-label="Shuffle" title="Shuffle">
      <Icon name="shuffle" size={24} />
    </button>
  );
}

function Filter({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const [open, setOpen] = useState(Boolean(value));
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (open) input.current?.focus();
  }, [open]);
  return (
    <label className={`inline-filter${open || value ? " open" : ""}`}>
      <button type="button" className="icon-btn" onClick={() => setOpen(true)} aria-label="Find in this list" tabIndex={open ? -1 : 0}>
        <Icon name="search" size={18} />
      </button>
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onBlur={() => !value && setOpen(false)}
        placeholder="Find in list"
        aria-label="Find in this list"
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            onChange("");
            setOpen(false);
          }
        }}
        tabIndex={open ? 0 : -1}
        ref={input}
      />
    </label>
  );
}

function useFiltered(ids: string[], q: string) {
  const tracks = useStore((s) => s.tracks);
  const artists = useStore((s) => s.artists);
  const albums = useStore((s) => s.albums);
  return useMemo(() => {
    const needle = q.trim().toLowerCase();
    if (!needle) return ids;
    return ids.filter((id) => {
      const t = tracks[id];
      return t && `${t.title} ${artists[t.artistId]?.name} ${albums[t.albumId]?.title}`.toLowerCase().includes(needle);
    });
  }, [ids, q, tracks, artists, albums]);
}

export function PlaylistView({ id }: { id: string }) {
  const playlist = useStore((s) => s.playlists.find((p) => p.id === id));
  const tracks = useStore((s) => s.tracks);
  const [q, setQ] = useState("");
  const ids = useMemo(() => playlist?.trackIds.filter((t) => tracks[t]) ?? [], [playlist, tracks]);
  const shown = useFiltered(ids, q);
  if (!playlist) return <Missing what="playlist" />;
  const route: Route = { name: "playlist", id };
  const total = ids.reduce((sum, t) => sum + (tracks[t]?.duration ?? 0), 0);
  const serverOnly = ids.filter((t) => tracks[t]?.storage === "server");
  const editable = !playlist.system;

  return (
    <div className="view">
      <Hero
        art={<PlaylistArt playlist={playlist} />}
        kind={playlist.system ? "Collection" : "Playlist"}
        title={playlist.name}
        description={playlist.description}
        tint={playlist.palette.b}
        play={{ ids, label: playlist.name, route }}
        onTitleClick={editable ? () => openModal({ type: "editPlaylist", id }) : undefined}
        meta={<><span className="avatar-dot">D</span><strong>You</strong><span>{plural(ids.length, "song")}</span>{total ? <span>{formatLongDuration(total)}</span> : null}</>}
      />
      <div className="action-bar">
        <PlayFab ids={ids} label={playlist.name} route={route} size="lg" />
        <ShuffleToggle />
        {editable ? (
          <button type="button" className="icon-btn lg" onClick={() => openModal({ type: "addSongs", playlistId: id })} aria-label="Add songs" title="Add songs">
            <Icon name="plus" size={24} />
          </button>
        ) : null}
        {serverOnly.length ? (
          <button type="button" className="icon-btn lg" onClick={() => downloadTracks(serverOnly)} aria-label={`Download ${serverOnly.length} songs`} title={`Download ${plural(serverOnly.length, "song")}`}>
            <Icon name="download" size={24} />
          </button>
        ) : null}
        <button type="button" className="icon-btn lg" onClick={(e) => openPlaylistMenu(e.currentTarget, id)} aria-label="More playlist options">
          <Icon name="more" size={24} />
        </button>
        <span className="spacer" />
        {ids.length ? <Filter value={q} onChange={setQ} /> : null}
      </div>
      <TrackList
        ids={shown}
        context={{ label: playlist.name, route }}
        playlistId={id}
        reorderable={!q.trim()}
        empty={
          q ? <Empty icon="search" title="No matches" body={`Nothing in “${playlist.name}” matches “${q}”.`} /> : (
            <Empty
              icon={playlist.system ? "heart" : "playlists"}
              title={playlist.system ? "Songs you like will appear here" : "Let's find something for your playlist"}
              body={playlist.system ? "Tap the heart on any song to save it here." : "Add songs from your library, or drag them onto this playlist in the sidebar."}
              action={editable ? <button type="button" className="btn primary" onClick={() => openModal({ type: "addSongs", playlistId: id })}><Icon name="plus" size={18} />Add songs</button> : <button type="button" className="btn" onClick={() => navigate({ name: "library" })}>Browse library</button>}
            />
          )
        }
      />
    </div>
  );
}

export function AlbumView({ id }: { id: string }) {
  const album = useStore((s) => s.albums[id]);
  const artist = useStore((s) => (album ? s.artists[album.artistId] : undefined));
  const trackMap = useStore((s) => s.tracks);
  const ids = useMemo(() => Object.values(trackMap).filter((t) => t.albumId === id).map((t) => t.id), [trackMap, id]);
  if (!album || !artist) return <Missing what="album" />;
  const route: Route = { name: "album", id };
  const total = ids.reduce((sum, t) => sum + (trackMap[t]?.duration ?? 0), 0);
  const serverOnly = ids.filter((t) => trackMap[t]?.storage === "server");
  return (
    <div className="view">
      <Hero
        art={<Art palette={album.palette} glyph={album.glyph} image={album.artworkUrl} label={`${album.title} cover`} />}
        kind={ids.length < 3 ? "Single" : "Album"}
        title={album.title}
        tint={album.palette.b}
        play={{ ids, label: album.title, route }}
        meta={<><Art palette={artist.palette} round className="meta-avatar" /><button type="button" className="link strong" onClick={() => navigate({ name: "artist", id: artist.id })}>{artist.name}</button><span>{album.year}</span><span>{plural(ids.length, "song")}, {formatLongDuration(total)}</span></>}
      />
      <div className="action-bar">
        <PlayFab ids={ids} label={album.title} route={route} size="lg" />
        <ShuffleToggle />
        {serverOnly.length ? (
          <button type="button" className="icon-btn lg" onClick={() => downloadTracks(serverOnly)} aria-label="Download album" title="Download album">
            <Icon name="download" size={24} />
          </button>
        ) : null}
        <button type="button" className="icon-btn lg" onClick={(e) => openTrackMenu(e.currentTarget, ids, { context: { label: album.title, route, ids } })} aria-label="More album options">
          <Icon name="more" size={24} />
        </button>
      </div>
      <TrackList ids={ids} context={{ label: album.title, route }} showAlbum={false} showAdded={false} sortable={false} />
      <p className="fine-print">© {album.year} {artist.name}. Generated for the Slopify mockup.</p>
    </div>
  );
}

export function Empty({ icon, title, body, action }: { icon: string; title: string; body?: string; action?: ReactNode }) {
  return (
    <div className="empty">
      <span className="empty-icon"><Icon name={icon} size={28} /></span>
      <strong>{title}</strong>
      {body ? <p>{body}</p> : null}
      {action}
    </div>
  );
}

export function Missing({ what }: { what: string }) {
  return (
    <div className="view">
      <Empty icon="help" title={`This ${what} doesn't exist anymore`} body="It may have been deleted." action={<button type="button" className="btn" onClick={() => navigate({ name: "home" })}>Go home</button>} />
    </div>
  );
}
