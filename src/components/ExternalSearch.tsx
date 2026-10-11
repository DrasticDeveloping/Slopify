import { useEffect, useState } from "react";
import { formatTime } from "../lib/format";
import { playList, togglePlay } from "../state/actions";
import { useStore } from "../state/store";
import { canStream, cancelImport, failureText, isAudioOnlySource, isDownloadable, isPlaylist, PROVIDERS, providerLabel, registerStreams, saveSearchResults, searchDiscovery, stageLabel, streamTrackId, useImport, type Candidate, type MediaKind, type Resolution } from "../state/importer";
import { Icon } from "./Icon";

const platformFor = (c: Candidate) => c.searchProvider || (c.importMetadata?.provider === "spotify" ? "spotify" : c.importMetadata?.provider === "soundcloud" || c.sourceProvider === "soundcloud" ? "soundcloud" : "youtube");
const keyFor = (c: Candidate) => `search:${platformFor(c)}:${c.sourceProvider}:${c.videoID || c.providerID || c.sourceURL}`;

export function ExternalSearch({ query }: { query: string }) {
  const transfer = useImport((s) => s);
  const [kind, setKind] = useState<MediaKind>("audio");
  const [result, setResult] = useState<{ query: string; kind: MediaKind; resolution: Resolution } | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [retry, setRetry] = useState(0);
  const [provider, setProvider] = useState("all");
  const [selected, setSelected] = useState<number[]>([]);
  const currentId = useStore((s) => s.currentId);
  const playing = useStore((s) => s.isPlaying);
  const buffering = useStore((s) => s.buffering);
  useEffect(() => { if (isAudioOnlySource(query)) setKind("audio"); }, [query]);
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true); setError(""); setResult(null); setProvider("all"); setSelected([]);
    const apply = (resolution: Resolution) => {
      if (controller.signal.aborted) return;
      setResult({ query, kind, resolution });
      setSelected(isPlaylist(resolution) ? resolution.candidates.map((c, i) => isDownloadable(c) ? i : -1).filter((i) => i >= 0) : []);
      setLoading(false);
    };
    // Suggestions requiring review arrive here already resolved, with their exact source.
    if (!retry && transfer.source === query && transfer.resolution?.mediaKind === kind) {
      apply(transfer.resolution);
      return () => controller.abort();
    }
    const timer = window.setTimeout(() => {
      void searchDiscovery(query, AbortSignal.any([controller.signal, AbortSignal.timeout(90_000)]), kind).then(apply).catch((e: unknown) => {
        if (controller.signal.aborted) return;
        setError(e instanceof Error ? e.message : typeof e === "object" && e && "message" in e ? String(e.message) : "Couldn't search music platforms. Try again.");
        setLoading(false);
      });
    }, 650);
    return () => { window.clearTimeout(timer); controller.abort(); };
  // Transfer updates must not restart an independent search or replace its results.
  }, [query, kind, retry]);
  const r = result?.query === query && result.kind === kind ? result.resolution : null;
  const playlist = isPlaylist(r);
  const busy = transfer.busy === "import";
  const play = (c: Candidate) => {
    const key = keyFor(c);
    const id = streamTrackId(key);
    if (currentId === id) { togglePlay(); return; }
    registerStreams([{ key, candidate: c, title: c.importMetadata?.title || c.title || "Untitled", artist: c.importMetadata?.artist || c.artist || "Unknown artist", artwork: c.importMetadata?.artworkURL || c.thumbnailURL || undefined, kind: "discover-search" }]);
    playList([id], id, { label: `Search: ${query}`, route: { name: "search", q: query } });
  };
  const visible = r?.candidates.map((c, i) => ({ c: !c.importMetadata && r.kind !== "search_results" && !playlist ? { ...c, importMetadata: r.track } : c, i })).filter(({ c }) => provider === "all" || platformFor(c) === provider) || [];
  const topIndex = !playlist ? visible[0]?.i : undefined;
  const topPlatform = visible[0] ? platformFor(visible[0].c) : null;
  const renderResult = ({ c, i }: { c: Candidate; i: number }) => {
    if (!r) return null;
    const meta = c.importMetadata || c;
    const title = meta.title || c.title || "Untitled";
    const artist = meta.artist || c.artist || "Unknown artist";
    const platform = platformFor(c);
    const active = currentId === streamTrackId(keyFor(c));
    const isPlaying = active && playing;
    const playable = canStream(c);
    const featured = i === topIndex;
    const source = c.importMetadata?.sourceURL || c.sourcePageURL || c.sourceURL;
    const avatar = c.importMetadata?.creatorAvatarURL || (platform === "youtube" ? c.creatorAvatarURL : undefined);
    const label = `${isPlaying ? "Pause" : "Play"} ${kind === "video" ? "audio for " : ""}${title}`;
    return <article className={`online-song ${playlist ? "playlist-song" : platform}${featured ? " featured" : ""}${active ? " current" : ""}`} key={`${keyFor(c)}:${i}`}>
      {featured ? <span className="online-top-label">Top result</span> : null}
      {playlist ? <input type="checkbox" aria-label={`Select ${title}`} checked={selected.includes(i)} disabled={busy || !isDownloadable(c)} onChange={() => setSelected(selected.includes(i) ? selected.filter((n) => n !== i) : [...selected, i])} /> : null}
      <button type="button" className="online-play" aria-label={label} disabled={!playable} onClick={() => play(c)}>
        <SearchCover url={platform === "youtube" && !playlist ? c.videoThumbnailURL || c.thumbnailURL || c.importMetadata?.artworkURL || undefined : c.importMetadata?.artworkURL || c.thumbnailURL || undefined} />
        {active && buffering ? <span className="spinner" /> : <Icon name={isPlaying ? "pause" : "play"} size={featured ? 28 : 20} />}
        {platform === "youtube" && !playlist && meta.durationSeconds ? <span className="online-duration">{formatTime(meta.durationSeconds)}</span> : null}
      </button>
      <div className="online-info">
        {platform === "soundcloud" && !playlist ? <div className="online-creator"><CreatorAvatar name={artist} url={avatar || undefined} /><span>{artist}</span></div> : null}
        <button type="button" className="online-title" aria-label={label} disabled={!playable} onClick={() => play(c)}>{title}</button>
        {platform === "youtube" && !playlist ? <div className="online-creator"><CreatorAvatar name={artist} url={avatar || undefined} /><span>{artist}</span></div> : <span className="t-sub">{platform === "soundcloud" && !playlist ? providerLabel(c) : artist}{meta.album ? ` · ${meta.album}` : ""}{meta.durationSeconds ? ` · ${formatTime(meta.durationSeconds)}` : ""}</span>}
        {c.requiresReview ? <span className="online-review">Matched upload: <a href={c.sourceURL} target="_blank" rel="noreferrer">{c.title}{c.artist ? ` · ${c.artist}` : ""}</a>. Listen before saving.</span> : null}
      </div>
      <div className="online-actions">
        {source ? <a className="icon-btn sm" href={source} target="_blank" rel="noreferrer" aria-label={`Open source for ${title}`} title="Open source"><Icon name="link" size={17} /></a> : null}
        {!playlist ? <button type="button" className="btn sm" disabled={busy || !isDownloadable(c)} onClick={() => void saveSearchResults(query, r, [i])} aria-label={`Save ${title}${kind === "video" ? " video" : ""}`}><Icon name="plus" size={16} />Save{kind === "video" ? " video" : ""}</button> : null}
      </div>
    </article>;
  };
  return <section className="external-search" aria-label="Music from external platforms">
    <div className="section-head"><div><h2 className="section-title">Find music online</h2><p className="muted small">Search YouTube, Spotify and SoundCloud, or paste a song or playlist link.</p></div>
      <div className="segmented sm" role="group" aria-label="Search media type">{(["audio", "video"] as const).map((k) => <button key={k} type="button" className={kind === k ? "on" : ""} aria-pressed={kind === k} disabled={k === "video" && isAudioOnlySource(query)} onClick={() => setKind(k)}>{k === "audio" ? "Songs" : "Videos"}</button>)}</div>
    </div>
    {busy ? <div className="import-status" role="status"><span className="spinner" /><span>{stageLabel(transfer.stage)} — {transfer.transferName}</span><button type="button" className="btn ghost sm" onClick={cancelImport}>Cancel download</button></div> : null}
    {transfer.error && !busy && transfer.source === query ? <p className="import-error" role="alert">{failureText(transfer.error)}</p> : null}
    {loading ? <p className="muted search-progress" role="status"><span className="spinner" />Searching music platforms…</p> : null}
    {error ? <p className="import-error" role="alert">{error} <button type="button" className="text-btn" onClick={() => setRetry((n) => n + 1)}>Retry</button></p> : null}
    {r ? <>
      {r.playlist ? <h3>{r.playlist.title || "Playlist"}{r.playlist.truncated ? " (first 500 songs)" : ""}</h3> : null}
      {r.playlist?.unavailableCount ? <p className="muted small">{r.playlist.unavailableCount} songs unavailable from this playlist.</p> : null}
      {r.unavailableProviders?.length ? <p className="muted small">{r.unavailableProviders.join(", ")} search is temporarily unavailable.</p> : null}
      {kind === "video" ? <p className="muted small">Play a result to hear its audio. Save video downloads the video.</p> : null}
      {r.kind === "search_results" ? (
        <div className="provider-pill" role="group" aria-label="Search platforms">
          {[["all", "All platforms"], ...PROVIDERS].filter(([p]) => p === "all" || r.candidates.some((c) => c.searchProvider === p)).map(([p, label]) => (
            <button type="button" key={p} className={provider === p ? "on" : ""} aria-pressed={provider === p} onClick={() => setProvider(p)} onFocus={(e) => e.currentTarget.scrollIntoView({ block: "nearest", inline: "nearest" })}>
              <span className={`prov-dot ${p}`} aria-hidden="true" />
              {label}
              <small>{p === "all" ? r.candidates.length : r.candidates.filter((c) => c.searchProvider === p).length}</small>
            </button>
          ))}
        </div>
      ) : null}
      {playlist ? <div className="search-playlist-actions"><button type="button" className="text-btn" disabled={busy} onClick={() => setSelected(selected.length ? [] : r.candidates.map((c, i) => isDownloadable(c) ? i : -1).filter((i) => i >= 0))}>{selected.length ? "Select none" : "Select all"}</button><button type="button" className="btn primary" disabled={busy || !selected.length} onClick={() => void saveSearchResults(query, r, selected)}>Save {selected.length} songs</button></div> : null}
      {playlist ? <div className="online-song-list">{visible.map(renderResult)}</div> : [...PROVIDERS].sort(([a], [b]) => Number(b === topPlatform) - Number(a === topPlatform)).map(([p, name]) => {
        const songs = visible.filter(({ c }) => platformFor(c) === p);
        return songs.length ? <section className="online-platform" key={p} aria-label={`${name} results`}><h3><span className={`prov-dot ${p}`} aria-hidden="true" />{name}</h3><div className={`online-song-list ${p === "youtube" ? "youtube-grid" : ""}`}>{songs.map(renderResult)}</div></section> : null;
      })}
      {!r.candidates.length ? <p className="muted">No online results for “{query}”. Try another song or artist.</p> : null}
    </> : null}
  </section>;
}

function CreatorAvatar({ name, url }: { name: string; url?: string }) {
  const [failed, setFailed] = useState<string | null>(null);
  return <span className="online-avatar" aria-hidden="true">{url && failed !== url ? <img src={url} alt="" loading="lazy" referrerPolicy="no-referrer" onError={() => setFailed(url)} /> : name.trim().split(/\s+/).slice(0, 2).map((w) => w[0]).join("")}</span>;
}

function SearchCover({ url }: { url?: string }) {
  const [failed, setFailed] = useState<string | null>(null);
  return <span className="search-cover">{url && failed !== url ? <img src={url} alt="" loading="lazy" referrerPolicy="no-referrer" onError={() => setFailed(url)} /> : <Icon name="music" size={22} />}</span>;
}
