import { useState, type FormEvent } from "react";
import { formatTime, plural } from "../../lib/format";
import { closeModal, navigate, toast } from "../../state/actions";
import { answerMatchCheck, listenToMatch, matchCheckTrack, startPlaylistSave } from "../../state/importer";
import { useStore, type ImportMissing, type Modal } from "../../state/store";
import { Icon } from "../Icon";
import { Shell, Toggle } from "./Shell";

/**
 * Before a pasted (or linked) playlist's songs are saved: whether they're downloaded, whether they also go in a
 * playlist, and what it's called. Not downloading them makes a playlist that streams them. `count`: the songs ticked
 * when asked (while matching, more are added as they're found). `owned`: the playlist's songs already in the
 * library, which a new playlist can include in their places.
 */
export function SavePlaylistModal({ count, owned, name: suggested, matching, video = false }: { count: number; owned: number; name: string; matching: boolean; video?: boolean }) {
  // Saved as chosen beside the list's Save button: songs, or videos.
  const noun = video ? "video" : "song";
  const nouns = `${noun}s`;
  const [download, setDownload] = useState(true);
  const [makePlaylist, setMakePlaylist] = useState(true);
  const [name, setName] = useState(suggested);
  const [includeOwned, setIncludeOwned] = useState(true);
  const playlistName = name.trim() || suggested;
  const existing = useStore((s) => s.playlists.some((p) => !p.system && p.name === playlistName));
  // Only songs already in the library: the only thing to do is make the playlist.
  const onlyPlaylist = count === 0 && !matching;
  // Streaming the songs only makes sense in a playlist.
  const playlistNeeded = onlyPlaylist || !download;
  const title = onlyPlaylist ? "Make a playlist" : download ? `Save ${plural(count, noun)}` : `Make a playlist of ${plural(count, noun)}`;
  const subtitle = !matching ? undefined : download ? `${video ? "Videos" : "Songs"} still being found are saved as they're found.` : `${video ? "Videos" : "Songs"} still being found are added as they're found.`;

  const submit = (e: FormEvent) => {
    e.preventDefault();
    startPlaylistSave({ playlistName: makePlaylist || playlistNeeded ? playlistName : null, includeOwned: includeOwned || onlyPlaylist, download: download || onlyPlaylist });
  };

  return (
    <Shell title={title} subtitle={subtitle} icon={download || onlyPlaylist ? "download" : "playlists"} size="sm" className="save-songs-modal">
      <form className="form" onSubmit={submit}>
        <div className="set-group">
          {onlyPlaylist ? null : (
            <div className="set-row">
              <span className="set-icon"><Icon name="download" size={19} /></span>
              <span className="set-copy">
                <strong>Download the {nouns}</strong>
                <small>{download ? "Kept in your library, to play anywhere and offline." : "Not downloaded: the playlist streams them from YouTube and SoundCloud."}</small>
              </span>
              <Toggle checked={download} onChange={setDownload} label={`Download the ${nouns}`} />
            </div>
          )}
          {onlyPlaylist ? null : (
            // Stays in view when the songs aren't downloaded: the playlist is then how they're kept (so it's always on).
            <div className="set-row">
              <span className="set-icon"><Icon name="playlists" size={19} /></span>
              <span className="set-copy">
                <strong>Make a playlist</strong>
                <small>{download ? `With the saved ${nouns}, in the list's order.` : `The ${nouns} stream from it, in the list's order.`}</small>
              </span>
              <Toggle checked={makePlaylist || !download} onChange={setMakePlaylist} label="Make a playlist" disabled={!download} />
            </div>
          )}
          {makePlaylist || playlistNeeded ? (
            <>
              <label className="set-row column save-name">
                <span className="field-label">
                  Playlist name
                  <input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder={suggested} maxLength={80} data-autofocus />
                </span>
                {existing ? <small className="muted">You already have this playlist: the {nouns} are added to it.</small> : null}
              </label>
              {owned && !onlyPlaylist ? (
                <div className="set-row">
                  <span className="set-icon"><Icon name="library" size={19} /></span>
                  <span className="set-copy">
                    <strong>Include {nouns} you already have</strong>
                    <small>{plural(owned, noun)} of this list {owned === 1 ? "is" : "are"} already in your library.</small>
                  </span>
                  <Toggle checked={includeOwned} onChange={setIncludeOwned} label={`Include ${nouns} you already have`} />
                </div>
              ) : null}
            </>
          ) : null}
        </div>
        <div className="form-actions">
          <button type="button" className="btn ghost" onClick={closeModal}>Cancel</button>
          <button type="submit" className="btn primary">{onlyPlaylist || !download ? "Make playlist" : title}</button>
        </div>
      </form>
    </Shell>
  );
}

