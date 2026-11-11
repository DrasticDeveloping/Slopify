import { creditLine } from "../lib/credits";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Art, BlurredTrackArt, PlaylistArt } from "../components/Artwork";
import { ChooseFiles } from "../components/ChooseFiles";
import { Hero } from "../components/Hero";
import { Icon } from "../components/Icon";
import { Card, PlayFab, Shelf } from "../components/Shelf";
import { TrackList } from "../components/TrackList";
import { PlaylistSuggestions } from "../components/PlaylistSuggestions";
import { SongView } from "./Song";
import { formatLongDuration, plural } from "../lib/format";
import { openPlaylistMenu, openTrackMenu } from "../lib/menus";
import { findMusic, libraryIds, navigate, openModal, startCollectionRadio, cycleShuffle } from "../state/actions";
import { downloadTracks } from "../state/server";
import { shareOf, useSocial } from "../state/social";
import { useStore, type Route } from "../state/store";

function ShuffleToggle() {
  const shuffle = useStore((s) => s.shuffle);
  const smart = useStore((s) => s.shuffle && s.smartShuffle);
  return (
    <button type="button" className={`icon-btn lg${shuffle ? " on" : ""}`} onClick={cycleShuffle} aria-pressed={shuffle} aria-label={smart ? "Smart shuffle" : "Shuffle"} title={smart ? "Smart shuffle: recommended songs mixed in" : shuffle ? "Shuffle on: press again for smart shuffle" : "Shuffle"}>
      <Icon name={smart ? "smartShuffle" : "shuffle"} size={24} />
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
      return t && `${t.title} ${creditLine(t, artists)} ${albums[t.albumId]?.title}`.toLowerCase().includes(needle);
    });
  }, [ids, q, tracks, artists, albums]);
}

export function PlaylistView({ id }: { id: string }) {
  const playlist = useStore((s) => s.playlists.find((p) => p.id === id));
  const tracks = useStore((s) => s.tracks);
  const libraryCount = useStore((s) => libraryIds(s).length);
  const profileName = useStore((s) => s.settings.profileName);
  const social = useSocial();
  const [q, setQ] = useState("");
  const ids = useMemo(() => playlist?.trackIds.filter((t) => tracks[t]) ?? [], [playlist, tracks]);
  const shown = useFiltered(ids, q);
  if (!playlist) return <Missing what="playlist" />;
  const route: Route = { name: "playlist", id };
  const total = ids.reduce((sum, t) => sum + (tracks[t]?.duration ?? 0), 0);
  const serverOnly = ids.filter((t) => tracks[t]?.storage === "server");
  const editable = !playlist.system;
  const shared = Boolean(shareOf(id, social));

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
        meta={<><span className="avatar-dot">{(profileName || "You").slice(0, 1).toUpperCase()}</span><strong>{profileName || "You"}</strong><span>{plural(ids.length, "song")}</span>{total ? <span>{formatLongDuration(total)}</span> : null}</>}
      />
      {ids.length || editable ? <div className="action-bar">
        {ids.length ? (
          <>
            <PlayFab ids={ids} label={playlist.name} route={route} size="lg" />
            <ShuffleToggle />
          </>
        ) : null}
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
        {editable ? (
          <button type="button" className={`icon-btn lg${shared ? " on" : ""}`} onClick={() => openModal({ type: "sharePlaylist", id })} aria-label={shared ? "Sharing" : "Share"} title={shared ? "Shared: manage sharing" : "Share"}>
            <Icon name="link" size={24} />
          </button>
        ) : null}
        <button type="button" className="icon-btn lg" onClick={(e) => openPlaylistMenu(e.currentTarget, id)} aria-label="More playlist options">
          <Icon name="more" size={24} />
        </button>
        <span className="spacer" />
        {ids.length ? <Filter value={q} onChange={setQ} /> : null}
      </div> : null}
      <TrackList
        ids={shown}
        context={{ label: playlist.name, route }}
        playlistId={id}
        reorderable={!q.trim()}
        empty={
          q ? <Empty icon="search" title="No matches" body={`Nothing in “${playlist.name}” matches “${q}”.`} /> : id === "liked" && libraryCount ? (
            <p className="muted liked-empty"><Icon name="heart" size={16} /> Songs you like will appear here.</p>
          ) : (
            <Empty
              icon={playlist.system ? "heart" : "playlists"}
              title={playlist.system ? "Songs you like will appear here" : "Let's find something for your playlist"}
              body={playlist.system ? "Tap the heart on any song to save it here." : libraryCount ? "Add songs from your library, or find new music to save." : "Your library is empty: find some music or choose files first, then add them here."}
              action={editable ? (
                <>
                  {libraryCount ? <button type="button" className="btn primary" onClick={() => openModal({ type: "addSongs", playlistId: id })}><Icon name="plus" size={18} />Add songs</button> : null}
                  <button type="button" className={`btn${libraryCount ? "" : " primary"}`} onClick={() => findMusic()}><Icon name="search" size={18} />Find music</button>
                  {libraryCount ? null : <ChooseFiles />}
                </>
              ) : <button type="button" className="btn" onClick={() => navigate({ name: "library" })}>Browse library</button>}
            />
          )
        }
      />
      {editable && ids.length ? <PlaylistSuggestions id={id} name={playlist.name} seedIds={ids} /> : null}
      {id === "liked" && !ids.length && !q ? <StarterSongs /> : null}
    </div>
  );
}

