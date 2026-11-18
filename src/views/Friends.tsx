import { useEffect, useMemo, useState, type CSSProperties, type ReactNode } from "react";
import { Art } from "../components/Artwork";
import { Hero } from "../components/Hero";
import { Bars, Icon } from "../components/Icon";
import { Card, PlayFab, Shelf } from "../components/Shelf";
import { TrackList } from "../components/TrackList";
import { hashString, paletteFromSeed } from "../data/library";
import type { Palette } from "../data/types";
import { useCoverPalette } from "../lib/art-colors";
import { formatLongDuration, plural } from "../lib/format";
import { menuPosition } from "../lib/menus";
import { navigate, openMenu, openModal, playList, ask } from "../state/actions";
import { cloudEnabled, signIn, useAccount } from "../state/cloud";
import { joinRoom } from "../state/listen";
import {
  acceptFriend, addFriend, copyText, dismissInbox, dropRequest, followShared, loadShared, openShared, refreshSocial, removeFriend, saveSharedCopy,
  sharedError, shareLink, trackForSong, useSocial, useSocialError, type Friend, type Person, type SharedPlaylist, type SharedSummary,
} from "../state/social";
import { getState, useStore, type Route } from "../state/store";
import { Empty } from "./Collection";

export const personPalette = (p: Person) => paletteFromSeed(hashString(p.id));
const sharedPalette = (shareId: string) => paletteFromSeed(hashString(shareId));
export const ago = (at: number) => {
  const minutes = Math.round((Date.now() - at) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  return hours < 24 ? `${hours} h ago` : plural(Math.round(hours / 24), "day") + " ago";
};
const capital = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);
export const since = (at: number, month: "long" | "short" = "long") => new Date(at).toLocaleDateString([], { month, year: "numeric" });

export function Avatar({ person, className = "person-art" }: { person: Person; className?: string }) {
  return <Art palette={personPalette(person)} round className={className} image={person.avatarUrl ?? undefined} label={person.displayName} />;
}

function Name({ person }: { person: Person }) {
  return <>{person.displayName}{person.username ? <span className="muted handle"> @{person.username}</span> : null}</>;
}

/** Signed out, or no online service: what this page would show, and one way in. While the account loads it says that instead. */
export function NeedsAccount({ what }: { what: "friends" | "shared" }) {
  const account = useAccount();
  if (account.status === "loading") return <div className="view"><p className="muted metadata-loading"><span className="spinner" />Connecting to your account…</p></div>;
  const shared = what === "shared";
  return (
    <div className="view">
      <section className="social-intro">
        <div className="listen-hero" aria-hidden="true">
          <span className="listen-orbit">
            <i style={{ "--h": 268 } as CSSProperties} />
            <i style={{ "--h": 330 } as CSSProperties} />
            <i style={{ "--h": 190 } as CSSProperties} />
          </span>
          <span className="listen-wave"><Icon name={shared ? "playlists" : "users"} size={24} /></span>
        </div>
        <span className="eyebrow">{shared ? "Shared playlist" : "Friends"}</span>
        <h1>{shared ? "Sign in to open this playlist" : "Music is better together"}</h1>
        <p className="muted">{shared ? "Someone shared a playlist with you. Sign in to play it, follow it, or save your own copy." : "See what your friends are playing, share playlists, and listen along in real time."}</p>
        <ul className="feature-rows">
          {shared ? (
            <>
              <li><span className="feature-icon"><Icon name="play" size={17} /></span><span><strong>Play it in full</strong><small>Every song that was saved from the web.</small></span></li>
              <li><span className="feature-icon"><Icon name="sync" size={17} /></span><span><strong>Follow it</strong><small>It stays up to date as they change it.</small></span></li>
            </>
          ) : (
            <>
              <li><span className="feature-icon"><Icon name="radio" size={17} /></span><span><strong>See what they're playing</strong><small>Live, with a tap to listen along.</small></span></li>
              <li><span className="feature-icon"><Icon name="link" size={17} /></span><span><strong>Share playlists</strong><small>Send them, or show them on your profile.</small></span></li>
              <li><span className="feature-icon"><Icon name="users" size={17} /></span><span><strong>Add friends by name</strong><small>From their Slopify username.</small></span></li>
            </>
          )}
        </ul>
        {cloudEnabled ? (
          <button type="button" className="btn primary wide social-cta" onClick={signIn}><Icon name="user" size={17} />Sign in</button>
        ) : <p className="muted small">This needs Slopify's online service, which this copy of Slopify isn't set up with.</p>}
      </section>
    </div>
  );
}

