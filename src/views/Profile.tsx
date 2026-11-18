import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Art, PlaylistArt } from "../components/Artwork";
import { Hero } from "../components/Hero";
import { Icon } from "../components/Icon";
import { Card, Shelf, SkeletonCards } from "../components/Shelf";
import { TrackList } from "../components/TrackList";
import { hashString, paletteFromSeed } from "../data/library";
import { useCoverPalette } from "../lib/art-colors";
import { creditsArtist } from "../lib/credits";
import { plural } from "../lib/format";
import { menuPosition } from "../lib/menus";
import { isPlayable, navigate, openModal } from "../state/actions";
import { useAccount } from "../state/cloud";
import { copyText, friendPlaylists, openShared, refreshSocial, useSocial, useSocialError, type Friend, type Person, type SharedSummary } from "../state/social";
import { useStore, type Route } from "../state/store";
import { Empty } from "./Collection";
import { Avatar, friendMenu, ListenAlong, NeedsAccount, NowCard, personPalette, playFriendSong, SharedCard, since } from "./Friends";

/*
 * Profiles: yours, and each friend's (the online service only shows a person
 * to their friends). A friend's has what they're playing and the playlists
 * they show on their profile; yours adds what only you see: your top artists
 * and songs this month.
 */

const MONTH = 30 * 24 * 60 * 60_000;

/** The big round header, coloured like `cover` (what they're playing, say), or like their generated picture. */
function ProfileHero({ person, cover, meta }: { person: Person; cover?: string; meta: ReactNode }) {
  const fallback = useMemo(() => personPalette(person), [person.id]);
  const palette = useCoverPalette(cover, fallback) ?? fallback;
  return <Hero round art={<Avatar person={person} className="profile-avatar" />} kind="Profile" title={person.displayName} tint={palette.b} meta={meta} />;
}

function Section({ title, subtitle, children }: { title: string; subtitle?: string; children: ReactNode }) {
  return (
    <section className="profile-section">
      <header className="profile-section-head">
        <h2 className="section-title">{title}</h2>
        {subtitle ? <p className="muted small">{subtitle}</p> : null}
      </header>
      {children}
    </section>
  );
}

export function ProfileView({ id }: { id?: string }) {
  const account = useAccount();
  const social = useSocial();
  const socialError = useSocialError();

  useEffect(() => {
    void refreshSocial();
  }, []);

  if (account.status !== "signedIn") return <NeedsAccount what="friends" />;
  if (!id || id === account.userId) return <MyProfile error={socialError} />;
  if (!social) {
    return (
      <div className="view">
        {socialError ? (
          <Empty icon="user" title="Couldn't load this profile" body={socialError} action={<button type="button" className="btn" onClick={() => void refreshSocial()}>Try again</button>} />
        ) : <p className="muted metadata-loading"><span className="spinner" />Loading their profile…</p>}
      </div>
    );
  }
  const friend = social.friends.find((f) => f.id === id);
  if (!friend) {
    return (
      <div className="view">
        <Empty icon="user" title="This profile isn't available" body="You can only see the profiles of people on your Friends list." action={<button type="button" className="btn" onClick={() => navigate({ name: "friends" })}>Go to Friends</button>} />
      </div>
    );
  }
  return <FriendProfile friend={friend} />;
}

/* ───────────────────────── a friend's ───────────────────────── */

