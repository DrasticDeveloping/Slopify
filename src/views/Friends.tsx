import { useEffect, useState, type CSSProperties } from "react";
import { Art } from "../components/Artwork";
import { Hero } from "../components/Hero";
import { Icon } from "../components/Icon";
import { Card, PlayFab, Shelf } from "../components/Shelf";
import { TrackList } from "../components/TrackList";
import { hashString, paletteFromSeed } from "../data/library";
import { formatLongDuration, plural } from "../lib/format";
import { navigate, openModal, playList } from "../state/actions";
import { cloudEnabled, signIn, useAccount } from "../state/cloud";
import { joinRoom } from "../state/listen";
import {
  acceptFriend, addFriend, copyText, dismissInbox, dropRequest, followShared, friendPlaylists, loadShared, openShared, refreshSocial, removeFriend, saveSharedCopy,
  sharedError, shareLink, trackForSong, useSocial, useSocialError, type Friend, type Person, type SharedPlaylist, type SharedSummary,
} from "../state/social";
import { useStore, type Route } from "../state/store";
import { Empty } from "./Collection";

const personPalette = (p: Person) => paletteFromSeed(hashString(p.id));
const sharedPalette = (shareId: string) => paletteFromSeed(hashString(shareId));
const ago = (at: number) => {
  const minutes = Math.round((Date.now() - at) / 60_000);
  return minutes < 1 ? "just now" : minutes < 60 ? `${minutes} min ago` : `${Math.round(minutes / 60)} h ago`;
};

function Avatar({ person, className = "person-art" }: { person: Person; className?: string }) {
  return <Art palette={personPalette(person)} round className={className} image={person.avatarUrl ?? undefined} label={person.displayName} />;
}

/** Signed out, or no online service: what this page needs. While the account loads, or if it couldn't, it says that instead. */
function NeedsAccount({ what }: { what: string }) {
  const account = useAccount();
  if (account.status === "loading") return <div className="view"><p className="muted"><span className="spinner" />Connecting to your account…</p></div>;
  return (
    <div className="view">
      <Empty
        icon="users"
        title={what}
        body={!cloudEnabled ? "This needs Slopify's online service, which this copy of Slopify isn't set up with." : "Sign in to add friends, share playlists and see what your friends are playing."}
        action={cloudEnabled ? <button type="button" className="btn primary" onClick={signIn}>Sign in</button> : undefined}
      />
    </div>
  );
}