export function SharedCard({ summary, subtitle, onDismiss }: { summary: SharedSummary; subtitle: string; onDismiss?: () => void }) {
  return (
    <div className="shared-card-wrap">
      <Card
        art={<Art palette={sharedPalette(summary.shareId)} image={summary.artworkUrl ?? undefined} icon="playlists" />}
        title={summary.name}
        subtitle={subtitle}
        onOpen={() => openShared(summary.shareId)}
      />
      {onDismiss ? (
        <button type="button" className="icon-btn sm round shared-dismiss" onClick={onDismiss} aria-label={`Dismiss ${summary.name}`} title="Dismiss">
          <Icon name="close" size={14} />
        </button>
      ) : null}
    </div>
  );
}

/* ───────────────────────── what friends are playing ───────────────────────── */

/** Plays the song a friend is on: your own copy if you have it, otherwise streamed from its link. */
export function playFriendSong(friend: Friend, route: Route = { name: "friends" }) {
  const song = friend.activity?.song;
  if (!song?.sourceURL) return;
  const id = trackForSong({ title: song.title, artist: song.artist, album: null, sourceURL: song.sourceURL, savedAs: "audio", durationSeconds: null, artworkUrl: song.artworkUrl });
  playList([id], id, { label: `${friend.displayName} is listening`, route });
}

export function ListenAlong({ code, who, className = "btn sm primary" }: { code: string; who: string; className?: string }) {
  const listen = useStore((s) => s.listen.mode);
  return (
    <button type="button" className={className} disabled={listen !== "idle"} onClick={() => void joinRoom(code)} aria-label={`Listen along with ${who}`} title={listen !== "idle" ? "Leave your current room first" : undefined}>
      <span className="live-dot" /><span className="la-long">Listen along</span><span className="la-short">Join</span>
    </button>
  );
}

/** A friend who's on a song right now (or paused on one): its cover, coloured like it, and a way in. */
/** `onProfile`: on their own profile, which already names them and has Listen along as its main button. */
export function NowCard({ friend, index, onProfile = false }: { friend: Friend; index: number; onProfile?: boolean }) {
  const route: Route = onProfile ? { name: "profile", id: friend.id } : { name: "friends" };
  const a = friend.activity!;
  const song = a.song!;
  const fallback = useMemo(() => personPalette(friend), [friend.id]);
  const palette = useCoverPalette(song.artworkUrl ?? undefined, fallback) ?? fallback;
  const status = a.roomCode ? "Hosting a room" : a.playing ? "Playing now" : `Paused · ${ago(a.at)}`;
  return (
    <li className={`now-card${a.playing ? " playing" : " paused"}`} style={{ "--na": palette.a, "--nb": palette.b, "--nc": palette.c, "--i": Math.min(index, 8) } as CSSProperties}>
      <div className="now-cover">
        <Art palette={palette} image={song.artworkUrl ?? undefined} icon="music" />
        {song.sourceURL ? (
          <button type="button" className="now-play" onClick={() => playFriendSong(friend, route)} aria-label={`Play ${song.title} by ${song.artist}`} title="Play this song">
            <Icon name="play" size={20} />
          </button>
        ) : null}
      </div>
      <div className="now-copy">
        {onProfile ? null : (
          <button type="button" className="now-who" onClick={() => navigate({ name: "profile", id: friend.id })} title={`Open ${friend.displayName}’s profile`}>
            <Avatar person={friend} className="now-avatar" />
            <strong>{friend.displayName}</strong>
          </button>
        )}
        <strong className="now-title" title={song.title}>{song.title}</strong>
        <span className="now-artist" title={song.artist}>{song.artist}</span>
        <span className="now-status">
          {a.roomCode ? <span className="live-dot" /> : a.playing ? <Bars /> : <Icon name="pause" size={12} />}
          {status}
        </span>
      </div>
      {a.roomCode && !onProfile ? <ListenAlong code={a.roomCode} who={friend.displayName} className="btn sm primary now-join" /> : null}
    </li>
  );
}

