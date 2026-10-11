import { useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import { formatTime } from "../../lib/format";
import { closeModal, importFiles } from "../../state/actions";
import {
  PROVIDERS, activeProvider, cancelImport, resultProviders, canPreview, confirmImport, failureText, isAudioOnlySource, isPlaylist, prepareImportDialog,
  providerLabel, resolveImport, setAllCandidates, setImportKind, setImportSource, setImportUpload, setProviderFocus, stageLabel, toggleCandidate,
  togglePreview, useImport, type Candidate, type ImportState, type Provider, type Resolution,
} from "../../state/importer";
import { useStore } from "../../state/store";
import { Icon } from "../Icon";
import { Shell, Toggle } from "./Shell";

function Thumb({ url, kind }: { url?: string | null; kind: "audio" | "video" }) {
  const [failed, setFailed] = useState(false);
  return (
    <span className="cand-thumb">
      <Icon name={kind === "video" ? "video" : "music"} size={18} />
      {url && !failed ? <img src={url} alt="" loading="lazy" decoding="async" referrerPolicy="no-referrer" draggable={false} onError={() => setFailed(true)} /> : null}
    </span>
  );
}

const join = (parts: Array<string | null | undefined | false>) => parts.filter(Boolean).join(" • ");

function candidateDetails(r: Resolution, c: Candidate) {
  const meta = c.importMetadata || c;
  if (r.kind === "search_results") {
    const via = c.sourceProvider === "soundcloud" ? "SoundCloud" : c.sourceProvider === "youtube_music" ? "YouTube Music" : "YouTube";
    return join([meta.artist || "Unknown artist", meta.album, meta.durationSeconds ? formatTime(meta.durationSeconds) : null, via !== providerLabel(c) ? `${r.mediaKind === "video" ? "Video" : "Preview"} via ${via}` : null]);
  }
  if (isPlaylist(r)) return join([meta.artist || "Unknown artist", meta.durationSeconds ? formatTime(meta.durationSeconds) : null, providerLabel(c)]);
  if (r.mediaKind === "video") {
    return join([c.qualityLabel || "MP4", c.width && c.height ? `${c.width}×${c.height}` : null, c.fps ? `${c.fps} fps` : null, c.durationSeconds ? formatTime(c.durationSeconds) : null, providerLabel(c)]);
  }
  return join([c.artist || "Unknown uploader", c.durationSeconds ? formatTime(c.durationSeconds) : null, providerLabel(c)]);
}

function candidatePill(r: Resolution, c: Candidate, index: number) {
  if (r.kind === "search_results") return providerLabel(c);
  if (isPlaylist(r)) return String(c.playlistIndex || index + 1);
  return c.quality || c.confidence || "file";
}

function resolvedMeta(r: Resolution) {
  const { track, candidates } = r;
  const noun = r.mediaKind === "video" ? "video" : "song";
  if (r.kind === "search_results") return join([track.artist, "YouTube • Spotify • SoundCloud"]);
  if (isPlaylist(r)) {
    const provider = r.kind === "spotify_playlist" ? "Spotify" : r.kind === "soundcloud_playlist" ? "SoundCloud" : "YouTube";
    return join([provider, track.artist, `${candidates.length} available ${noun}${candidates.length === 1 ? "" : "s"}`, r.playlist?.unavailableCount ? `${r.playlist.unavailableCount} unavailable` : null, r.playlist?.truncated ? "first 500 shown" : null]);
  }
  return join([track.artist, track.album, track.durationSeconds ? formatTime(track.durationSeconds) : null]);
}

function statusText(s: ImportState) {
  const label = stageLabel(s.stage) || "Working";
  if (s.busy === "import") {
    const pct = s.stage === "downloading" && s.progress?.total ? ` · ${Math.round((s.progress.completed / s.progress.total) * 100)}%` : "";
    return `${label}${pct} — ${s.transferName}`;
  }
  if (s.stage === "searching_candidates" && s.progress?.total) return `Matching songs · ${s.progress.completed} of ${s.progress.total}`;
  return `${label}…`;
}

function CandidateRow({ s, r, c, index, order }: { s: ImportState; r: Resolution; c: Candidate; index: number; order: number }) {
  const playlist = isPlaylist(r);
  const on = s.selected.includes(index);
  const showPreviews = r.mediaKind === "audio";
  const previewable = canPreview(r, c);
  const preview = s.preview?.index === index ? s.preview.status : null;
  const title = c.importMetadata?.title || c.title || "Untitled source";
  return (
    <label className={`candidate${on ? " on" : ""}${playlist ? " multi" : ""}`} style={{ "--i": Math.min(order, 12) } as CSSProperties}>
      <input
        type={playlist ? "checkbox" : "radio"}
        name="import-candidate"
        className="sr-only"
        checked={on}
        disabled={s.busy !== null}
        onChange={() => toggleCandidate(index)}
      />
      <Thumb url={c.importMetadata?.artworkURL || c.thumbnailURL} kind={r.mediaKind} />
      <span className="title-text">
        <span className="t-name">{title}</span>
        <span className="t-sub">{candidateDetails(r, c)}</span>
        {c.requiresReview && c.importMetadata ? <span className="t-sub">Matched upload: {c.title || "Untitled"}{c.artist ? ` · ${c.artist}` : ""}. Preview it before importing.</span> : null}
      </span>
      <span className="cand-pill">{candidatePill(r, c, index)}</span>
      {showPreviews ? (
        <button
          type="button"
          className={`preview-btn${preview ? ` ${preview}` : ""}`}
          aria-pressed={preview === "playing"}
          aria-label={preview === "loading" ? `Preparing preview for ${title}` : `${preview === "playing" ? "Pause" : "Preview"} ${title}`}
          title={!previewable ? "Preview unavailable for this source" : preview === "loading" ? "Preparing preview…" : preview === "playing" ? "Pause preview" : "Preview 30 seconds"}
          disabled={!previewable || s.busy !== null}
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            void togglePreview(index);
          }}
        >
          {preview === "loading" ? <span className="spinner" /> : <Icon name={preview === "playing" ? "pause" : "play"} size={15} />}
        </button>
      ) : null}
      <span className={playlist ? "checkmark" : "radio"} aria-hidden="true">{playlist ? <Icon name="check" size={13} /> : null}</span>
    </label>
  );
}