/**
 * Before saving a song matched to its upload by name only (the upload may be another recording): what was asked for,
 * what would be saved, a way to listen, and Save. Shown over the page the save started on; closing it saves nothing.
 */
export function CheckMatchModal({ song, artist, upload, uploader, duration, provider, url, canListen, video }: Extract<Modal, { type: "checkMatch" }>) {
  const playing = useStore((s) => s.isPlaying && s.currentId !== null && s.currentId === matchCheckTrack());
  return (
    <Shell
      title="Check this match"
      subtitle={`Found on ${provider} by name only, so it may be a different recording. Listen first if you're not sure.`}
      icon="help"
      size="sm"
      className="check-match-modal"
      footer={
        <>
          {canListen ? (
            // Listening first is the point of the dialog, so it has focus (Enter doesn't save unchecked).
            <button type="button" className="btn ghost" onClick={listenToMatch} data-autofocus>
              <Icon name={playing ? "pause" : "play"} size={16} />
              {playing ? "Pause" : "Listen"}
            </button>
          ) : null}
          <span className="spacer" />
          <button type="button" className="btn ghost" onClick={closeModal} data-autofocus={canListen ? undefined : true}>Cancel</button>
          <button type="button" className="btn primary" onClick={() => answerMatchCheck(true)}>
            <Icon name="download" size={16} />
            {video ? "Save video" : "Save song"}
          </button>
        </>
      }
    >
      <dl className="match-pair">
        <div>
          <dt>You chose</dt>
          <dd><strong>{song}</strong>{artist ? <span>{artist}</span> : null}</dd>
        </div>
        <div>
          <dt>Saves this upload</dt>
          <dd>
            {url ? <a href={url} target="_blank" rel="noreferrer"><strong>{upload}</strong></a> : <strong>{upload}</strong>}
            <span>{[uploader, duration ? formatTime(duration) : "", provider].filter(Boolean).join(" · ")}</span>
          </dd>
        </div>
      </dl>
    </Shell>
  );
}

const REASONS: Record<ImportMissing["reason"], string> = {
  not_found: "",
  search_failed: "YouTube didn't answer",
  not_on_spotify: "No longer on Spotify",
  unread: "Spotify didn't answer",
  failed: "Couldn't be downloaded",
  unstreamable: "Can't be streamed",
};

/** When a playlist's songs have been saved (or put in a playlist as streams): the songs that weren't. */
export function ImportSummaryModal({ saved, playlistId, playlistName, missing, streamed = false }: { saved: number; playlistId: string | null; playlistName: string | null; missing: ImportMissing[]; streamed?: boolean }) {
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
      title={`${plural(missing.length, "song")} ${missing.length === 1 ? "wasn't" : "weren't"} ${missing.every((m) => m.reason === "not_found") ? "found" : streamed ? "added" : "saved"}`}
      subtitle={`${streamed ? "Added" : "Saved"} ${plural(saved, "song")}${playlistName ? ` to “${playlistName}”` : " to your library"}${streamed ? ", streaming" : ""}.`}
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