/* ───────────────────────── your friends ───────────────────────── */

function FriendStatus({ friend }: { friend: Friend }) {
  const a = friend.activity;
  if (!a?.song) return <small>{a ? "Not playing anything" : "Not listening right now"}</small>;
  return (
    <small className={a.playing ? "accent" : undefined}>
      {a.playing ? <Bars /> : null}
      <span className="friend-song">{a.playing ? "" : "Paused · "}{a.song.title} · {a.song.artist}{a.playing ? "" : ` · ${ago(a.at)}`}</span>
    </small>
  );
}

/** Asks first, then removes them; once that worked, runs `then` (say, to leave their profile). */
export function confirmRemoveFriend(friend: Friend, then?: () => void) {
  void ask({ title: `Remove ${friend.displayName}?`, body: "You'll stop seeing each other's shared playlists and listening. You can add each other again later.", confirmLabel: "Remove friend", danger: true, icon: "users" })
    .then(async (ok) => {
      if (ok && (await removeFriend(friend))) then?.();
    });
}

/** A friend's menu: from their row (with "Open profile") or their profile page. */
export function friendMenu(friend: Friend, at: { x: number; y: number }, { onProfile = false } = {}) {
  const a = friend.activity;
  const listen = getState().listen.mode;
  const route: Route = onProfile ? { name: "profile", id: friend.id } : { name: "friends" };
  openMenu({
    ...at,
    title: friend.displayName,
    subtitle: friend.username ? `@${friend.username} · Friends since ${since(friend.since)}` : `Friends since ${since(friend.since)}`,
    art: { palette: personPalette(friend), image: friend.avatarUrl ?? undefined, round: true },
    items: [
      ...(onProfile ? [] : [{ label: "Open profile", icon: "user", run: () => navigate({ name: "profile", id: friend.id }) }]),
      ...(a?.roomCode ? [{ label: "Listen along", icon: "radio", disabled: listen !== "idle", run: () => void joinRoom(a.roomCode!) }] : []),
      ...(a?.song?.sourceURL ? [{ label: `Play “${a.song.title}”`, icon: "play", run: () => playFriendSong(friend, route) }] : []),
      ...(friend.username ? [{ label: "Copy username", icon: "copy", run: () => void copyText(`@${friend.username}`, "Username") }] : []),
      { separator: true },
      { label: "Remove friend…", icon: "trash", danger: true, run: () => confirmRemoveFriend(friend, onProfile ? () => { const r = getState().route; if (r.name === "profile" && r.id === friend.id) navigate({ name: "friends" }); } : undefined) },
    ],
  });
}

