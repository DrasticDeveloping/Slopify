import { useMemo, type MouseEvent, type ReactNode } from "react";
import { Art, PlaylistArt, TrackArt } from "../components/Artwork";
import { Bars, Icon } from "../components/Icon";
import { Card, PlayFab, Shelf, useContextPlaying } from "../components/Shelf";
import type { Genre } from "../data/types";
import { greeting, plural } from "../lib/format";
import { openPlaylistMenu, openTrackMenu } from "../lib/menus";
import { isPlayable, libraryIds, mixIds, mixNames, navigate, playList, togglePlay } from "../state/actions";
import { getState, useStore, type Route } from "../state/store";

function QuickTile({ title, art, route, ids, onMenu }: { title: string; art: ReactNode; route: Route; ids: string[]; onMenu?: (e: MouseEvent) => void }) {
  const state = useContextPlaying(route);
  return (
    <div className={`quick-tile${state.active ? " active" : ""}`} onContextMenu={onMenu}>
      <div className="quick-art">{art}</div>
      <button type="button" className="quick-link" onClick={() => navigate(route)}>
        {title}
      </button>
      {state.active ? <Bars paused={!state.playing} /> : null}
      <PlayFab ids={ids} label={title} route={route} size="sm" className="quick-fab" />
    </div>
  );
}

const genres: Genre[] = ["synthwave", "lofi", "house", "indie", "ambient"];

export function HomeView() {
  const playlists = useStore((s) => s.playlists);
  const tracks = useStore((s) => s.tracks);
  const artists = useStore((s) => s.artists);
  const albums = useStore((s) => s.albums);
  const history = useStore((s) => s.history);
  const currentId = useStore((s) => s.currentId);
  const isPlaying = useStore((s) => s.isPlaying);
  const status = useStore((s) => s.server.status);
  const name = useStore((s) => s.settings.profileName);

  const recent = useMemo(() => {
    const s = getState();
    return libraryIds(s).sort((a, b) => tracks[b].addedAt - tracks[a].addedAt).slice(0, 14);
  }, [tracks]);

  const jumpBack = useMemo(() => {
    const seen = new Set<string>();
    const ids = [currentId, ...history].filter(Boolean) as string[];
    const out: string[] = [];
    for (const id of ids) {
      const album = tracks[id]?.albumId;
      if (album && !seen.has(album)) {
        seen.add(album);
        out.push(album);
      }
    }
    // Pad with well-loved albums so the shelf is never empty on first launch.
    const byPlays = Object.values(albums)
      .map((a) => ({ id: a.id, plays: Object.values(tracks).filter((t) => t.albumId === a.id).reduce((n, t) => n + t.plays, 0) }))
      .sort((a, b) => b.plays - a.plays);
    for (const a of byPlays) if (!seen.has(a.id) && out.length < 12) {
      seen.add(a.id);
      out.push(a.id);
    }
    return out;
  }, [history, currentId, tracks, albums]);

  const topArtists = useMemo(() => {
    const plays: Record<string, number> = {};
    for (const t of Object.values(tracks)) plays[t.artistId] = (plays[t.artistId] ?? 0) + t.plays;
    return Object.keys(plays).filter((id) => artists[id] && id !== "ar_local").sort((a, b) => plays[b] - plays[a]).slice(0, 10);
  }, [tracks, artists]);

  const mixes = useMemo(() => genres.map((g) => ({ genre: g, ids: mixIds(getState(), g) })), [tracks, artists, status]);

  const quick = playlists.slice(0, 6);
  const albumTracks = (albumId: string) => Object.values(tracks).filter((t) => t.albumId === albumId && isPlayable(t)).map((t) => t.id);

  return (
    <div className="view home">
      <div className="home-glow" aria-hidden="true" />
      <h1 className="greeting">
        {greeting()}, <span className="grad-text">{name}</span>
      </h1>
      <div className="quick-grid">
        {quick.map((p) => (
          <QuickTile key={p.id} title={p.name} art={<PlaylistArt playlist={p} />} route={{ name: "playlist", id: p.id }} ids={p.trackIds} onMenu={(e) => openPlaylistMenu(e, p.id)} />
        ))}
      </div>

      <Shelf title="Made for you" subtitle="Daily mixes tuned to what you play most">
        {mixes.map(({ genre, ids }) => {
          const first = ids[0] ? albums[tracks[ids[0]].albumId] : undefined;
          const names = [...new Set(ids.map((id) => artists[tracks[id].artistId]?.name))].slice(0, 3).join(", ");
          return (
            <Card
              key={genre}
              art={
                <div className="mix-cover">
                  <Art palette={first?.palette ?? artists.ar0.palette} glyph={3} />
                  <span className="mix-label">{mixNames[genre].replace(" Mix", "")}</span>
                  <span className="mix-tag">Mix</span>
                </div>
              }
              title={mixNames[genre]}
              subtitle={names}
              onOpen={() => navigate({ name: "mix", genre })}
              play={{ ids, label: mixNames[genre], route: { name: "mix", genre } }}
            />
          );
        })}
      </Shelf>

      <Shelf title="Jump back in" subtitle="Albums from your recent listening">
        {jumpBack.map((albumId) => {
          const a = albums[albumId];
          return (
            <Card
              key={albumId}
              art={<Art palette={a.palette} glyph={a.glyph} image={a.artworkUrl} />}
              title={a.title}
              subtitle={artists[a.artistId]?.name ?? ""}
              onOpen={() => navigate({ name: "album", id: albumId })}
              play={{ ids: albumTracks(albumId), label: a.title, route: { name: "album", id: albumId } }}
            />
          );
        })}
      </Shelf>

      <Shelf title="Recently added" subtitle="Fresh to your library" action={<button type="button" className="text-btn" onClick={() => navigate({ name: "library" })}>Show all</button>}>
        {recent.map((id) => {
          const t = tracks[id];
          return (
            <div key={id} className={`card${currentId === id ? " current" : ""}`} onContextMenu={(e) => openTrackMenu(e, [id], { context: { label: "Recently added", route: { name: "library" }, ids: recent } })}>
              <div className="card-art">
                <TrackArt trackId={id} />
                <button
                  type="button"
                  className="play-fab md card-fab"
                  aria-label={currentId === id && isPlaying ? `Pause ${t.title}` : `Play ${t.title}`}
                  onClick={() => (currentId === id ? togglePlay() : playList(recent, id, { label: "Recently added", route: { name: "library" } }))}
                >
                  <Icon name={currentId === id && isPlaying ? "pause" : "play"} size={20} />
                </button>
              </div>
              <button type="button" className="card-link" onClick={() => navigate({ name: "album", id: t.albumId })}>
                <strong>{t.title}</strong>
                <span>{artists[t.artistId]?.name}</span>
              </button>
            </div>
          );
        })}
      </Shelf>

      <Shelf title="Your top artists" subtitle="Based on your plays">
        {topArtists.map((id) => {
          const a = artists[id];
          const ids = Object.values(tracks).filter((t) => t.artistId === id && isPlayable(t)).sort((x, y) => y.plays - x.plays).map((t) => t.id);
          return (
            <Card
              key={id}
              round
              art={<Art palette={a.palette} glyph={4} round label={a.name} />}
              title={a.name}
              subtitle={`Artist · ${plural(ids.length, "song")}`}
              onOpen={() => navigate({ name: "artist", id })}
              play={{ ids, label: a.name, route: { name: "artist", id } }}
            />
          );
        })}
      </Shelf>
    </div>
  );
}
