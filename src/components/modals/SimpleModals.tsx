import { creditLine } from "../../lib/credits";
import { useMemo, useState, type CSSProperties, type FormEvent } from "react";
import { plural } from "../../lib/format";
import { addToPlaylist, closeModal, createPlaylist, editPlaylist, findMusic, libraryIds, navigate, removeFromPlaylist, toast } from "../../state/actions";
import { signIn, useAccount } from "../../state/cloud";
import { joinRoom, leaveRoom, startRoom } from "../../state/listen";
import { getState, useStore } from "../../state/store";
import { Art, PlaylistArt, TrackArt } from "../Artwork";
import { hashString, paletteFromSeed } from "../../data/library";
import { ChooseFiles } from "../ChooseFiles";
import { Icon } from "../Icon";
import { Shell } from "./Shell";

export function PlaylistFormModal({ editId, addIds }: { editId?: string; addIds?: string[] }) {
  const existing = useStore((s) => (editId ? s.playlists.find((p) => p.id === editId) : undefined));
  const count = useStore((s) => s.playlists.filter((p) => !p.system).length);
  const [name, setName] = useState(existing?.name ?? "");
  const [description, setDescription] = useState(existing?.description ?? "");
  const placeholder = `My Playlist #${count + 1}`;
  // A new playlist's cover is its colours (and, with songs to start, their covers), previewed as you type.
  const preview = existing ?? { id: "new", name: name || placeholder, description, system: false, trackIds: addIds ?? [], createdAt: 0, palette: paletteFromSeed(hashString(name.trim() || placeholder)) };

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (existing) {
      editPlaylist(existing.id, { name: name.trim() || existing.name, description: description.trim() });
      toast("Playlist updated", { tone: "success" });
      closeModal();
      return;
    }
    const id = createPlaylist(name.trim() || placeholder, addIds, description.trim());
    closeModal();
    navigate({ name: "playlist", id });
    toast(addIds?.length ? `Created playlist with ${plural(addIds.length, "song")}` : "Playlist created", { tone: "success" });
  };

  return (
    <Shell title={existing ? "Edit details" : "Create playlist"} subtitle={!existing && addIds?.length ? `Starting with ${plural(addIds.length, "song")}` : undefined} tint={preview.palette.b} size="md">
      <form className="form" onSubmit={submit}>
        <div className="details-grid">
          <div className="details-cover">
            <PlaylistArt playlist={preview} />
            <span className="details-cover-name">{name.trim() || existing?.name || placeholder}</span>
          </div>
          <div className="details-fields">
            <label className="field-label">
              Name
              <input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder={placeholder} maxLength={80} autoFocus />
            </label>
            <label className="field-label grow">
              <span>Description <span className="optional">(optional)</span></span>
              <textarea className="input" value={description} onChange={(e) => setDescription(e.target.value)} placeholder="What's the vibe?" rows={4} maxLength={300} />
            </label>
          </div>
        </div>
        <div className="form-actions">
          <button type="button" className="btn ghost" onClick={closeModal}>Cancel</button>
          <button type="submit" className="btn primary">{existing ? "Save" : "Create"}</button>
        </div>
      </form>
    </Shell>
  );
}

export function AddSongsModal({ playlistId }: { playlistId: string }) {
  const playlist = useStore((s) => s.playlists.find((p) => p.id === playlistId));
  const tracks = useStore((s) => s.tracks);
  const artists = useStore((s) => s.artists);
  const [q, setQ] = useState("");
  const trackIds = useStore((s) => s.trackIds);
  const all = useMemo(() => libraryIds({ ...getState(), tracks, trackIds }), [tracks, trackIds]);
  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return all.filter((id) => !needle || `${tracks[id].title} ${creditLine(tracks[id], artists)}`.toLowerCase().includes(needle)).slice(0, 80);
  }, [all, q, tracks, artists]);
  if (!playlist) return null;
  const inList = new Set(playlist.trackIds);

  return (
    <Shell title="Add songs" subtitle={<>to <strong>{playlist.name}</strong> · {plural(playlist.trackIds.length, "song")}</>} art={<PlaylistArt playlist={playlist} />} tint={playlist.palette.b} size="md" footer={<><span className="muted small">{plural(playlist.trackIds.length, "song")} in the playlist</span><span className="spacer" /><button type="button" className="btn primary" onClick={closeModal}>Done</button></>}>
      <label className="field search-field">
        <Icon name="search" size={18} />
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search your library" aria-label="Search songs to add" autoFocus />
      </label>
      <div className="pick-list">
        {shown.map((id) => {
          const t = tracks[id];
          const added = inList.has(id);
          return (
            <div key={id} className={`pick-row${added ? " added" : ""}`}>
              <TrackArt trackId={id} className="row-art" />
              <span className="title-text">
                <span className="t-name">{t.title}</span>
                <span className="t-sub">{creditLine(t, artists)}</span>
              </span>
              <button
                type="button"
                className={`pick-btn${added ? " on" : ""}`}
                onClick={() => (added ? removeFromPlaylist(playlistId, [id]) : addToPlaylist(playlistId, [id], { silent: true }))}
                aria-label={added ? `Remove ${t.title}` : `Add ${t.title}`}
                aria-pressed={added}
              >
                <Icon name={added ? "check" : "plus"} size={16} />
                {added ? "Added" : "Add"}
              </button>
            </div>
          );
        })}
        {!shown.length && q.trim() ? <p className="muted small pad">No songs match “{q}”.</p> : null}
        {!all.length ? (
          <div className="pad">
            <p className="muted small">Your library is empty. Find songs online and save them, or choose files from this device, then add them here.</p>
            <div className="empty-actions start">
              <button type="button" className="btn primary" onClick={() => { closeModal(); findMusic(); }}><Icon name="search" size={18} />Find music</button>
              <ChooseFiles />
            </div>
          </div>
        ) : null}
      </div>
    </Shell>
  );
}