function FriendRow({ friend, index }: { friend: Friend; index: number }) {
  const a = friend.activity;
  const live = Boolean(a?.playing);
  const showMenu = (at: { x: number; y: number }) => friendMenu(friend, at);

  return (
    <li className={`friend${live ? " live" : ""}`} style={{ "--i": Math.min(index, 12) } as CSSProperties}>
      <div className="friend-main" onContextMenu={(e) => { e.preventDefault(); showMenu(menuPosition(e)); }}>
        <button type="button" className="friend-toggle" onClick={() => navigate({ name: "profile", id: friend.id })} title={`Open ${friend.displayName}’s profile`}>
          <span className="friend-avatar">
            <Avatar person={friend} />
            {live ? <span className="friend-badge" aria-hidden="true"><Icon name="volume" size={10} /></span> : null}
          </span>
          <span className="friend-copy">
            <strong><Name person={friend} /></strong>
            <FriendStatus friend={friend} />
          </span>
          <Icon name="chevronRight" size={16} className="friend-chevron" />
        </button>
        <span className="friend-action">
          {a?.roomCode ? (
            <ListenAlong code={a.roomCode} who={friend.displayName} />
          ) : a?.song?.sourceURL ? (
            <button type="button" className="icon-btn friend-play" onClick={() => playFriendSong(friend)} aria-label={`Play ${a.song.title}`} title="Play this song">
              <Icon name="play" size={16} />
            </button>
          ) : null}
        </span>
        <button type="button" className="icon-btn" onClick={(e) => showMenu(menuPosition(e.currentTarget))} aria-label={`More options for ${friend.displayName}`} aria-haspopup="menu" title="More">
          <Icon name="more" size={18} />
        </button>
      </div>
    </li>
  );
}

/* ───────────────────────── the page ───────────────────────── */

/** The page's header, coloured like the cover of what the first friend listening is playing. */
function FriendsHead({ friends, listening, lead }: { friends: Friend[] | null; listening: number; lead: Friend | undefined }) {
  const fallback = useMemo<Palette | undefined>(() => (lead ? personPalette(lead) : undefined), [lead?.id]);
  const tint = useCoverPalette(lead?.activity?.song?.artworkUrl ?? undefined, fallback);
  const faces = friends?.slice(0, 5) ?? [];
  const more = (friends?.length ?? 0) - faces.length;
  return (
    <header className="friends-head" style={tint ? ({ "--ft": tint.b, "--ft2": tint.a } as CSSProperties) : undefined}>
      <div className="friends-head-copy">
        <span className="eyebrow">Your people</span>
        <h1>Friends</h1>
        <p className="friends-count">
          {!friends ? "Loading…" : !friends.length ? "Add your first friend to see what they're playing." : (
            <>
              <span>{plural(friends.length, "friend")}</span>
              {listening ? <span className="friends-live"><span className="live-pip" />{listening} listening now</span> : null}
            </>
          )}
        </p>
      </div>
      <button type="button" className="btn friends-add-jump" onClick={() => { const input = document.getElementById("friend-code"); input?.scrollIntoView({ block: "center", behavior: "smooth" }); input?.focus({ preventScroll: true }); }}>
        <Icon name="plus" size={16} />Add friends
      </button>
      {faces.length ? (
        <div className="facepile" aria-hidden="true">
          {faces.map((f) => (
            <span key={f.id} className={f.activity?.playing ? "live" : undefined}><Avatar person={f} className="face" /></span>
          ))}
          {more > 0 ? <span className="face more">+{more}</span> : null}
        </div>
      ) : null}
    </header>
  );
}

function Section({ title, count, children, className }: { title: string; count?: number; children: ReactNode; className?: string }) {
  return (
    <section className={`friends-section${className ? ` ${className}` : ""}`}>
      <h2 className="section-title">{title}{count ? <span className="muted">{count}</span> : null}</h2>
      {children}
    </section>
  );
}

