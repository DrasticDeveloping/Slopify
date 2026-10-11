import { useEffect, useMemo, type MouseEvent, type ReactNode } from "react";
import { ensureMixes, mixSeed, useMixes } from "../recommend/mixes";
import { paletteFromSeed } from "../data/library";
import { Art, PlaylistArt, TrackArt } from "../components/Artwork";
import { Bars, Icon } from "../components/Icon";
import { DiscoveryShelf } from "../components/DiscoveryShelf";
import { Card, PlayFab, Shelf, useContextPlaying } from "../components/Shelf";
import { greeting, plural } from "../lib/format";
import { openPlaylistMenu, openTrackMenu } from "../lib/menus";
import { hasTaste } from "../recommend/rank";
import { hideRecommendation, isPlayable, libraryIds, navigate, openModal, playList, recommendations, togglePlay } from "../state/actions";
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

export function HomeView() {
  const mixes = useMixes();
  const playlists = useStore((s) => s.playlists);
  const tracks = useStore((s) => s.tracks);
  const artists = useStore((s) => s.artists);
  const albums = useStore((s) => s.albums);
  const history = useStore((s) => s.history);
  const currentId = useStore((s) => s.currentId);
  const isPlaying = useStore((s) => s.isPlaying);
  const status = useStore((s) => s.server.status);
  const name = useStore((s) => s.settings.profileName);
  // Only changes that can move suggestions (not every listening progress save) re-rank the shelves.
  const tasteRev = useStore((s) => s.taste.rev);
  useEffect(() => {
    ensureMixes();
    const timer = window.setInterval(() => ensureMixes(), 60_000);
    return () => clearInterval(timer);
  }, [tasteRev, tracks]);

  // By default "Recommended for you" is new songs from the web; library songs only when Settings asks for them.
  const includeLibrary = useStore((s) => s.settings.recommendLibrary);
  const forYou = useMemo(() => (includeLibrary ? recommendations(getState(), { mode: "home", limit: 16 }) : []), [includeLibrary, tracks, artists, status, tasteRev, playlists]);
  const forYouIds = forYou.map((r) => r.id);
  const forYouPicks = Object.fromEntries(forYou.map((r) => [r.id, r.kind]));
  const personal = useMemo(() => hasTaste(getState()), [tracks, tasteRev, playlists]);

  const recent = useMemo(() => {
    const s = getState();
    return libraryIds(s).sort((a, b) => tracks[b].addedAt - tracks[a].addedAt).slice(0, 14);
  }, [tracks]);

  // Library songs only: streamed recommendations are not part of it.
  const library = useMemo(() => Object.values(tracks).filter((t) => !t.stream), [tracks]);

  const jumpBack = useMemo(() => {
    const seen = new Set<string>();
    const ids = [currentId, ...history].filter((id): id is string => Boolean(id && tracks[id] && !tracks[id].stream));
    const out: string[] = [];
    for (const id of ids) {
      const album = tracks[id]?.albumId;
      if (album && !seen.has(album)) {
        seen.add(album);
        out.push(album);
      }
    }
    // Pad with your most-played albums.
    const plays = new Map<string, number>();
    for (const t of library) plays.set(t.albumId, (plays.get(t.albumId) ?? 0) + t.plays);
    const byPlays = [...plays].filter(([id]) => albums[id]).map(([id, n]) => ({ id, plays: n })).sort((a, b) => b.plays - a.plays);
    for (const a of byPlays) if (!seen.has(a.id) && out.length < 12) {
      seen.add(a.id);
      out.push(a.id);
    }
    return out;
  }, [history, currentId, tracks, albums, library]);

  const topArtists = useMemo(() => {
    const plays: Record<string, number> = {};
    for (const t of library) plays[t.artistId] = (plays[t.artistId] ?? 0) + t.plays;
    return Object.keys(plays).filter((id) => artists[id] && id !== "ar_local").sort((a, b) => plays[b] - plays[a]).slice(0, 10);
  }, [library, artists]);

  const quick = playlists.slice(0, 6);
  const albumTracks = (albumId: string) => library.filter((t) => t.albumId === albumId && isPlayable(t)).map((t) => t.id);

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

      {!recent.length ? (
        <section className="panel home-empty">
          <div>
            <strong>Your library is empty</strong>
            <p className="muted">Import songs or a whole playlist from Spotify, YouTube or SoundCloud, or drop audio files anywhere. Recommendations follow what you bring in.</p>
          </div>
          <button type="button" className="btn primary" onClick={() => openModal({ type: "import" })}>
            <Icon name="download" size={18} />
            Import from Web
          </button>
        </section>
      ) : null}

      {includeLibrary ? (
        <Shelf
          title="Recommended for you"
          subtitle={personal ? "From your likes, playlists and what you actually listen to" : "A starting mix from your library. Like, save and play songs to shape it."}
          action={<button type="button" className="text-btn" disabled={!forYouIds.length} onClick={() => playList(forYouIds, forYouIds[0], { label: "Recommended for you", route: { name: "home" }, picks: forYouPicks })}>Play all</button>}
        >
          {forYou.map(({ id, reason, kind }) => {
            const t = tracks[id];
            const context = { label: "Recommended for you", route: { name: "home" } as Route, ids: forYouIds };
            return (
              <div key={id} className={`card rec-card${currentId === id ? " current" : ""}`} onContextMenu={(e) => openTrackMenu(e, [id], { context, why: kind })}>
                <div className="card-art">
                  <TrackArt trackId={id} />
                  <button
                    type="button"
                    className="play-fab md card-fab"
                    aria-label={currentId === id && isPlaying ? `Pause ${t.title}` : `Play ${t.title}`}
                    onClick={() => (currentId === id ? togglePlay() : playList(forYouIds, id, { ...context, picks: forYouPicks }))}
                  >
                    <Icon name={currentId === id && isPlaying ? "pause" : "play"} size={20} />
                  </button>
                  <button type="button" className="icon-btn rec-dismiss" aria-label={`Not interested in ${t.title}`} title="Not interested" onClick={() => hideRecommendation(id, kind)}>
                    <Icon name="close" size={16} />
                  </button>
                </div>
                <button type="button" className="card-link" onClick={() => navigate({ name: "album", id: t.albumId })}>
                  <strong>{t.title}</strong>
                  <span>{artists[t.artistId]?.name}</span>
                </button>
                <p className="rec-reason">{reason}</p>
              </div>
            );
          })}
          {!forYou.length ? <p className="muted shelf-empty">Nothing to suggest yet. Add songs, or bring back hidden ones in Settings → General.</p> : null}
        </Shelf>
      ) : (
        <DiscoveryShelf title="Recommended for you" subtitle="New songs picked from what you play, none of them in your library yet. Play any of them in full, or add it to your library." />
      )}

      {includeLibrary ? <DiscoveryShelf /> : null}

      <Shelf title="Made for you" subtitle="Daily and weekly editions, kept across visits">
        {mixes.map((mix) => <Card key={mix.id} art={<Art palette={paletteFromSeed(mixSeed(mix))} glyph={mix.kind === "weekly" ? 5 : 2} />} title={mix.name} subtitle={mix.description} onOpen={() => navigate({ name: "mix", id: mix.id })} />)}
      </Shelf>

      {jumpBack.length ? (
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
      ) : null}

      {recent.length ? (
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
      ) : null}

      {topArtists.length ? (
      <Shelf title="Your top artists" subtitle="Based on your plays">
        {topArtists.map((id) => {
          const a = artists[id];
          const ids = Object.values(tracks).filter((t) => t.artistId === id && isPlayable(t)).sort((x, y) => y.plays - x.plays).map((t) => t.id);
          return (
            <Card
              key={id}
              round
              art={<Art palette={a.palette} glyph={4} round label={a.name} image={a.image} />}
              title={a.name}
              subtitle={`Artist · ${plural(ids.length, "song")}`}
              onOpen={() => navigate({ name: "artist", id })}
              play={{ ids, label: a.name, route: { name: "artist", id } }}
            />
          );
        })}
      </Shelf>
      ) : null}
    </div>
  );
}