function FriendProfile({ friend }: { friend: Friend }) {
  const [playlists, setPlaylists] = useState<SharedSummary[] | null>(null);
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);
  const a = friend.activity;
  const route: Route = { name: "profile", id: friend.id };

  // Loaded again every 30 seconds while the window has focus, so changes they make show; what's shown stays meanwhile.
  useEffect(() => {
    let live = true;
    // Once they have loaded, a later failure leaves them showing.
    let loaded = false;
    const load = () => friendPlaylists(friend.id).then(
      (p) => {
        if (!live) return;
        loaded = true;
        setError("");
        setPlaylists((old) => (old && JSON.stringify(old) === JSON.stringify(p) ? old : p));
      },
      (e: unknown) => live && !loaded && setError(e instanceof Error ? e.message : "Couldn't load their playlists."),
    );
    void load();
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible" && document.hasFocus()) void load();
    }, 30_000);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [friend.id, attempt]);

  const meta = (
    <>
      {friend.username ? <span>@{friend.username}</span> : null}
      <span>Friends since {since(friend.since, "short")}</span>
      {playlists?.length ? <span className="profile-count">{plural(playlists.length, "public playlist")}</span> : null}
    </>
  );

  return (
    <div className="view profile-view">
      <ProfileHero person={friend} cover={a?.song?.artworkUrl ?? undefined} meta={meta} />
      <div className="action-bar profile-actions">
        {a?.roomCode ? (
          <ListenAlong code={a.roomCode} who={friend.displayName} className="btn primary profile-cta" />
        ) : a?.song?.sourceURL ? (
          <button type="button" className="btn primary profile-cta" onClick={() => playFriendSong(friend, route)}><Icon name="play" size={17} />Play their song</button>
        ) : null}
        <button type="button" className="icon-btn lg" onClick={(e) => friendMenu(friend, menuPosition(e.currentTarget), { onProfile: true })} aria-label={`More options for ${friend.displayName}`} aria-haspopup="menu" title="More">
          <Icon name="more" size={24} />
        </button>
      </div>

      {a?.song ? (
        <Section title={a.playing ? "Listening now" : "Last played"}>
          <ul className="now-grid profile-now"><NowCard friend={friend} index={0} onProfile /></ul>
        </Section>
      ) : null}

      {error ? (
        <Section title="Public playlists">
          <p className="profile-quiet"><Icon name="sync" size={16} /><span>{error} <button type="button" className="text-btn" onClick={() => { setError(""); setAttempt((n) => n + 1); }}>Try again</button></span></p>
        </Section>
      ) : !playlists ? (
        <Shelf title="Public playlists" grid><SkeletonCards count={2} label="Loading their playlists" /></Shelf>
      ) : playlists.length ? (
        <Shelf title="Public playlists" grid>
          {playlists.map((p) => <SharedCard key={p.shareId} summary={p} subtitle={plural(p.songCount, "song")} />)}
        </Shelf>
      ) : (
        <Section title="Public playlists">
          <p className="profile-quiet"><Icon name="playlists" size={16} /><span>{friend.displayName} hasn't put any playlists on their profile yet.</span></p>
        </Section>
      )}
    </div>
  );
}

/* ───────────────────────── yours ───────────────────────── */

/** Your most played artists and songs in the last 30 days, from the listening history. */
function useMonthTops() {
  const listens = useStore((s) => s.taste.listens);
  const tracks = useStore((s) => s.tracks);
  const artists = useStore((s) => s.artists);
  return useMemo(() => {
    const from = Date.now() - MONTH;
    const songs = new Map<string, number>();
    const byArtist = new Map<string, number>();
    for (const l of listens) {
      if (l.at < from) continue;
      const t = tracks[l.trackId];
      if (!t) continue;
      songs.set(t.id, (songs.get(t.id) ?? 0) + 1);
      if (t.artistId !== "ar_local" && artists[t.artistId]) byArtist.set(t.artistId, (byArtist.get(t.artistId) ?? 0) + 1);
    }
    const top = (m: Map<string, number>, n: number) => [...m].sort((x, y) => y[1] - x[1]).slice(0, n).map(([id]) => id);
    return { artists: top(byArtist, 10), songs: top(songs, 5) };
  }, [listens, tracks, artists]);
}