/** Your code to give out, and a box to add someone by theirs (or their username). */
function AddFriends() {
  const account = useAccount();
  const [code, setCode] = useState("");
  const [adding, setAdding] = useState(false);
  // A friend code (ABCD-2345) or a username (@name).
  const valid = /^[A-Z0-9]{4}-?[A-Z0-9]{4}$/i.test(code.trim()) || /^@?[a-z0-9_][a-z0-9_.]{1,18}[a-z0-9_]$/i.test(code.trim());
  const myCode = account.profile?.friendCode;
  const username = account.profile?.username;
  return (
    <section className="invite-card" aria-labelledby="invite-title">
      <h2 id="invite-title" className="invite-title"><Icon name="users" size={18} />Add friends</h2>
      <form
        className="add-friend"
        onSubmit={(e) => {
          e.preventDefault();
          if (!valid || adding) return;
          setAdding(true);
          void addFriend(code).then((ok) => ok && setCode("")).finally(() => setAdding(false));
        }}
      >
        <label className="mini-head" htmlFor="friend-code">Their friend code or username</label>
        <div className="join-row">
          <input id="friend-code" className="input" value={code} onChange={(e) => setCode(e.target.value)} placeholder="ABCD-2345 or @name" maxLength={24} spellCheck={false} autoComplete="off" aria-describedby="friend-code-help" />
          <button type="submit" className="btn primary" disabled={!valid || adding}>{adding ? <><span className="spinner" />Adding</> : "Add"}</button>
        </div>
        <p id="friend-code-help" className="muted small">They'll get a request to accept.</p>
      </form>
      <div className="my-code">
        <span className="mini-head">Your friend code</span>
        <div className="my-code-row">
          <strong>{myCode ?? "····-····"}</strong>
          <button type="button" className="btn sm" disabled={!myCode} onClick={() => myCode && void copyText(myCode, "Friend code")}><Icon name="copy" size={15} />Copy</button>
        </div>
        <p className="muted small">{username ? <>Or they can add you as <strong className="my-handle">@{username}</strong>.</> : "Give it to friends so they can add you."}</p>
      </div>
    </section>
  );
}

