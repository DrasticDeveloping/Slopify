import { useEffect, useRef, useState } from "react";
import { formatTime } from "../lib/format";
import { playList, togglePlay } from "../state/actions";
import { getState, useStore } from "../state/store";
import {
  canStream, cancelImport, failureText, getImport, isAudioOnlySource, isDownloadable, isPlaylist, PROVIDERS, providerLabel, registerStreams,
  saveSearchResults, searchDiscovery, searchMore, stageLabel, streamTrackId, useImport, type Candidate, type MediaKind, type Provider, type Resolution,
} from "../state/importer";
import { candidateSources, ownedIndex } from "../recommend/owned";
import { Icon } from "./Icon";

/** Waits this long after typing stops before searching. */
const DEBOUNCE = 650;

/** The platform a result is listed under. */
function platformFor(c: Candidate): Provider {
  if (c.searchProvider) return c.searchProvider;
  if (c.importMetadata?.provider === "spotify") return "spotify";
  if (c.importMetadata?.provider === "soundcloud" || c.sourceProvider === "soundcloud") return "soundcloud";
  return "youtube";
}
/** A stable song key for a result, so playing it again resumes the same streamed track. A video is its own track. */
const keyFor = (c: Candidate, kind: MediaKind = "audio") => `search:${platformFor(c)}:${c.sourceProvider}:${c.videoID || c.providerID || c.sourceURL}${kind === "video" ? ":video" : ""}`;
/** The same result however it was found: a video from YouTube Music and from YouTube is one result. */
const sameResult = (c: Candidate) => `${platformFor(c)}:${c.videoID || c.providerID || c.sourceURL}`;
const downloadable = (r: Resolution) => r.candidates.flatMap((c, i) => (isDownloadable(c) ? [i] : []));
const describe = (c: Candidate) => {
  const meta = c.importMetadata || c;
  return { meta, title: meta.title || c.title || "Untitled", artist: meta.artist || c.artist || "Unknown artist" };
};

/** Searches the music platforms for `query`, reusing a review the importer has already resolved for it. */
function usePlatformSearch(query: string, kind: MediaKind, attempt: number) {
  const [result, setResult] = useState<{ query: string; kind: MediaKind; resolution: Resolution } | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    const controller = new AbortController();
    const show = (resolution: Resolution) => {
      if (controller.signal.aborted) return;
      setResult({ query, kind, resolution });
      setLoading(false);
    };
    setLoading(true);
    setError("");
    setResult(null);
    // A suggestion sent here for review arrives already resolved, with its exact source.
    const transfer = getImport();
    if (!attempt && transfer.source === query && transfer.resolution?.mediaKind === kind) {
      show(transfer.resolution);
      return () => controller.abort();
    }
    const timer = window.setTimeout(() => {
      searchDiscovery(query, AbortSignal.any([controller.signal, AbortSignal.timeout(90_000)]), kind)
        .then(show)
        .catch((e: unknown) => {
          if (controller.signal.aborted) return;
          const message = e instanceof Error ? e.message : typeof e === "object" && e && "message" in e ? String(e.message) : "";
          setError(message || "Couldn't search music platforms. Try again.");
          setLoading(false);
        });
    }, DEBOUNCE);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [query, kind, attempt]);
  return { resolution: result?.query === query && result.kind === kind ? result.resolution : null, loading, error };
}

/** Pages in a row with nothing new before the search counts as finished. */
const DRY_PAGES = 2;

/**
 * The search's results plus further pages, fetched as the list is scrolled to
 * its end. Results already listed (the same video or track) aren't repeated.
 * A page with nothing new stops the automatic loading (so the list's end doesn't
 * keep searching); a second one in a row ends the search.
 */