function SharedCard({ summary, subtitle, onDismiss }: { summary: SharedSummary; subtitle: string; onDismiss?: () => void }) {
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

function FriendRow({ friend, index }: { friend: Friend; index: number }) {
  const listen = useStore((s) => s.listen.mode);
  const [open, setOpen] = useState(false);
  const [playlists, setPlaylists] = useState<SharedSummary[] | null>(null);
  const [error, setError] = useState("");
  const a = friend.activity;

  useEffect(() => {
    if (!open || playlists) return;
    friendPlaylists(friend.id).then(setPlaylists, (e: unknown) => setError(e instanceof Error ? e.message : "Couldn't load their playlists."));
  }, [open, playlists, friend.id]);

  const playTheirSong = () => {
    if (!a?.song?.sourceURL) return;
    const id = trackForSong({ title: a.song.title, artist: a.song.artist, album: null, sourceURL: a.song.sourceURL, savedAs: "audio", durationSeconds: null, artworkUrl: a.song.artworkUrl });
    playList([id], id, { label: `${friend.displayName} is listening`, route: { name: "friends" } });
  };

  return (
    <li className="friend" style={{ "--i": Math.min(index, 12) } as CSSProperties}>
      <div className="friend-main">
        <Avatar person={friend} />
        <div className="friend-copy">
          <strong>{friend.displayName}{friend.username ? <span className="muted handle"> @{friend.username}</span> : null}</strong>
          {a?.song ? (
            <small className={a.playing ? "accent" : undefined}>
              {a.playing ? <Icon name="volume" size={13} /> : null}
              {a.playing ? "" : "Paused · "}{a.song.title} · {a.song.artist}{a.playing ? "" : ` · ${ago(a.at)}`}
            </small>
          ) : <small>{a ? "Not playing anything" : "Not listening right now"}</small>}
        </div>
        {a?.roomCode ? (
          <button type="button" className="btn sm primary" disabled={listen !== "idle"} onClick={() => void joinRoom(a.roomCode!)} title={listen !== "idle" ? "Leave your current room first" : undefined}>
            <span className="live-dot" />Listen along
          </button>
        ) : a?.song?.sourceURL ? (
          <button type="button" className="icon-btn round" onClick={playTheirSong} aria-label={`Play ${a.song.title}`} title="Play this song">
            <Icon name="play" size={16} />
          </button>
        ) : null}
        <button type="button" className="btn sm" aria-expanded={open} onClick={() => setOpen(!open)}>
          Playlists<Icon name={open ? "chevronUp" : "chevronDown"} size={15} />
        </button>
        <button
          type="button"
          className="icon-btn sm"
          onClick={() => {
            if (window.confirm(`Remove ${friend.displayName} from your friends?`)) void removeFriend(friend);
          }}
          aria-label={`Remove ${friend.displayName}`}
          title="Remove friend"
        >
          <Icon name="close" size={15} />
        </button>
      </div>
      {open ? (
        <div className="friend-playlists">
          {error ? <p className="muted small">{error}</p> : !playlists ? <p className="muted small"><span className="spinner" />Loading…</p> : !playlists.length ? (
            <p className="muted small">{friend.displayName} hasn't shared any playlists on their profile.</p>
          ) : (
            <div className="shelf-row">
              {playlists.map((p) => <SharedCard key={p.shareId} summary={p} subtitle={plural(p.songCount, "song")} />)}
            </div>
          )}
        </div>
      ) : null}
    </li>
  );
}

export function FriendsView() {
  const account = useAccount();
  const social = useSocial();
  const socialError = useSocialError();
  const [code, setCode] = useState("");
  const [adding, setAdding] = useState(false);
  // A friend code (ABCD-2345) or a username (@name).
  const valid = /^[A-Z0-9]{4}-?[A-Z0-9]{4}$/i.test(code.trim()) || /^@?[a-z0-9_][a-z0-9_.]{1,18}[a-z0-9_]$/i.test(code.trim());

  useEffect(() => {
    void refreshSocial();
  }, []);

  if (account.status !== "signedIn") return <NeedsAccount what="Friends" />;
  if (!social && socialError) {
    return (
      <div className="view">
        <Empty icon="users" title="Couldn't load your friends" body={socialError} action={<button type="button" className="btn" onClick={() => void refreshSocial()}>Try again</button>} />
      </div>
    );
  }
  const myCode = account.profile?.friendCode;
  const listening = social?.friends.filter((f) => f.activity?.playing).length ?? 0;

  return (
    <div className="view friends-view">
      <header className="page-head">
        <div>
          <span className="eyebrow">Your people</span>
          <h1>Friends</h1>
          <p className="muted">{social ? `${plural(social.friends.length, "friend")}${listening ? `, ${listening} listening now` : ""}` : "Loading…"}</p>
        </div>
      </header>

      <div className="friends-top">
        <div className="room-card">
          <span className="eyebrow">Your friend code</span>
          <div className="room-code">
            <strong>{myCode ?? "····-····"}</strong>
            <button type="button" className="btn sm" disabled={!myCode} onClick={() => myCode && void copyText(myCode, "Friend code")}><Icon name="copy" size={16} />Copy</button>
          </div>
          <p className="muted small">{account.profile?.username ? `Friends can add you with it, or as @${account.profile.username}.` : "Give it to friends so they can add you."}</p>
        </div>
        <form
          className="add-friend"
          onSubmit={(e) => {
            e.preventDefault();
            if (!valid || adding) return;
            setAdding(true);
            void addFriend(code).then((ok) => ok && setCode("")).finally(() => setAdding(false));
          }}
        >
          <label className="mini-head" htmlFor="friend-code">Add a friend</label>
          <div className="join-row">
            <input id="friend-code" className="input" value={code} onChange={(e) => setCode(e.target.value)} placeholder="Friend code or @username" maxLength={24} spellCheck={false} autoComplete="off" />
            <button type="submit" className="btn primary" disabled={!valid || adding}>{adding ? <><span className="spinner" />Adding</> : "Add"}</button>
          </div>
          <p className="muted small">Enter their friend code or username. They'll get a request to accept.</p>
        </form>
      </div>

      {social?.incoming.length ? (
        <section>
          <h2 className="section-title">Friend requests <span className="muted">{social.incoming.length}</span></h2>
          <ul className="people">
            {social.incoming.map((p, i) => (
              <li key={p.id} style={{ "--i": i } as CSSProperties}>
                <Avatar person={p} />
                <span>{p.displayName}{p.username ? <span className="muted handle"> @{p.username}</span> : null}</span>
                <button type="button" className="btn sm primary" onClick={() => void acceptFriend(p)}>Accept</button>
                <button type="button" className="btn sm" onClick={() => void dropRequest(p)}>Decline</button>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {social?.inbox.length ? (
        <Shelf title="Sent to you">
          {social.inbox.map((p) => (
            <SharedCard key={p.shareId} summary={p} subtitle={`From ${p.owner.displayName}`} onDismiss={() => void dismissInbox(p.shareId)} />
          ))}
        </Shelf>
      ) : null}

      <section>
        <h2 className="section-title">Your friends</h2>
        {!social ? <p className="muted"><span className="spinner" />Loading…</p> : social.friends.length ? (
          <ul className="friend-list">
            {/* Those listening now first. */}
            {[...social.friends].sort((a, b) => Number(Boolean(b.activity?.playing)) - Number(Boolean(a.activity?.playing))).map((f, i) => <FriendRow key={f.id} friend={f} index={i} />)}
          </ul>
        ) : <p className="muted">No friends yet. Share your friend code, or add a friend with theirs.</p>}
      </section>

      {social?.outgoing.length ? (
        <section>
          <h2 className="section-title">Waiting for an answer</h2>
          <ul className="people">
            {social.outgoing.map((p, i) => (
              <li key={p.id} style={{ "--i": i } as CSSProperties}>
                <Avatar person={p} />
                <span>{p.displayName}{p.username ? <span className="muted handle"> @{p.username}</span> : null}</span>
                <button type="button" className="btn sm" onClick={() => void dropRequest(p)}>Cancel request</button>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {social?.following.length ? (
        <Shelf title="Playlists you follow">
          {social.following.map((p) => <SharedCard key={p.shareId} summary={p} subtitle={`By ${p.owner.displayName}`} />)}
        </Shelf>
      ) : null}
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

  if (account.status !== "signedIn") return <NeedsAccount what="Someone shared a playlist with you" />;
  if (error) return <div className="view"><Empty icon="playlists" title="Couldn't open this playlist" body={error} action={<button type="button" className="btn" onClick={() => navigate({ name: "friends" })}>Go to Friends</button>} /></div>;
  if (!playlist) return <div className="view"><p className="muted"><span className="spinner" />Opening the playlist…</p></div>;

  const route: Route = { name: "shared", id };
  const palette = sharedPalette(id);
  const art = playlist.tracks.find((t) => t.artworkUrl)?.artworkUrl ?? undefined;
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
        meta={<><Avatar person={playlist.owner} className="meta-avatar" /><strong>{playlist.mine ? "You" : playlist.owner.displayName}</strong><span>{plural(ids.length, "song")}</span>{total ? <span>{formatLongDuration(total)}</span> : null}</>}
      />
      <div className="action-bar">
        <PlayFab ids={ids} label={playlist.name} route={route} size="lg" />
        {playlist.mine ? (
          <>
            <button type="button" className="btn" onClick={() => navigate({ name: "playlist", id: playlist.playlistId! })}><Icon name="playlists" size={18} />Open your playlist</button>
            <button type="button" className="btn" onClick={() => openModal({ type: "sharePlaylist", id: playlist.playlistId! })}><Icon name="link" size={18} />Sharing</button>
          </>
        ) : (
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
