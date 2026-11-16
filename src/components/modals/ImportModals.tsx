import { useState, type FormEvent } from "react";
import { plural } from "../../lib/format";
import { closeModal, navigate, toast } from "../../state/actions";
import { startPlaylistSave } from "../../state/importer";
import { useStore, type ImportMissing } from "../../state/store";
import { Icon } from "../Icon";
import { Shell, Toggle } from "./Shell";

/**
 * Before a pasted (or linked) playlist's songs are saved: whether they also go in a playlist, and what it's called.
 * `count`: the songs ticked when asked (while matching, more are saved as they're found). `owned`: the playlist's
 * songs already in the library, which a new playlist can include in their places.
 */
export function SavePlaylistModal({ count, owned, name: suggested, matching }: { count: number; owned: number; name: string; matching: boolean }) {
  const [makePlaylist, setMakePlaylist] = useState(true);
  const [name, setName] = useState(suggested);
  const [includeOwned, setIncludeOwned] = useState(true);
  const playlistName = name.trim() || suggested;
  const existing = useStore((s) => s.playlists.some((p) => !p.system && p.name === playlistName));
  // Only songs already in the library: the only thing to do is make the playlist.
  const onlyPlaylist = count === 0 && !matching;
  const title = onlyPlaylist ? "Make a playlist" : `Save ${plural(count, "song")}`;

  const submit = (e: FormEvent) => {
    e.preventDefault();
    startPlaylistSave({ playlistName: makePlaylist || onlyPlaylist ? playlistName : null, includeOwned: includeOwned || onlyPlaylist });
  };

  return (
    <Shell title={title} subtitle={matching ? "Songs still being found are saved as they're found." : undefined} icon="download" size="sm" className="save-songs-modal">
      <form className="form" onSubmit={submit}>
        <div className="set-group">
          {onlyPlaylist ? null : (
            <div className="set-row">
              <span className="set-icon"><Icon name="playlists" size={19} /></span>
              <span className="set-copy">
                <strong>Make a playlist</strong>
                <small>With the saved songs, in the list's order.</small>
              </span>
              <Toggle checked={makePlaylist} onChange={setMakePlaylist} label="Make a playlist" />
            </div>
          )}
          {makePlaylist || onlyPlaylist ? (
            <>
              <label className="set-row column save-name">
                <span className="field-label">
                  Playlist name
                  <input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder={suggested} maxLength={80} data-autofocus />
                </span>
                {existing ? <small className="muted">You already have this playlist: the songs are added to it.</small> : null}
              </label>
              {owned && !onlyPlaylist ? (
                <div className="set-row">
                  <span className="set-icon"><Icon name="library" size={19} /></span>
                  <span className="set-copy">
                    <strong>Include songs you already have</strong>
                    <small>{plural(owned, "song")} of this list {owned === 1 ? "is" : "are"} already in your library.</small>
                  </span>
                  <Toggle checked={includeOwned} onChange={setIncludeOwned} label="Include songs you already have" />
                </div>
              ) : null}
            </>
          ) : null}
        </div>
        <div className="form-actions">
          <button type="button" className="btn ghost" onClick={closeModal}>Cancel</button>
          <button type="submit" className="btn primary">{onlyPlaylist ? "Make playlist" : title}</button>
        </div>
      </form>
    </Shell>
  );
}

const REASONS: Record<ImportMissing["reason"], string> = {
  not_found: "",
  search_failed: "YouTube didn't answer",
  not_on_spotify: "No longer on Spotify",
  unread: "Spotify didn't answer",
  failed: "Couldn't be downloaded",
};

/** When a playlist's songs have been saved: the songs that weren't (not found, or not downloadable). */
export function ImportSummaryModal({ saved, playlistId, playlistName, missing }: { saved: number; playlistId: string | null; playlistName: string | null; missing: ImportMissing[] }) {
  const line = (m: ImportMissing) => `${m.title}${m.artist ? ` — ${m.artist}` : ""}`;
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(missing.map(line).join("\n"));
      toast(`Copied ${plural(missing.length, "song")}`, { tone: "success" });
    } catch {
      toast("Couldn't copy the list", { tone: "error" });
    }
  };
  const open = () => {
    closeModal();
    if (playlistId) navigate({ name: "playlist", id: playlistId });
  };
  return (
    <Shell
      title={`${plural(missing.length, "song")} ${missing.length === 1 ? "wasn't" : "weren't"} ${missing.every((m) => m.reason === "not_found") ? "found" : "saved"}`}
      subtitle={`Saved ${plural(saved, "song")}${playlistName ? ` to “${playlistName}”` : " to your library"}.`}
      icon="help"
      size="md"
      className="import-summary-modal"
      footer={
        <>
          <button type="button" className="btn ghost" onClick={() => void copy()}><Icon name="copy" size={16} />Copy list</button>
          <span className="spacer" />
          {playlistId ? <button type="button" className="btn" onClick={open}>Open playlist</button> : null}
          <button type="button" className="btn primary" onClick={closeModal} data-autofocus>Done</button>
        </>
      }
    >
      <ol className="missing-list">
        {missing.map((m, i) => (
          <li key={i}>
            <span className="missing-title">{m.title}</span>
            <span className="missing-sub">{m.artist}{REASONS[m.reason] ? <>{m.artist ? " · " : ""}<em>{REASONS[m.reason]}</em></> : null}</span>
          </li>
        ))}
      </ol>
    </Shell>
  );
}