export function AlbumView({ id }: { id: string }) {
  const album = useStore((s) => s.albums[id]);
  const artist = useStore((s) => (album ? s.artists[album.artistId] : undefined));
  const trackMap = useStore((s) => s.tracks);
  const ids = useMemo(() => Object.values(trackMap).filter((t) => t.albumId === id).map((t) => t.id), [trackMap, id]);
  const albumMap = useStore((s) => s.albums);
  const artistMap = useStore((s) => s.artists);
  // The artist's other albums in your library, so a single isn't a dead end.
  const more = useMemo(() => {
    if (!album) return [];
    const seen = new Set<string>();
    for (const t of Object.values(trackMap)) if (!t.stream && t.artistId === album.artistId && t.albumId !== id && albumMap[t.albumId]) seen.add(t.albumId);
    return [...seen];
  }, [trackMap, albumMap, album, id]);
  if (!album || !artist) return <Missing what="album" />;
  // A single is its song: it gets the song's page (statistics and songs like it).
  if (ids.length === 1) {
    const t = trackMap[ids[0]];
    return <SongView key={t.id} artist={artistMap[t.artistId]?.name ?? artist.name} title={t.title} id={t.id} />;
  }
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
        wash={ids[0] && album.artworkUrl ? <BlurredTrackArt trackId={ids[0]} /> : undefined}
        play={{ ids, label: album.title, route }}
        meta={<><Art palette={artist.palette} round className="meta-avatar" image={artist.image} /><button type="button" className="link strong" onClick={() => navigate({ name: "artist", id: artist.id })}>{artist.name}</button>{album.year ? <span>{album.year}</span> : null}<span>{plural(ids.length, "song")}, {formatLongDuration(total)}</span></>}
      />
      <div className="action-bar">
        <PlayFab ids={ids} label={album.title} route={route} size="lg" />
        <button type="button" className="btn" onClick={() => startCollectionRadio(ids, album.title)}>
          <Icon name="radio" size={18} />
          Album radio
        </button>
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
      {album.released ? <p className="fine-print">Released {new Date(`${album.released}T12:00:00`).toLocaleDateString(undefined, { day: "numeric", month: "long", year: "numeric" })}</p> : null}
      {more.length ? (
        <Shelf title={`More by ${artist.name}`} action={<button type="button" className="text-btn" onClick={() => navigate({ name: "artist", id: artist.id })}>See artist</button>}>
          {more.map((albumId) => {
            const a = albumMap[albumId];
            return <Card key={albumId} art={<Art palette={a.palette} glyph={a.glyph} image={a.artworkUrl} />} title={a.title} subtitle={a.year ? String(a.year) : artist.name} onOpen={() => navigate({ name: "album", id: albumId })} />;
          })}
        </Shelf>
      ) : null}
    </div>
  );
}

/** An empty Liked Songs: your most-played songs, each a heart away from being in it. */
function StarterSongs() {
  const tracks = useStore((s) => s.tracks);
  const ids = useMemo(() => Object.values(tracks).filter((t) => !t.stream).sort((a, b) => b.plays - a.plays || b.addedAt - a.addedAt).slice(0, 8).map((t) => t.id), [tracks]);
  if (!ids.length) return null;
  return (
    <section className="starter-songs">
      <h2 className="section-title">Start with what you play most</h2>
      <p className="muted small">Tap the heart on a song to add it to Liked Songs.</p>
      <TrackList ids={ids} context={{ label: "Your library", route: { name: "library" } }} showAdded={false} sortable={false} />
    </section>
  );
}

export function Empty({ icon, title, body, action }: { icon: string; title: string; body?: string; action?: ReactNode }) {
  return (
    <div className="empty">
      <span className="empty-icon"><Icon name={icon} size={28} /></span>
      <strong>{title}</strong>
      {body ? <p>{body}</p> : null}
      {action ? <div className="empty-actions">{action}</div> : null}
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
