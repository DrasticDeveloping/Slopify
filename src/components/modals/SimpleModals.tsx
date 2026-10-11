import { useMemo, useState, type CSSProperties, type FormEvent } from "react";
import { plural } from "../../lib/format";
import { addToPlaylist, closeModal, createPlaylist, editPlaylist, joinRoom, leaveRoom, libraryIds, navigate, removeFromPlaylist, startRoom, toast } from "../../state/actions";
import { getState, useStore } from "../../state/store";
import { Art, TrackArt } from "../Artwork";
import { Icon } from "../Icon";
import { Shell } from "./Shell";

export function PlaylistFormModal({ editId, addIds }: { editId?: string; addIds?: string[] }) {
  const existing = useStore((s) => (editId ? s.playlists.find((p) => p.id === editId) : undefined));
  const count = useStore((s) => s.playlists.filter((p) => !p.system).length);
  const [name, setName] = useState(existing?.name ?? "");
  const [description, setDescription] = useState(existing?.description ?? "");
  const placeholder = `My Playlist #${count + 1}`;

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
    <Shell title={existing ? "Edit details" : "Create playlist"} subtitle={!existing && addIds?.length ? `Starting with ${plural(addIds.length, "song")}` : undefined} size="sm">
      <form className="form" onSubmit={submit}>
        <label className="field-label">
          Name
          <input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder={placeholder} maxLength={80} autoFocus />
        </label>
        <label className="field-label">
          Description <span className="muted">(optional)</span>
          <textarea className="input" value={description} onChange={(e) => setDescription(e.target.value)} placeholder="What's the vibe?" rows={3} maxLength={300} />
        </label>
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
    return all.filter((id) => !needle || `${tracks[id].title} ${artists[tracks[id].artistId]?.name}`.toLowerCase().includes(needle)).slice(0, 80);
  }, [all, q, tracks, artists]);
  if (!playlist) return null;
  const inList = new Set(playlist.trackIds);

  return (
    <Shell title="Add songs" subtitle={<>to <strong>{playlist.name}</strong> · {plural(playlist.trackIds.length, "song")}</>} size="md" footer={<button type="button" className="btn primary" onClick={closeModal}>Done</button>}>
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
                <span className="t-sub">{artists[t.artistId]?.name}</span>
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
        {!shown.length ? <p className="muted small pad">No songs match “{q}”.</p> : null}
      </div>
    </Shell>
  );
}

export function ListenAlongModal() {
  const listen = useStore((s) => s.listen);
  const name = useStore((s) => s.settings.profileName);
  const [code, setCode] = useState("");
  const valid = /^[A-Z0-9]{4}-?[A-Z0-9]{4}$/i.test(code.trim());

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(listen.code);
      toast("Room code copied", { tone: "success" });
    } catch {
      toast("Couldn't copy", { detail: "Select the code and copy it manually." });
    }
  };

  if (listen.mode === "host" || listen.mode === "guest") {
    const people = listen.mode === "host" ? [name, ...listen.people] : [listen.host!, ...listen.people.filter((p) => p !== listen.host), name];
    return (
      <Shell title="Listen along" subtitle={listen.mode === "host" ? "You control playback for everyone." : `${listen.host} controls playback. Your volume is yours.`} icon="users" size="sm">
        <div className="room-card">
          <span className="eyebrow">Room code</span>
          <div className="room-code">
            <strong>{listen.code}</strong>
            <button type="button" className="btn sm" onClick={copy}><Icon name="copy" size={16} />Copy</button>
          </div>
        </div>
        <h3 className="mini-head">In the room · {people.length}</h3>
        <ul className="people">
          {people.map((p, i) => (
            <li key={p} style={{ "--i": i } as CSSProperties}>
              <Art palette={{ a: `hsl(${(p.charCodeAt(0) * 37) % 360} 70% 60%)`, b: `hsl(${(p.charCodeAt(0) * 37 + 60) % 360} 60% 45%)`, c: "hsl(240 40% 20%)" }} round className="person-art" />
              <span>{p}{p === name ? " (you)" : ""}</span>
              {(listen.mode === "host" && i === 0) || (listen.mode === "guest" && i === 0) ? <span className="pill">Host</span> : null}
            </li>
          ))}
          {listen.mode === "host" && listen.people.length < 2 ? <li className="waiting"><span className="live-dot" />Waiting for friends to join…</li> : null}
        </ul>
        <div className="form-actions">
          <button type="button" className="btn danger" onClick={() => { leaveRoom(); closeModal(); }}>{listen.mode === "host" ? "End room" : "Leave room"}</button>
        </div>
      </Shell>
    );
  }

  return (
    <Shell title="Listen along" subtitle="Listen together in real time, with one person in control." icon="users" size="sm">
      <button type="button" className="option-card" onClick={startRoom}>
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
          if (valid) joinRoom(code.trim().replace(/^(\w{4})(\w{4})$/, "$1-$2"));
        }}
      >
        <input className="input mono" value={code} onChange={(e) => setCode(e.target.value.toUpperCase())} placeholder="XXXX-XXXX" maxLength={9} aria-label="Room code" spellCheck={false} disabled={listen.mode === "connecting"} />
        <button type="submit" className="btn primary" disabled={!valid || listen.mode === "connecting"}>
          {listen.mode === "connecting" ? <><span className="spinner" />Joining</> : "Join"}
        </button>
      </form>
      <p className="muted small">Tip: any 8-character code works in this mockup.</p>
    </Shell>
  );
}