function useMoreResults(first: Resolution | null, kind: MediaKind) {
  const [pages, setPages] = useState<{ base: Resolution | null; candidates: Candidate[]; more: string | null | undefined; dry: number }>({ base: null, candidates: [], more: undefined, dry: 0 });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const running = useRef<AbortController | null>(null);
  useEffect(() => {
    running.current?.abort();
    setPages({ base: first, candidates: [], more: first?.more, dry: 0 });
    setLoading(false);
    setError("");
  }, [first]);
  useEffect(() => () => running.current?.abort(), []);

  const current = pages.base === first ? pages : { base: first, candidates: [], more: first?.more, dry: 0 };
  const merged: Resolution | null = first ? { ...first, candidates: [...first.candidates, ...current.candidates], more: current.more } : null;
  const loadMore = () => {
    if (!first || !current.more || loading) return;
    const controller = new AbortController();
    running.current = controller;
    setLoading(true);
    setError("");
    searchMore(current.more, kind, AbortSignal.any([controller.signal, AbortSignal.timeout(60_000)]))
      .then((page) => {
        if (controller.signal.aborted) return;
        setPages((p) => {
          if (p.base !== first) return p;
          const seen = new Set([...first.candidates, ...p.candidates].map(sameResult));
          const fresh = page.candidates.filter((c) => {
            const key = sameResult(c);
            if (seen.has(key)) return false;
            seen.add(key);
            return true;
          });
          const dry = fresh.length ? 0 : p.dry + 1;
          return { base: first, candidates: [...p.candidates, ...fresh], more: dry >= DRY_PAGES ? null : page.more ?? null, dry };
        });
      })
      .catch((e: unknown) => {
        if (controller.signal.aborted) return;
        setError(typeof e === "object" && e && "message" in e ? String(e.message) : "Couldn't load more results.");
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
  };
  return { resolution: merged, loadMore, loadingMore: loading, moreError: error, hasMore: Boolean(current.more), stalled: current.dry > 0 };
}

/** Calls `onVisible` when the element scrolls near the visible part of the page. */
function useNearView(onVisible: () => void, active: boolean) {
  const ref = useRef<HTMLDivElement>(null);
  const callback = useRef(onVisible);
  callback.current = onVisible;
  useEffect(() => {
    const el = ref.current;
    if (!el || !active) return;
    const observer = new IntersectionObserver(([entry]) => entry.isIntersecting && callback.current(), { root: el.closest(".main-scroll"), rootMargin: "0px 0px 600px 0px" });
    observer.observe(el);
    return () => observer.disconnect();
  }, [active]);
  return ref;
}

/** Songs, videos and playlists from YouTube, Spotify and SoundCloud: play them in full, or save them to the library. */
export function ExternalSearch({ query }: { query: string }) {
  const transfer = useImport((s) => s);
  const [kind, setKind] = useState<MediaKind>("audio");
  const [attempt, setAttempt] = useState(0);
  const [provider, setProvider] = useState<"all" | Provider>("all");
  const [selected, setSelected] = useState<number[]>([]);
  const { resolution: first, loading, error } = usePlatformSearch(query, kind, attempt);
  const { resolution: r, loadMore, loadingMore, moreError, hasMore, stalled } = useMoreResults(first, kind);
  const paged = first?.kind === "search_results";
  // Re-armed after each page, so a short page that leaves the end still in view loads the next one too.
  // A page with nothing new waits to be asked, rather than searching again on its own.
  const sentinel = useNearView(loadMore, paged && hasMore && !loadingMore && !moreError && !stalled);
  const playlist = isPlaylist(r);
  const busy = transfer.busy === "import";

  useEffect(() => {
    if (isAudioOnlySource(query)) setKind("audio");
  }, [query]);
  // New results start unfiltered, with every song of a playlist selected.
  useEffect(() => {
    setProvider("all");
    setSelected(first && isPlaylist(first) ? downloadable(first) : []);
  }, [first]);

  const play = (c: Candidate) => {
    // A result you've saved plays your copy (a saved video plays as a video), not a second stream of it.
    const mine = ownedIndex(getState()).find({ sources: candidateSources(c) })[0];
    if (mine) {
      if (getState().currentId === mine) return togglePlay();
      return playList([mine], mine, { label: `Search: ${query}`, route: { name: "search", q: query } });
    }
    const key = keyFor(c, kind);
    const id = streamTrackId(key);
    if (getState().currentId === id) return togglePlay();
    const { title, artist } = describe(c);
    registerStreams([{ key, candidate: c, title, artist, artwork: c.importMetadata?.artworkURL || c.thumbnailURL || undefined, kind: "discover-search", ...(kind === "video" ? { video: platformFor(c) === "youtube" } : {}) }]);
    playList([id], id, { label: `Search: ${query}`, route: { name: "search", q: query } });
  };

  // A single song's sources all describe that one song.
  const results = (r?.candidates ?? [])
    .map((c, index) => ({ c: !c.importMetadata && r!.kind !== "search_results" && !playlist ? { ...c, importMetadata: r!.track } : c, index }))
    .filter(({ c }) => provider === "all" || platformFor(c) === provider);
  const topPlatform = results[0] ? platformFor(results[0].c) : null;
  const row = ({ c, index }: { c: Candidate; index: number }) => (
    <OnlineResult
      key={`${keyFor(c)}:${index}`}
      candidate={c}
      kind={kind}
      playlist={playlist}
      featured={!playlist && index === results[0]?.index}
      busy={busy}
      selected={selected.includes(index)}
      onSelect={() => setSelected(selected.includes(index) ? selected.filter((n) => n !== index) : [...selected, index])}
      onPlay={() => play(c)}
      onSave={() => void saveSearchResults(query, r!, [index])}
    />
  );

  return (
    <section className="external-search" aria-label="Music from external platforms">
      <div className="section-head">
        <div>
          <h2 className="section-title">Find music online</h2>
          <p className="muted small">Search YouTube, Spotify and SoundCloud, or paste a song or playlist link.</p>
        </div>
        <div className="segmented sm" role="group" aria-label="Search media type">
          {(["audio", "video"] as const).map((k) => (
            <button key={k} type="button" className={kind === k ? "on" : ""} aria-pressed={kind === k} disabled={k === "video" && isAudioOnlySource(query)} onClick={() => setKind(k)}>
              {k === "audio" ? "Songs" : "Videos"}
            </button>
          ))}
        </div>
      </div>
      {busy ? (
        <div className="import-status" role="status">
          <span className="spinner" />
          <span>{stageLabel(transfer.stage)} — {transfer.transferName}</span>
          <button type="button" className="btn ghost sm" onClick={cancelImport}>Cancel download</button>
        </div>
      ) : null}
      {transfer.error && !busy && transfer.source === query ? <p className="import-error" role="alert">{failureText(transfer.error)}</p> : null}
      {loading ? <p className="muted search-progress" role="status"><span className="spinner" />Searching music platforms…</p> : null}
      {error ? (
        <p className="import-error" role="alert">
          {error} <button type="button" className="text-btn" onClick={() => setAttempt((n) => n + 1)}>Retry</button>
        </p>
      ) : null}
      {r ? (
        <>
          {r.playlist ? <h3>{r.playlist.title || "Playlist"}{r.playlist.truncated ? " (first 500 songs)" : ""}</h3> : null}
          {r.playlist?.unavailableCount ? <p className="muted small">{r.playlist.unavailableCount} songs unavailable from this playlist.</p> : null}
          {r.unavailableProviders?.length ? <p className="muted small">{r.unavailableProviders.map((p) => ({ spotify: "Spotify", soundcloud: "SoundCloud", youtube: "YouTube" })[p] ?? p).join(" and ")} search isn't responding right now, so these results come from the others.</p> : null}
          {kind === "video" ? <p className="muted small">YouTube results play and save as videos. SoundCloud and Spotify have no video, so theirs play as audio.</p> : null}
          {r.kind === "search_results" ? <ProviderFilter resolution={r} value={provider} onChange={setProvider} /> : null}
          {playlist ? (
            <>
              <div className="search-playlist-actions">
                <button type="button" className="text-btn" disabled={busy} onClick={() => setSelected(selected.length ? [] : downloadable(r))}>{selected.length ? "Select none" : "Select all"}</button>
                <button type="button" className="btn primary" disabled={busy || !selected.length} onClick={() => void saveSearchResults(query, r, selected)}>Save {selected.length} songs</button>
              </div>
              <div className="online-song-list">{results.map(row)}</div>
            </>
          ) : (
            // One section per platform, the top result's platform first.
            [...PROVIDERS].sort(([a], [b]) => Number(b === topPlatform) - Number(a === topPlatform)).map(([p, name]) => {
              const songs = results.filter(({ c }) => platformFor(c) === p);
              if (!songs.length) return null;
              return (
                <section className="online-platform" key={p} aria-label={`${name} results`}>
                  <h3><span className={`prov-dot ${p}`} aria-hidden="true" />{name}</h3>
                  <div className={`online-song-list${p === "youtube" ? " youtube-grid" : ""}`}>{songs.map(row)}</div>
                </section>
              );
            })
          )}
          {!r.candidates.length ? <p className="muted">No online results for “{query}”. Try another song or artist.</p> : null}
          {paged && r.candidates.length ? (
            <div ref={sentinel} className="search-more" role="status">
              {loadingMore ? <p className="muted search-progress"><span className="spinner" />Finding more results…</p> : null}
              {moreError ? <p className="muted">{moreError} <button type="button" className="text-btn" onClick={loadMore}>Try again</button></p> : null}
              {hasMore && stalled && !loadingMore && !moreError ? (
                <p className="muted small">No new results on the last page. <button type="button" className="text-btn" onClick={loadMore}>Search further</button></p>
              ) : null}
              {!hasMore && !loadingMore ? <p className="muted small">That's everything for “{query}”.</p> : null}
            </div>
          ) : null}
        </>
      ) : null}
    </section>
  );
}

function ProviderFilter({ resolution: r, value, onChange }: { resolution: Resolution; value: "all" | Provider; onChange: (p: "all" | Provider) => void }) {
  const count = (p: "all" | Provider) => (p === "all" ? r.candidates.length : r.candidates.filter((c) => c.searchProvider === p).length);
  const options: Array<["all" | Provider, string]> = [["all", "All platforms"], ...PROVIDERS.filter(([p]) => count(p) > 0)];
  return (
    <div className="provider-pill" role="group" aria-label="Search platforms">
      {options.map(([p, label]) => (
        <button type="button" key={p} className={value === p ? "on" : ""} aria-pressed={value === p} onClick={() => onChange(p)} onFocus={(e) => e.currentTarget.scrollIntoView({ block: "nearest", inline: "nearest" })}>
          <span className={`prov-dot ${p}`} aria-hidden="true" />
          {label}
          <small>{count(p)}</small>
        </button>
      ))}
    </div>
  );
}

interface ResultProps {
  candidate: Candidate;
  kind: MediaKind;
  playlist: boolean;
  featured: boolean;
  busy: boolean;
  selected: boolean;
  onSelect: () => void;
  onPlay: () => void;
  onSave: () => void;
}

/** One search result. YouTube shows video thumbnails and channels; SoundCloud leads with the uploader. */
function OnlineResult({ candidate: c, kind, playlist, featured, busy, selected, onSelect, onPlay, onSave }: ResultProps) {
  // Your saved copy, when you have this result (it's what plays).
  const mine = useStore((s) => ownedIndex(s).find({ sources: candidateSources(c) })[0]);
  const id = mine ?? streamTrackId(keyFor(c, kind));
  const active = useStore((s) => s.currentId === id);
  const playing = useStore((s) => s.isPlaying) && active;
  const buffering = useStore((s) => s.buffering === id);
  const { meta, title, artist } = describe(c);
  const platform = platformFor(c);
  const youtube = platform === "youtube" && !playlist;
  const soundcloud = platform === "soundcloud" && !playlist;
  const source = c.importMetadata?.sourceURL || c.sourcePageURL || c.sourceURL;
  const avatar = c.importMetadata?.creatorAvatarURL || (platform === "youtube" ? c.creatorAvatarURL : undefined) || undefined;
  const cover = (youtube ? c.videoThumbnailURL || c.thumbnailURL || c.importMetadata?.artworkURL : c.importMetadata?.artworkURL || c.thumbnailURL) || undefined;
  const label = `${playing ? "Pause" : "Play"} ${title}`;
  const creator = <div className="online-creator"><CreatorAvatar name={artist} url={avatar} /><span>{artist}</span></div>;
  const playable = canStream(c);

  return (
    <article className={`online-song ${playlist ? "playlist-song" : platform}${featured ? " featured" : ""}${active ? " current" : ""}`}>
      {featured ? <span className="online-top-label">Top result</span> : null}
      {playlist ? <input type="checkbox" aria-label={`Select ${title}`} checked={selected} disabled={busy || !isDownloadable(c)} onChange={onSelect} /> : null}
      <button type="button" className="online-play" aria-label={label} disabled={!playable} onClick={onPlay}>
        <SearchCover url={cover} />
        {buffering ? <span className="spinner" /> : <Icon name={playing ? "pause" : "play"} size={featured ? 28 : 20} />}
        {youtube && meta.durationSeconds ? <span className="online-duration">{formatTime(meta.durationSeconds)}</span> : null}
      </button>
      <div className="online-info">
        {soundcloud ? creator : null}
        <button type="button" className="online-title" aria-label={label} disabled={!playable} onClick={onPlay}>{title}</button>
        {youtube ? creator : (
          <span className="t-sub">
            {soundcloud ? providerLabel(c) : artist}
            {meta.album ? ` · ${meta.album}` : ""}
            {meta.durationSeconds ? ` · ${formatTime(meta.durationSeconds)}` : ""}
          </span>
        )}
        {c.requiresReview ? (
          <span className="online-review">
            Matched upload: <a href={c.sourceURL} target="_blank" rel="noreferrer">{c.title}{c.artist ? ` · ${c.artist}` : ""}</a>. Listen before saving.
          </span>
        ) : null}
      </div>
      <div className="online-actions">
        {source ? <a className="icon-btn sm" href={source} target="_blank" rel="noreferrer" aria-label={`Open source for ${title}`} title="Open source"><Icon name="link" size={17} /></a> : null}
        {!playlist ? (
          <button type="button" className="btn sm" disabled={busy || !isDownloadable(c)} onClick={onSave} aria-label={`Save ${title}${kind === "video" ? " video" : ""}`}>
            <Icon name="plus" size={16} />
            Save{kind === "video" ? " video" : ""}
          </button>
        ) : null}
      </div>
    </article>
  );
}

/** Whether to show `url`: until it fails to load. */
function useImage(url: string | undefined) {
  const [failed, setFailed] = useState<string | null>(null);
  return { show: Boolean(url) && failed !== url, onError: () => setFailed(url ?? null) };
}

function CreatorAvatar({ name, url }: { name: string; url?: string }) {
  const image = useImage(url);
  const initials = name.trim().split(/\s+/).slice(0, 2).map((w) => w[0]).join("");
  return <span className="online-avatar" aria-hidden="true">{image.show ? <img src={url} alt="" loading="lazy" referrerPolicy="no-referrer" onError={image.onError} /> : initials}</span>;
}

function SearchCover({ url }: { url?: string }) {
  const image = useImage(url);
  return <span className="search-cover">{image.show ? <img src={url} alt="" loading="lazy" referrerPolicy="no-referrer" onError={image.onError} /> : <Icon name="music" size={22} />}</span>;
}