export function FriendsView() {
  const account = useAccount();
  const social = useSocial();
  const socialError = useSocialError();

  useEffect(() => {
    void refreshSocial();
  }, []);

  const friends = social?.friends ?? null;
  // On a song (playing first, then paused), for "Friend activity".
  const onSong = (friends ?? []).filter((f) => f.activity?.song).sort((x, y) => Number(Boolean(y.activity?.playing)) - Number(Boolean(x.activity?.playing)) || (y.activity?.at ?? 0) - (x.activity?.at ?? 0));
  const listening = (friends ?? []).filter((f) => f.activity?.playing).length;
  const lead = onSong.find((f) => f.activity?.playing && f.activity.song?.artworkUrl);

  if (account.status !== "signedIn") return <NeedsAccount what="friends" />;
  if (!social && socialError) {
    return (
      <div className="view">
        <Empty icon="users" title="Couldn't load your friends" body={socialError} action={<button type="button" className="btn" onClick={() => void refreshSocial()}>Try again</button>} />
      </div>
    );
  }

  // Those listening now first, then by name.
  const sorted = [...(friends ?? [])].sort((x, y) => Number(Boolean(y.activity?.playing)) - Number(Boolean(x.activity?.playing)) || x.displayName.localeCompare(y.displayName));

  return (
    <div className="view friends-view">
      <FriendsHead friends={social ? sorted : null} listening={listening} lead={lead} />

      <div className="friends-layout">
        <div className="friends-main">
          {social?.incoming.length ? (
            <section className="requests-card" aria-labelledby="requests-title">
              <h2 id="requests-title" className="requests-title">
                {social.incoming.length === 1 ? "1 friend request" : `${social.incoming.length} friend requests`}
              </h2>
              <ul className="people">
                {social.incoming.map((p, i) => (
                  <li key={p.id} style={{ "--i": i } as CSSProperties}>
                    <Avatar person={p} />
                    <span className="person-copy"><strong><Name person={p} /></strong><small>Wants to be friends · {ago(p.at)}</small></span>
                    <span className="person-actions">
                      <button type="button" className="btn sm primary" onClick={() => void acceptFriend(p)}>Accept</button>
                      <button type="button" className="btn sm ghost" onClick={() => void dropRequest(p)}>Decline</button>
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}

          {onSong.length ? (
            <Section title="Friend activity" className="now-section">
              <ul className="now-grid">
                {onSong.map((f, i) => <NowCard key={f.id} friend={f} index={i} />)}
              </ul>
            </Section>
          ) : null}

          {social?.inbox.length ? (
            <Shelf title="Sent to you" subtitle="Playlists your friends sent you.">
              {social.inbox.map((p) => (
                <SharedCard key={p.shareId} summary={p} subtitle={`${capital(ago(p.sentAt))} · From ${p.owner.displayName}`} onDismiss={() => void dismissInbox(p.shareId)} />
              ))}
            </Shelf>
          ) : null}

          <Section title="Your friends" count={friends?.length} className="all-friends">
            {!social ? <p className="muted"><span className="spinner" />Loading…</p> : sorted.length ? (
              <ul className="friend-list">
                {sorted.map((f, i) => <FriendRow key={f.id} friend={f} index={i} />)}
              </ul>
            ) : (
              <div className="friends-empty">
                <div className="friends-empty-art" aria-hidden="true">
                  <span /><span /><span />
                  <Icon name="users" size={26} />
                </div>
                <div>
                  <strong>No friends yet</strong>
                  <p className="muted">Add someone by their friend code or username, or give them yours. Once you're friends you'll see what they're playing here and can listen along.</p>
                </div>
              </div>
            )}
          </Section>

          {social?.following.length ? (
            <Shelf title="Playlists you follow">
              {social.following.map((p) => <SharedCard key={p.shareId} summary={p} subtitle={`By ${p.owner.displayName}`} />)}
            </Shelf>
          ) : null}
        </div>

        <aside className="friends-aside">
          <AddFriends />
          {social?.outgoing.length ? (
            <section className="waiting-card" aria-labelledby="waiting-title">
              <h2 id="waiting-title" className="mini-head">Waiting for an answer</h2>
              <ul className="people compact">
                {social.outgoing.map((p, i) => (
                  <li key={p.id} style={{ "--i": i } as CSSProperties}>
                    <Avatar person={p} />
                    <span className="person-copy"><strong><Name person={p} /></strong><small>Sent {ago(p.at)}</small></span>
                    <button type="button" className="btn sm ghost" onClick={() => void dropRequest(p)} aria-label={`Cancel request to ${p.displayName}`}>Cancel</button>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
        </aside>
      </div>
    </div>
  );
}

/** A playlist someone shared, opened from its link, the inbox, a friend's profile or Your Library. */
export function SharedView({ id }: { id: string }) {
  const account = useAccount();
  const social = useSocial();
  const [playlist, setPlaylist] = useState<SharedPlaylist | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const [ids, setIds] = useState<string[]>([]);
  // Yours, and on this device (one shared from another device may not have synced here yet).
  const local = useStore((s) => Boolean(playlist?.playlistId && s.playlists.some((p) => p.id === playlist.playlistId)));

  // Loaded again while it's open (every 30 seconds while the window has focus), so the owner's changes show.
  useEffect(() => {
    if (account.status !== "signedIn") return;
    let live = true;
    const load = () => loadShared(id).then(
      (p) => {
        if (!live) return;
        setError("");
        setPlaylist((old) => (old && JSON.stringify(old) === JSON.stringify(p) ? old : p));
      },
      (e: unknown) => live && setError(sharedError(e)),
    );
    void load();
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible" && document.hasFocus()) void load();
    }, 30_000);
    return () => {
      live = false;
      clearInterval(timer);
    };
    // Reloaded when your follows change (it says whether you follow it).
  }, [id, account.status, social?.following.length]);

  // Its songs, as yours (if you have them) or streamed from their links: registered here, not while rendering.
  useEffect(() => {
    setIds(playlist ? playlist.tracks.map(trackForSong) : []);
  }, [playlist]);
  const total = playlist?.tracks.reduce((sum, t) => sum + (t.durationSeconds ?? 0), 0) ?? 0;

  if (account.status !== "signedIn") return <NeedsAccount what="shared" />;
  if (error) return <div className="view"><Empty icon="playlists" title="Couldn't open this playlist" body={error} action={<button type="button" className="btn" onClick={() => navigate({ name: "friends" })}>Go to Friends</button>} /></div>;
  if (!playlist) return <div className="view"><p className="muted"><span className="spinner" />Opening the playlist…</p></div>;

  const route: Route = { name: "shared", id };
  const palette = sharedPalette(id);
  const art = playlist.tracks.find((t) => t.artworkUrl)?.artworkUrl ?? undefined;
  // Your profile, or the owner's if they're your friend (only friends' profiles can be seen).
  const ownerProfile: Route | null = playlist.mine ? { name: "profile" } : social?.friends.some((f) => f.id === playlist.owner.id) ? { name: "profile", id: playlist.owner.id } : null;
  const follow = async (on: boolean) => {
    setBusy(true);
    if (await followShared(id, on)) setPlaylist({ ...playlist, following: on });
    setBusy(false);
  };

  return (
    <div className="view">
      <Hero
        art={<Art palette={palette} image={art} icon="playlists" label={`${playlist.name} cover`} />}
        kind={playlist.mine ? "Your shared playlist" : "Shared playlist"}
        title={playlist.name}
        description={playlist.description}
        tint={palette.b}
        play={{ ids, label: playlist.name, route }}
        meta={<>{ownerProfile ? (
          <button type="button" className="meta-owner" onClick={() => navigate(ownerProfile)} title={playlist.mine ? "Open your profile" : `Open ${playlist.owner.displayName}’s profile`}>
            <Avatar person={playlist.owner} className="meta-avatar" /><strong>{playlist.mine ? "You" : playlist.owner.displayName}</strong>
          </button>
        ) : <><Avatar person={playlist.owner} className="meta-avatar" /><strong>{playlist.owner.displayName}</strong></>}<span>{plural(ids.length, "song")}</span>{total ? <span>{formatLongDuration(total)}</span> : null}</>}
      />
      <div className="action-bar">
        <PlayFab ids={ids} label={playlist.name} route={route} size="lg" />
        {playlist.mine ? (local ? (
          <>
            <button type="button" className="btn" onClick={() => navigate({ name: "playlist", id: playlist.playlistId! })}><Icon name="playlists" size={18} />Open your playlist</button>
            <button type="button" className="btn" onClick={() => openModal({ type: "sharePlaylist", id: playlist.playlistId! })}><Icon name="link" size={18} />Sharing</button>
          </>
        ) : <span className="muted small">Shared from another device. It shows in your library once it syncs.</span>) : (
          <>
            <button type="button" className={`btn${playlist.following ? "" : " primary"}`} disabled={busy} onClick={() => void follow(!playlist.following)}>
              <Icon name={playlist.following ? "check" : "plus"} size={18} />{playlist.following ? "Following" : "Follow"}
            </button>
            <button type="button" className="btn" disabled={!ids.length} onClick={() => saveSharedCopy(playlist)}><Icon name="download" size={18} />Save a copy</button>
            <button type="button" className="icon-btn lg" onClick={() => void copyText(shareLink(id))} aria-label="Copy link" title="Copy link"><Icon name="copy" size={22} /></button>
          </>
        )}
      </div>
      {!playlist.mine ? <p className="muted small shared-note">Updates as {playlist.owner.displayName} changes it. Only they can edit it.</p> : null}
      <TrackList
        ids={ids}
        context={{ label: playlist.name, route }}
        sortable={false}
        showAdded={false}
        empty={<Empty icon="playlists" title="Nothing to play here yet" body="Songs that are only files on someone's computer can't be shared." />}
      />
    </div>
  );
}