function ProviderTabs({ r, active }: { r: Resolution; active: Provider }) {
  const tabs = useRef<Partial<Record<Provider, HTMLButtonElement | null>>>({});
  const list = resultProviders(r);
  const names = Object.fromEntries(PROVIDERS) as Record<Provider, string>;
  const move = (step: number) => {
    const next = list[(list.indexOf(active) + step + list.length) % list.length];
    setProviderFocus(next);
    tabs.current[next]?.focus();
  };
  return (
    <div
      className="provider-pill"
      role="tablist"
      aria-label="Results by platform"
      onKeyDown={(e) => {
        if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
          e.preventDefault();
          move(e.key === "ArrowRight" ? 1 : -1);
        }
      }}
    >
      {list.map((p) => (
        <button
          key={p}
          ref={(el) => { tabs.current[p] = el; }}
          type="button"
          role="tab"
          id={`import-tab-${p}`}
          aria-selected={active === p}
          aria-controls="import-tabpanel"
          tabIndex={active === p ? 0 : -1}
          className={active === p ? "on" : ""}
          onClick={() => setProviderFocus(p)}
        >
          <span className={`prov-dot ${p}`} />
          {names[p]}
          <small>{r.candidates.filter((c) => c.searchProvider === p).length}</small>
        </button>
      ))}
    </div>
  );
}

