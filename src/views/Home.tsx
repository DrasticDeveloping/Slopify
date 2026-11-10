import { creditLine, creditsArtist } from "../lib/credits";
import { useEffect, useMemo, type CSSProperties, type MouseEvent, type ReactNode } from "react";
import { ensureMixes, mixIds, mixSeed, mixSongs, useMixes, type Mix } from "../recommend/mixes";
import { registerStreams } from "../state/importer";
import { featuring, MixArt, MixCard, useMixFaces } from "../components/MixArt";
import { paletteFromSeed } from "../data/library";
import { Art, BlurredTrackArt, PlaylistArt, TrackArt } from "../components/Artwork";
import { Bars, Icon } from "../components/Icon";
import { ChooseFiles } from "../components/ChooseFiles";
import { DiscoveryShelf } from "../components/DiscoveryShelf";
import { ReleaseShelves } from "../components/ReleaseShelves";
import { Card, PlayFab, Shelf, useContextPlaying } from "../components/Shelf";
import { greeting, plural } from "../lib/format";
import { useMediaQuery } from "../lib/hooks";
import { openPlaylistMenu, openTrackMenu } from "../lib/menus";
import { hasTaste } from "../recommend/rank";
import { findMusic, hideRecommendation, isPlayable, libraryIds, navigate, playList, recommendations, togglePlay } from "../state/actions";
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

/**
 * The top of Home: this week's featured mix, big and made of its own music, ready to play,
 * beside an album to jump back into. (What's playing already has the player bar and the Now Playing panel.)
 */
function FeaturedMix({ mix }: { mix: Mix }) {
  const tracks = useStore((s) => s.tracks);
  const tasteRev = useStore((s) => s.taste.rev);
  const route: Route = { name: "mix", id: mix.id };
  const state = useContextPlaying(route);
  const { names } = useMixFaces(mix);
  const ids = useMemo(() => mixIds(mix).filter((id) => tracks[id]), [mix, tracks, tasteRev]);
  const palette = paletteFromSeed(mixSeed(mix));
  const albums = useStore((s) => s.albums);
  const washId = mix.libraryIds.find((id) => tracks[id] && albums[tracks[id].albumId]?.artworkUrl);
  const open = () => navigate(route);
  return (
    <div className="spot-feature" style={{ "--a": palette.a, "--b": palette.b, "--c": palette.c } as CSSProperties}>
      {washId ? <BlurredTrackArt trackId={washId} className="spot-wash" /> : null}
      <button type="button" className="spot-art" onClick={open} aria-label={`Open ${mix.name}`}>
        <MixArt mix={mix} bare />
      </button>
      <div className="spot-copy">
        <span className="spot-eyebrow">{state.playing ? <><Bars /> Playing</> : "Made for you"}</span>
        <h2 className="spot-title">
          <button type="button" className="link" onClick={open}>{mix.name}</button>
        </h2>
        <span className="spot-artist">{names.length ? `Featuring ${featuring(names)}` : mix.description}</span>
        <div className="spot-actions">
          <button
            type="button"
            className={`spot-play${state.playing ? " is-playing" : ""}`}
            disabled={!ids.length}
            onClick={() => (state.active ? togglePlay() : playList(ids, ids[0], { label: mix.name, route }))}
            aria-label={state.playing ? `Pause ${mix.name}` : `Play ${mix.name}`}
          >
            <Icon name={state.playing ? "pause" : "play"} size={22} />
            <span>{state.playing ? "Pause" : "Play"}</span>
          </button>
          <button type="button" className="spot-context" onClick={open}>{ids.length ? plural(ids.length, "song") : "Open mix"}</button>
        </div>
      </div>
    </div>
  );
}