function MyProfile({ error }: { error: string }) {
  const [retrying, setRetrying] = useState(false);
  const retry = () => {
    setRetrying(true);
    void refreshSocial().finally(() => setRetrying(false));
  };
  const account = useAccount();
  const social = useSocial();
  const playlists = useStore((s) => s.playlists);
  const tracks = useStore((s) => s.tracks);
  const artists = useStore((s) => s.artists);
  const localName = useStore((s) => s.settings.profileName);
  const tops = useMonthTops();
  // Each top artist's playable songs, most played first (for the cards' play buttons).
  const artistSongs = useMemo(() => {
    const out: Record<string, string[]> = {};
    const all = Object.values(tracks).filter((t) => isPlayable(t)).sort((x, y) => y.plays - x.plays);
    for (const id of tops.artists) out[id] = all.filter((t) => creditsArtist(t, id)).map((t) => t.id);
    return out;
  }, [tracks, tops.artists]);
  const profile = account.profile;
  const me: Person = { id: account.userId ?? "me", displayName: profile?.displayName ?? (localName || "You"), avatarUrl: profile?.avatarUrl ?? null, username: profile?.username };
  const route: Route = { name: "profile" };

  // The playlists your friends see on your profile, with yours here (one shared from another device may not have synced yet).
  const shown = useMemo(
    () => (social?.shared ?? []).filter((s) => s.onProfile).map((s) => ({ shareId: s.shareId, playlist: playlists.find((p) => p.id === s.playlistId) })),
    [social?.shared, playlists],
  );
  // Those listening now first, then by name (as on Friends).
  const friends = useMemo(
    () => (social ? [...social.friends].sort((x, y) => Number(Boolean(y.activity?.playing)) - Number(Boolean(x.activity?.playing)) || x.displayName.localeCompare(y.displayName)) : null),
    [social],
  );
  const lead = tops.artists[0] ? artists[tops.artists[0]] : undefined;

  const meta = (
    <>
      {me.username ? <span>@{me.username}</span> : null}
      {friends?.length ? <span>{plural(friends.length, "friend")}</span> : null}
      {shown.length ? <span className="profile-count">{plural(shown.length, "public playlist")}</span> : null}
    </>
  );

  return (
    <div className="view profile-view">
      <ProfileHero person={me} cover={lead?.image} meta={meta} />
      <div className="action-bar profile-actions">
        <button type="button" className="btn" onClick={() => openModal({ type: "settings", tab: "account" })}><Icon name="edit" size={16} />Edit profile</button>
        {profile?.friendCode ? (
          <button type="button" className="btn" onClick={() => void copyText(profile.friendCode!, "Friend code")}><Icon name="copy" size={16} />Copy friend code</button>
        ) : null}
      </div>
      {profile?.shareActivity === false ? (
        <p className="profile-note"><Icon name="volumeMute" size={15} />Friends can't see what you're playing. <button type="button" className="text-btn" onClick={() => openModal({ type: "settings", tab: "account" })}>Change in Settings</button></p>
      ) : null}

      {tops.artists.length ? (
        <Shelf title="Top artists this month" subtitle="Only visible to you">
          {tops.artists.map((id) => {
            const artist = artists[id];
            const ids = artistSongs[id] ?? [];
            return (
              <Card
                key={id}
                round
                art={<Art palette={artist.palette} glyph={4} round label={artist.name} image={artist.image} />}
                title={artist.name}
                subtitle="Artist"
                onOpen={() => navigate({ name: "artist", id })}
                play={{ ids, label: artist.name, route: { name: "artist", id } }}
              />
            );
          })}
        </Shelf>
      ) : null}

      {tops.songs.length ? (
        <Section title="Top songs this month" subtitle="Only visible to you">
          <TrackList ids={tops.songs} context={{ label: "Your top songs this month", route }} sortable={false} reorderable={false} showAdded={false} />
        </Section>
      ) : null}

      {!social && error ? (
        <Section title="Public playlists and friends">
          <p className="profile-quiet"><Icon name="sync" size={16} /><span>Couldn't load them: {error} <button type="button" className="text-btn" disabled={retrying} onClick={retry}>{retrying ? "Trying…" : "Try again"}</button></span></p>
        </Section>
      ) : !social ? (
        <Shelf title="Public playlists" subtitle="Your friends see these on your profile" grid><SkeletonCards count={2} label="Loading your playlists" /></Shelf>
      ) : shown.length ? (
        <Shelf title="Public playlists" subtitle="Your friends see these on your profile" grid>
          {shown.map(({ shareId, playlist: p }) => p ? (
            <Card key={shareId} art={<PlaylistArt playlist={p} />} title={p.name} subtitle={plural(p.trackIds.length, "song")} onOpen={() => navigate({ name: "playlist", id: p.id })} play={{ ids: p.trackIds, label: p.name, route: { name: "playlist", id: p.id } }} />
          ) : (
            <Card key={shareId} art={<Art palette={paletteFromSeed(hashString(shareId))} icon="playlists" />} title="Shared playlist" subtitle="Not on this device yet" onOpen={() => openShared(shareId)} />
          ))}
        </Shelf>
      ) : (
        <Section title="Public playlists">
          <p className="profile-quiet"><Icon name="playlists" size={16} /><span>Share a playlist and leave “Show on my profile” on, and your friends will find it here.</span></p>
        </Section>
      )}

      {friends?.length ? (
        <Shelf title="Friends" onShowAll={() => navigate({ name: "friends" })}>
          {friends.map((f) => (
            <Card key={f.id} round art={<Avatar person={f} className="card-person" />} title={f.displayName} subtitle={f.activity?.playing ? "Listening now" : "Friend"} onOpen={() => navigate({ name: "profile", id: f.id })} />
          ))}
        </Shelf>
      ) : friends ? (
        <Section title="Friends">
          <p className="profile-quiet"><Icon name="users" size={16} /><span>No friends yet. <button type="button" className="text-btn" onClick={() => navigate({ name: "friends" })}>Add friends</button></span></p>
        </Section>
      ) : null}
    </div>
  );
}