export function ListenAlongModal() {
  const listen = useStore((s) => s.listen);
  const account = useAccount();
  const [code, setCode] = useState("");
  const valid = /^[A-Z0-9]{4}-?[A-Z0-9]{4}$/i.test(code.trim());
  const me = account.userId;

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(listen.code);
      toast("Room code copied", { tone: "success" });
    } catch {
      toast("Couldn't copy", { detail: "Select the code and copy it manually." });
    }
  };

  if (account.status !== "signedIn") {
    return (
      <Shell title="Listen along" subtitle="Listen together in real time, with one person in control." icon="users" size="sm" className="listen-intro">
        <div className="listen-hero" aria-hidden="true">
          <span className="listen-orbit">
            <i style={{ "--h": 268 } as CSSProperties} />
            <i style={{ "--h": 330 } as CSSProperties} />
            <i style={{ "--h": 190 } as CSSProperties} />
          </span>
          <span className="listen-wave"><Icon name="wave" size={22} /></span>
        </div>
        <ul className="feature-rows">
          <li><span className="feature-icon"><Icon name="radio" size={17} /></span><span><strong>Start a room</strong><small>Everyone hears what you play, in sync.</small></span></li>
          <li><span className="feature-icon"><Icon name="users" size={17} /></span><span><strong>Join with a code</strong><small>Friends join from their own Slopify.</small></span></li>
          <li><span className="feature-icon"><Icon name="volume" size={17} /></span><span><strong>Your volume stays yours</strong><small>The host picks the music; you set the level.</small></span></li>
        </ul>
        <p className="muted small">
          {account.status === "disabled"
            ? "Listen Along needs Slopify's online service, which this copy of Slopify isn't set up with."
            : "Rooms are linked to your Slopify account, so friends see who you are."}
        </p>
        {account.status !== "disabled" ? (
          <div className="form-actions">
            <button type="button" className="btn primary wide" disabled={account.status === "loading"} onClick={signIn}><Icon name="user" size={17} />Sign in to listen along</button>
          </div>
        ) : null}
      </Shell>
    );
  }

  if (listen.mode === "host" || listen.mode === "guest") {
    const guests = listen.members.filter((m) => !m.host).length;
    return (
      <Shell title="Listen along" subtitle={listen.mode === "host" ? "You control playback for everyone." : `${listen.host} controls playback. Your volume is yours.`} icon="users" size="sm">
        <div className="room-card">
          <span className="eyebrow">Room code</span>
          <div className="room-code">
            <strong>{listen.code}</strong>
            <button type="button" className="btn sm" onClick={copy}><Icon name="copy" size={16} />Copy</button>
          </div>
        </div>
        <h3 className="mini-head">In the room · {listen.members.length}</h3>
        <ul className="people">
          {listen.members.map((m, i) => (
            <li key={m.userId} style={{ "--i": i } as CSSProperties}>
              <Art palette={{ a: `hsl(${(m.name.charCodeAt(0) * 37) % 360} 70% 60%)`, b: `hsl(${(m.name.charCodeAt(0) * 37 + 60) % 360} 60% 45%)`, c: "hsl(240 40% 20%)" }} round className="person-art" image={m.avatarUrl ?? undefined} />
              <span>{m.name}{m.userId === me ? " (you)" : ""}</span>
              {m.host ? <span className="pill">Host</span> : null}
            </li>
          ))}
          {listen.mode === "host" && !guests ? <li className="waiting"><span className="live-dot" />Share the code. Friends join from Listen along with their Slopify account.</li> : null}
        </ul>
        <div className="form-actions">
          <button type="button" className="btn danger" onClick={() => { leaveRoom(); closeModal(); }}>{listen.mode === "host" ? "End room" : "Leave room"}</button>
        </div>
      </Shell>
    );
  }

  const busy = listen.mode === "connecting";
  return (
    <Shell title="Listen along" subtitle="Listen together in real time, with one person in control." icon="users" size="sm">
      <button type="button" className="option-card" onClick={() => void startRoom()} disabled={busy}>
        <span className="option-icon"><Icon name="radio" size={22} /></span>
        <span>
          <strong>Start a room</strong>
          <small>Share what you're playing. You control playback.</small>
        </span>
        <Icon name="chevronRight" size={18} />
      </button>
      <div className="divider"><span>or join a friend</span></div>
      <form
        className="join-row"
        onSubmit={(e) => {
          e.preventDefault();
          if (valid) void joinRoom(code);
        }}
      >
        <input className="input mono" value={code} onChange={(e) => setCode(e.target.value.toUpperCase())} placeholder="XXXX-XXXX" maxLength={9} aria-label="Room code" spellCheck={false} disabled={busy} />
        <button type="submit" className="btn primary" disabled={!valid || busy}>
          {busy ? <><span className="spinner" />{listen.code ? "Joining" : "Starting"}</> : "Join"}
        </button>
      </form>
      <p className="muted small">Everyone hears songs saved from the web. A song that's only a file on the host's computer can't be shared.</p>
    </Shell>
  );
}