function Results({ s, r }: { s: ImportState; r: Resolution }) {
  const search = r.kind === "search_results";
  const active = activeProvider(r, s.providerFocus);
  const playlist = isPlaylist(r);
  const noun = r.mediaKind === "video" ? "video" : "song";
  const cover = r.track.artworkURL || r.candidates.find((c) => c.thumbnailURL)?.thumbnailURL;
  const shown = search ? r.candidates.filter((c) => c.searchProvider === active) : r.candidates;
  const summary = search
    ? r.mediaKind === "video" ? `${shown.length} downloadable` : `${shown.filter((c) => canPreview(r, c)).length} previewable`
    : playlist ? `${r.candidates.length} available` : `${r.candidates.length} source${r.candidates.length === 1 ? "" : "s"}`;
  const indexed = r.candidates.map((c, index) => ({ c, index }));

  return (
    <>
      <div className="import-resolved">
        <span className="import-cover"><Thumb url={cover} kind={r.mediaKind} /></span>
        <span className="title-text">
          <strong>{r.track.title || "Untitled"}</strong>
          <small>{resolvedMeta(r)}</small>
        </span>
      </div>

      {search ? <ProviderTabs r={r} active={active} /> : null}
      {search && r.unavailableProviders?.length ? (
        <p className="muted small cand-empty">
          {r.unavailableProviders.map((p) => PROVIDERS.find(([id]) => id === p)?.[1] ?? p).join(" and ")} search is unavailable right now.
        </p>
      ) : null}

      <div className="import-legend">
        <strong>{search ? "Search results" : playlist ? `Choose playlist ${noun}s to import` : "Choose the source to import"}</strong>
        <small>{summary}</small>
        {playlist ? (
          <button type="button" className="text-btn" disabled={s.busy !== null} onClick={() => setAllCandidates(s.selected.length === 0)}>
            {s.selected.length ? "Select none" : "Select all"}
          </button>
        ) : null}
      </div>

      {search ? (
        <div className="candidates" role="tabpanel" id="import-tabpanel" aria-labelledby={`import-tab-${active}`} key={active}>
          {indexed.filter(({ c }) => c.searchProvider === active).map(({ c, index }, i) => <CandidateRow key={index} s={s} r={r} c={c} index={index} order={i} />)}
        </div>
      ) : (
        <div className="candidates" role="group" aria-label={playlist ? "Playlist songs" : "Sources"}>
          {indexed.map(({ c, index }) => <CandidateRow key={index} s={s} r={r} c={c} index={index} order={index} />)}
        </div>
      )}
    </>
  );
}