/** An album from your recent listening, full-bleed, to pick up again. */
function JumpBack({ albumId, ids }: { albumId: string; ids: string[] }) {
  const album = useStore((s) => s.albums[albumId]);
  const artist = useStore((s) => (album ? s.artists[album.artistId] : undefined));
  if (!album) return null;
  const route: Route = { name: "album", id: albumId };
  return (
    <div className="spot-jump">
      <Art palette={album.palette} glyph={album.glyph} image={album.artworkUrl} />
      <button type="button" className="spot-jump-copy" onClick={() => navigate(route)}>
        <span className="spot-eyebrow">Jump back in</span>
        <strong>{album.title}</strong>
        <span>{artist?.name}</span>
      </button>
      <PlayFab ids={ids} label={album.title} route={route} className="spot-jump-fab" />
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
  const touch = useMediaQuery("(hover: none) and (pointer: coarse)");
  // Only changes that can move suggestions (not every listening progress save) re-rank the shelves.
  const tasteRev = useStore((s) => s.taste.rev);
  // Library and taste changes can make a new mix (App's minute timer catches midnight and Monday).
  useEffect(() => ensureMixes(), [tasteRev, tracks]);
  // Every mix's new songs become tracks the player knows, as on a mix's own page, so the featured card
  // and the mix shortcuts play the whole mix (not just its library songs).
  useEffect(() => {
    for (const mix of mixes) registerStreams(mixSongs(mix));
  }, [mixes]);

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

  const featured = mixes.find((m) => m.kind === "weekly") ?? mixes[0];
  // Not the album that's playing: that's already in the player bar (and the Now Playing panel).
  const playingAlbum = currentId ? tracks[currentId]?.albumId : undefined;
  const spotAlbum = jumpBack.find((albumId) => albumId !== playingAlbum) ?? jumpBack[0];
  const albumTracks = (albumId: string) => library.filter((t) => t.albumId === albumId && isPlayable(t)).map((t) => t.id);

  return (
    <div className="view home">
      <div className="home-glow" aria-hidden="true" />
      <h1 className="greeting">
        {greeting()}
        {name && <>, <span className="grad-text">{name}</span></>}
      </h1>
      {featured || spotAlbum ? (
        <section className={`spotlight${featured && spotAlbum ? "" : " solo"}`} aria-label="Spotlight">
          {featured ? <FeaturedMix mix={featured} /> : null}
          {spotAlbum ? <JumpBack albumId={spotAlbum} ids={albumTracks(spotAlbum)} /> : null}
        </section>
      ) : null}
      <div className="quick-grid">
        {[
          ...playlists.filter((p) => p.trackIds.length).map((p) => <QuickTile key={p.id} title={p.name} art={<PlaylistArt playlist={p} />} route={{ name: "playlist", id: p.id }} ids={p.trackIds} onMenu={(e) => openPlaylistMenu(e, p.id)} />),
          ...jumpBack.filter((albumId) => albumId !== spotAlbum).map((albumId) => {
            const a = albums[albumId];
            return <QuickTile key={albumId} title={a.title} art={<Art palette={a.palette} glyph={a.glyph} image={a.artworkUrl} />} route={{ name: "album", id: albumId }} ids={albumTracks(albumId)} />;
          }),
          ...mixes.filter((m) => m !== featured).map((m) => <QuickTile key={m.id} title={m.name} art={<MixArt mix={m} bare />} route={{ name: "mix", id: m.id }} ids={mixIds(m).filter((id) => tracks[id])} />),
        ].slice(0, 8)}
      </div>

      {!recent.length ? (
        <section className="panel home-empty" aria-labelledby="home-empty-title">
          <div>
            <strong id="home-empty-title">Start with some music</strong>
            <ul className="home-steps">
              <li><strong>Search</strong> YouTube, Spotify and SoundCloud, or <strong>paste a link</strong> to a song or a whole playlist.</li>
              <li><strong>Play</strong> streams a song right away; <strong>Save</strong> keeps it in your library, on every device you sign in on.</li>
              <li>Files from this device play until you reload{touch ? "" : " (or drop them anywhere on the window)"}.</li>
              <li>Likes, saves and what you listen to shape your recommendations here.</li>
            </ul>
          </div>
          <div className="home-empty-actions">
            <button type="button" className="btn primary" onClick={() => findMusic()}>
              <Icon name="search" size={18} />
              Find music
            </button>
            <ChooseFiles />
          </div>
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
                  <span>{creditLine(t, artists)}</span>
                </button>
                <p className="rec-reason">{reason}</p>
              </div>
            );
          })}
          {!forYou.length ? <p className="muted shelf-empty">Nothing to suggest yet. Add songs, or bring back hidden ones in Settings → Recommendations.</p> : null}
        </Shelf>
      ) : (
        <DiscoveryShelf title="Recommended for you" subtitle="New songs picked from what you play, none of them in your library yet. Play any of them in full, or add it to your library." />
      )}

      {includeLibrary ? <DiscoveryShelf /> : null}

      {recent.length ? <ReleaseShelves /> : null}

      <Shelf title="Made for you" subtitle="Daily and weekly editions, kept across visits">
        {mixes.map((mix) => <MixCard key={mix.id} mix={mix} />)}
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
                <span>{creditLine(t, artists)}</span>
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
          const ids = Object.values(tracks).filter((t) => creditsArtist(t, id) && isPlayable(t)).sort((x, y) => y.plays - x.plays).map((t) => t.id);
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