export function ImportModal() {
  const s = useImport((x) => x);
  const server = useStore((st) => st.server.status);
  const uploadMode = useStore((st) => st.settings.uploadMode);
  const [dragging, setDragging] = useState(false);
  const file = useRef<HTMLInputElement>(null);

  // Before paint, so a finished import's results never flash on reopen.
  useLayoutEffect(() => prepareImportDialog(), []);

  const r = s.resolution;
  const playlist = isPlaylist(r);
  const importing = s.busy === "import";
  const audioOnly = isAudioOnlySource(s.source);
  const canUpload = server === "connected" && uploadMode !== "off";
  const unavailable = s.available === false;
  const noun = s.mediaKind === "video" ? "video" : "song";
  const confirmLabel = playlist
    ? s.selected.length ? `Download ${s.selected.length} ${noun}${s.selected.length === 1 ? "" : "s"}` : `Choose ${noun}s`
    : s.mediaKind === "video" ? "Download video" : "Download audio";

  const onFiles = (files: FileList | null) => {
    if (!files?.length) return;
    if (importFiles(files).length) closeModal();
  };

  return (
    <Shell
      title="Import from Web"
      subtitle="Paste a Spotify, SoundCloud, or YouTube link, or search all three."
      icon="download"
      size="lg"
      className={`import-modal${dragging ? " drag-over" : ""}`}
      footer={
        <>
          {r && !importing ? (
            <label className={`inline-toggle${canUpload ? "" : " disabled"}`} title={canUpload ? "Upload a copy to your music server after downloading." : "Connect to your music server to upload copies."}>
              <Toggle checked={canUpload && s.upload} onChange={setImportUpload} label="Upload to server" disabled={!canUpload || s.busy !== null} />
              <span>
                <strong>Upload to server</strong>
                <small>{canUpload ? "Keep a copy on your music server" : server === "connected" ? "Uploads are turned off in Settings" : "Server offline"}</small>
              </span>
            </label>
          ) : null}
          <span className="spacer" />
          <button type="button" className="btn ghost" disabled={s.busy !== null} onClick={() => file.current?.click()}>
            <Icon name="folder" size={18} />
            Choose files
          </button>
          {r ? (
            <button type="button" className="btn primary" disabled={s.busy !== null || !s.selected.length} onClick={() => void confirmImport()}>
              <Icon name="download" size={18} />
              {confirmLabel}
            </button>
          ) : null}
        </>
      }
    >
      <input ref={file} type="file" accept="audio/*,video/*,.flac,.m4a,.opus" multiple hidden onChange={(e) => onFiles(e.target.files)} />
      <div
        className="import-drop"
        onDragOver={(e) => {
          if (e.dataTransfer.types.includes("Files")) {
            e.preventDefault();
            setDragging(true);
          }
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragging(false);
          onFiles(e.dataTransfer.files);
        }}
      >
        <form className={`import-search${s.busy === "resolve" ? " searching" : ""}`} onSubmit={(e) => { e.preventDefault(); void resolveImport(); }}>
          <Icon name={s.source.trim() && !/\s/.test(s.source.trim()) && /[./]/.test(s.source) ? "link" : "search"} size={20} />
          <input
            value={s.source}
            onChange={(e) => setImportSource(e.target.value)}
            placeholder="Link or music search"
            aria-label="Link or music search"
            aria-busy={s.busy === "resolve"}
            autoFocus
            spellCheck={false}
            disabled={importing}
          />
          <div className="segmented sm" role="radiogroup" aria-label="Download type">
            {(["audio", "video"] as const).map((k) => (
              <button
                key={k}
                type="button"
                role="radio"
                aria-checked={s.mediaKind === k}
                className={s.mediaKind === k ? "on" : ""}
                disabled={importing || (k === "video" && audioOnly)}
                title={k === "video" && audioOnly ? "Spotify and SoundCloud links import as audio" : undefined}
                onClick={() => setImportKind(k)}
              >
                <Icon name={k === "audio" ? "music" : "video"} size={15} />
                {k === "audio" ? "Audio" : "Video"}
              </button>
            ))}
          </div>
          <button type="submit" className="btn sm" disabled={!s.source.trim() || s.busy !== null || unavailable}>
            {s.busy === "resolve" ? <span className="spinner" /> : "Search"}
          </button>
        </form>

        {unavailable ? (
          <p className="import-error" role="alert">
            Web import needs Slopify's import service. Start the app with <code>npm run dev</code>, then reopen this dialog. You can still choose files.
          </p>
        ) : null}

        {s.busy ? (
          <div className="import-status" role="status">
            <span className="spinner" />
            <span className="import-status-text">{statusText(s)}</span>
            <button type="button" className="btn sm ghost" onClick={cancelImport}>Cancel</button>
          </div>
        ) : null}

        {s.error && !s.busy ? <p className="import-error" role="alert">{failureText(s.error)}</p> : null}

        {!r && !s.busy && !s.error && !unavailable ? (
          <div className="import-hint">
            <span className="empty-icon"><Icon name="download" size={26} /></span>
            <strong>Find a song to import</strong>
            <p className="muted small">Links resolve as soon as you paste them. Search checks Spotify, SoundCloud, and YouTube; preview a result before you download. You can also drop audio files here.</p>
          </div>
        ) : null}

        {s.busy === "resolve" ? (
          <div className="import-skeleton" aria-hidden="true">
            {Array.from({ length: 4 }, (_, i) => <div key={i} className="skeleton-row" style={{ animationDelay: `${i * 80}ms` }} />)}
          </div>
        ) : null}

        {r ? <Results s={s} r={r} /> : null}
      </div>
    </Shell>
  );
}
