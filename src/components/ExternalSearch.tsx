import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type MouseEvent } from "react";
import { openSearchResultMenu, openTrackMenu } from "../lib/menus";
import { formatTime } from "../lib/format";
import { navigate, playList, togglePlay } from "../state/actions";
import { getState, useStore } from "../state/store";
import {
  askToSavePlaylist, canStream, cancelImport, failureText, getImport, inputIsLink, isAudioOnlySource, spotifySongLinks, type PlaylistFollow, isDownloadable, isPlaylist, PROVIDERS, providerLabel, registerStreams,
  playlistOwnedTrack, resultPlatform, resultStreamKey, saveSearchResults, searchDiscovery, showTransferInline, stageLabel, streamTrackId, useImport, type Candidate, type ImportState, type MediaKind,
  type PlaylistSaveOptions, type PlaylistSaved, type Provider, type Resolution,
} from "../state/importer";
import { candidateSources, ownedIndex } from "../recommend/owned";
import { searchTyped, searchTypedMore } from "../recommend/service";
import { TrackArt } from "./Artwork";
import { Icon } from "./Icon";

/** Waits this long after typing stops before searching. */
const DEBOUNCE = 650;

/** The platform a result is listed under. */
const platformFor = resultPlatform;
/** A stable song key for a result (shared with playlists made of streamed songs), so playing it again resumes the same streamed track. */
const keyFor = resultStreamKey;
/** The same result however it was found: a video from YouTube Music and from YouTube is one result. */
const sameResult = (c: Candidate) => `${platformFor(c)}:${c.videoID || c.providerID || c.sourceURL}`;
const downloadable = (r: Resolution) => r.candidates.flatMap((c, i) => (isDownloadable(c) ? [i] : []));
const countSongs = (n: number) => `${n} song${n === 1 ? "" : "s"}`;
/** A playlist song matched only as its artist's upload of the same length (its title in another language): left unticked. */
const unsure = (c: Candidate | undefined) => Boolean(c?.match?.byArtistAndLength);
const describe = (c: Candidate) => {
  const meta = c.importMetadata || c;
  return { meta, title: meta.title || c.title || "Untitled", artist: meta.artist || c.artist || "Unknown artist" };
};

/** A search or link that hasn't sent anything back for this long has stalled. A playlist sends a line per song. */
const IDLE_TIMEOUT = 90_000;

/**
 * A pasted link being resolved. It isn't tied to the Search page: a playlist takes minutes to match (one YouTube
 * search every few seconds), so it keeps going when the page closes, and coming back to the same link shows it where
 * it got to. The few most recent are kept; an older one still running is stopped when it's dropped, and pasting
 * another playlist stops one still matching, so only one playlist searches YouTube at a time.
 */
interface LinkLookup {
  attempt: number;
  playlist: boolean;
  resolution: Resolution | null;
  /** Songs pasted from Spotify whose details are being read, before matching starts. */
  reading: { completed: number; total: number } | null;
  error: string;
  done: boolean;
  controller: AbortController;
  listeners: Set<() => void>;
  version: number;
}
const lookups = new Map<string, LinkLookup>();
const MAX_LOOKUPS = 4;
const lookupKey = (query: string, kind: MediaKind) => `${kind}:${query.trim()}`;
/** Links that name a list of songs rather than one. */
const looksLikePlaylist = (link: string) =>
  /open\.spotify\.com\/(?:intl-[a-z-]+\/)?(?:playlist|album)\/|soundcloud\.com\/[^/]+\/sets\/|[?&]list=/i.test(link) || spotifySongLinks(link).length > 1;

function startLookup(query: string, kind: MediaKind, attempt: number): LinkLookup {
  const key = lookupKey(query, kind);
  const playlist = looksLikePlaylist(query);
  const stop = (k: string, other: LinkLookup) => {
    if (!other.done) other.controller.abort();
    lookups.delete(k);
  };
  for (const [k, other] of lookups) if (k === key || (playlist && other.playlist && !other.done)) stop(k, other);
  const lookup: LinkLookup = { attempt, playlist, resolution: null, reading: null, error: "", done: false, controller: new AbortController(), listeners: new Set(), version: 0 };
  lookups.set(key, lookup);
  for (const [k, other] of lookups) if (lookups.size > MAX_LOOKUPS) stop(k, other);
  const changed = (patch: Partial<LinkLookup>) => {
    Object.assign(lookup, patch);
    lookup.version += 1;
    for (const listener of lookup.listeners) listener();
  };
  // Only silence times out: a playlist sends a line per song.
  const idle = new AbortController();
  let idleTimer = 0;
  const touch = () => {
    window.clearTimeout(idleTimer);
    idleTimer = window.setTimeout(() => idle.abort(new DOMException("The search took too long.", "TimeoutError")), IDLE_TIMEOUT);
  };
  touch();
  searchDiscovery(query, AbortSignal.any([lookup.controller.signal, idle.signal]), kind, false, {
    onPartial: (partial) => {
      touch();
      changed({ resolution: partial, reading: null });
    },
    onReading: (reading) => {
      touch();
      changed({ reading });
    },
  })
    .then((resolution) => changed({ resolution, done: true }))
    .catch((e: unknown) => {
      if (lookup.controller.signal.aborted) return;
      const message = idle.signal.aborted ? "The search took too long." : e instanceof Error ? e.message : typeof e === "object" && e && "message" in e ? String(e.message) : "";
      // A playlist that stopped part way keeps the songs it had; their matching just isn't going on any more.
      const kept = lookup.resolution?.matching ? { ...lookup.resolution, matching: undefined } : lookup.resolution;
      changed({ error: message || "Couldn't search music platforms. Try again.", done: true, resolution: kept });
    })
    .finally(() => window.clearTimeout(idleTimer));
  return lookup;
}

/** The lookup for a pasted link: the one already going or done (unless it failed, or Retry asks again), else a new one. */
function useLinkLookup(query: string, kind: MediaKind, attempt: number, enabled: boolean) {
  const [lookup, setLookup] = useState<LinkLookup | null>(null);
  useEffect(() => {
    if (!enabled) {
      setLookup(null);
      return;
    }
    const known = lookups.get(lookupKey(query, kind));
    // A finished playlist with songs YouTube didn't answer for is asked again (what it found comes back from the
    // server's memory), so pasting it again retries them.
    const retry = known?.done && (Boolean(known.resolution?.playlist?.unreadCount) || known.resolution?.candidates.some((c) => c.unmatched === "search_failed" || c.unmatched === "unread"));
    if (known && !known.error && !retry && (attempt === 0 || known.attempt === attempt)) {
      setLookup(known);
      return;
    }
    setLookup(null);
    const timer = window.setTimeout(() => setLookup(startLookup(query, kind, attempt)), DEBOUNCE);
    return () => window.clearTimeout(timer);
  }, [query, kind, attempt, enabled]);
  useSyncExternalStore(
    useCallback((onChange: () => void) => {
      if (!lookup) return () => undefined;
      lookup.listeners.add(onChange);
      return () => lookup.listeners.delete(onChange);
    }, [lookup]),
    () => lookup?.version ?? -1,
  );
  return lookup;
}

/**
 * A save that keeps up with a playlist still being matched (see PlaylistFollow): each song found from now on is
 * saved too if `wanted` says so when it's found (ticked, with a source, and not already in the library). `queued`:
 * rows already being saved.
 */
function followLookup(lookup: LinkLookup, wanted: { current: (at: number) => boolean }, queued: Set<number>): PlaylistFollow {
  return {
    latest: () => lookup.resolution!,
    async next(signal) {
      for (;;) {
        signal.throwIfAborted();
        const fresh = (lookup.resolution?.candidates ?? []).flatMap((candidate, at) => (!queued.has(at) && wanted.current(at) ? [{ at, candidate }] : []));
        if (fresh.length) {
          for (const { at } of fresh) queued.add(at);
          return fresh;
        }
        // Matching over (or stopped): nothing more is coming.
        if (lookup.done || lookup.controller.signal.aborted || !lookup.resolution?.matching) return null;
        await new Promise<void>((resolve, reject) => {
          const changed = () => {
            lookup.listeners.delete(changed);
            signal.removeEventListener("abort", stop);
            resolve();
          };
          const stop = () => {
            lookup.listeners.delete(changed);
            reject(signal.reason);
          };
          lookup.listeners.add(changed);
          signal.addEventListener("abort", stop, { once: true });
        });
      }
    },
  };
}

/**
 * Searches the music platforms for `query`, reusing a review the importer has already resolved for it.
 * A playlist link's songs show as they are matched (`resolution.matching` is set until they all are).
 */
function usePlatformSearch(query: string, kind: MediaKind, attempt: number) {
  const [result, setResult] = useState<{ query: string; kind: MediaKind; resolution: Resolution } | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  // A suggestion sent here for review arrives already resolved, with its exact source. Decided on arrival only:
  // saving songs from these results also leaves them in the importer, and that's no reason to stop following them.
  // A link already being looked up here is followed instead.
  const reviewing = useMemo(() => {
    const transfer = getImport();
    const known = lookups.get(lookupKey(query, kind));
    return !attempt && transfer.source === query && transfer.resolution?.mediaKind === kind && !(known && !known.error);
  }, [query, kind, attempt]);
  const link = inputIsLink(query) && !reviewing;
  const lookup = useLinkLookup(query, kind, attempt, link);
  useEffect(() => {
    if (link) return;
    const controller = new AbortController();
    const show = (resolution: Resolution) => {
      if (controller.signal.aborted) return;
      setResult({ query, kind, resolution });
      setLoading(false);
    };
    setLoading(true);
    setError("");
    setResult(null);
    if (reviewing) {
      show(getImport().resolution!);
      return () => controller.abort();
    }
    const timer = window.setTimeout(() => {
      searchTyped(query, AbortSignal.any([controller.signal, AbortSignal.timeout(IDLE_TIMEOUT)]), kind)
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
    // `reviewing` follows from these.
  }, [query, kind, attempt, link]);
  if (link) return { lookup, resolution: lookup?.resolution ?? null, reading: lookup?.reading ?? null, loading: !lookup?.done, error: lookup?.error ?? "" };
  return { lookup: null, resolution: result?.query === query && result.kind === kind ? result.resolution : null, reading: null, loading, error };
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
    searchTypedMore(current.more, AbortSignal.any([controller.signal, AbortSignal.timeout(60_000)]), kind)
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
  /**
   * Which playlist songs are ticked, ones still arriving included: at first every song with a source except those
   * matched only by artist and length (`unsure`), after "Select all" every one, after "Select none" none; `except`
   * flips single songs from that.
   */
  const [ticks, setTicks] = useState<{ mode: "default" | "all" | "none"; except: number[] }>({ mode: "default", except: [] });
  const { lookup, resolution: first, reading, loading, error } = usePlatformSearch(query, kind, attempt);
  const { resolution: r, loadMore, loadingMore, moreError, hasMore, stalled } = useMoreResults(first, kind);
  const paged = first?.kind === "search_results";
  // Re-armed after each page, so a short page that leaves the end still in view loads the next one too.
  // A page with nothing new waits to be asked, rather than searching again on its own.
  const sentinel = useNearView(loadMore, paged && hasMore && !loadingMore && !moreError && !stalled);
  const playlist = isPlaylist(r);
  const busy = transfer.busy === "import";
  const matching = r?.matching;
  // A playlist's songs already in the library: listed apart, never offered for saving again.
  const tracks = useStore((s) => s.tracks);
  const artists = useStore((s) => s.artists);
  const ownedIds = useMemo(() => (playlist && r ? r.candidates.map((c) => playlistOwnedTrack(c, r.mediaKind, { tracks, artists })) : []), [playlist, r, tracks, artists]);
  const ownedAt = (index: number) => ownedIds[index];
  const tickedFirst = (i: number) => (ticks.mode === "default" ? !unsure(r!.candidates[i]) : ticks.mode === "all");
  /** Whether a row is ticked now; a song still being found shows the tick it'll be saved with. */
  const tickedNow = (i: number) => tickedFirst(i) !== ticks.except.includes(i);
  const selected = playlist && r ? downloadable(r).filter((i) => !ownedAt(i) && tickedFirst(i) !== ticks.except.includes(i)) : [];
  // Whether a song found later should be saved by a save that's following the matching: as ticked now.
  const wanted = useRef<(at: number) => boolean>(() => false);
  wanted.current = (at) => {
    const c = lookup?.resolution?.candidates[at];
    if (!c || !isDownloadable(c) || playlistOwnedTrack(c, kind)) return false;
    return (ticks.mode === "default" ? !unsure(c) : ticks.mode === "all") !== ticks.except.includes(at);
  };
  /** Saves the ticked songs (as asked: in a playlist or not); while matching, keeps saving the songs found after them too. */
  const saveNow = (options: PlaylistSaveOptions) => {
    if (!r) return;
    const follow = matching && lookup ? followLookup(lookup, wanted, new Set(selected)) : undefined;
    void saveSearchResults(query, r, selected, follow, options);
  };
  // The dialog answers after this render: it starts whatever save this page holds by then (more songs may be found).
  const saveRef = useRef(saveNow);
  saveRef.current = saveNow;
  const save = () => askToSavePlaylist(
    { count: toSave, owned: ownedIds.filter(Boolean).length, name: playlistTitle, matching: Boolean(matching) },
    (options) => saveRef.current(options),
  );
  // Songs YouTube kept turning away: searched again on request (the ones found come back from the server's memory).
  const failed = playlist && r ? r.candidates.filter((c) => c.unmatched === "search_failed").length : 0;
  const unread = playlist && r ? (r.playlist?.unreadCount ?? 0) + r.candidates.filter((c) => c.unmatched === "unread").length : 0;
  /**
   * How far a playlist's matching has got: songs found, found but worth a listen first (`check`: matched by artist
   * and length only, so left unticked), already saved, not found, and still being read or searched for.
   */
  const stats = { total: 0, found: 0, check: 0, owned: 0, missing: 0, waiting: 0, waitingTicked: 0, local: 0, toCheck: [] as number[] };
  if (playlist && r) {
    r.candidates.forEach((c, i) => {
      stats.total += 1;
      if (c.importMetadata?.localFile) stats.local += 1;
      if (ownedAt(i)) stats.owned += 1;
      else if (c.unmatched) stats.missing += 1;
      else if (c.reading || c.pending) {
        stats.waiting += 1;
        if (tickedNow(i)) stats.waitingTicked += 1;
      }
      else if (unsure(c)) {
        stats.check += 1;
        stats.toCheck.push(i);
      } else stats.found += 1;
    });
  }
  /**
   * The songs a save brings in, counted from the list itself rather than the matches so far: those ticked, and those
   * still being read or matched (a save while matching takes them as they're found). Songs already in the library and
   * ones not found aren't counted.
   */
  const toSave = selected.length + (matching ? stats.waitingTicked : 0);
  // The playlist a save of these songs goes into (named after the source), once it exists.
  const playlistTitle = r?.playlist?.title || r?.track?.title || "Imported Playlist";
  const outcomeEarly = transfer.saved?.source === query ? transfer.saved : null;
  const savedPlaylist = useStore((s) => {
    if (!playlist) return undefined;
    // The playlist the last save made (named in its dialog), else one named after this list.
    const named = outcomeEarly?.playlistId ?? null;
    return (named && s.playlists.some((p) => p.id === named) ? named : null) ?? s.playlists.find((p) => !p.system && p.name === playlistTitle)?.id;
  });
  const outcome = transfer.saved?.source === query ? transfer.saved : null;
  // This playlist's save, shown in its panel rather than in a toast while the page is open (see showTransferInline).
  const savingHere = busy && transfer.source === query && playlist;
  // A save under way has its songs; only one that's following the matching still takes ticks into account.
  const fixedSelection = savingHere && !transfer.batch?.following;
  const inline = playlist ? query : null;
  useEffect(() => {
    showTransferInline(inline);
    return () => showTransferInline(null);
  }, [inline]);
  // The not-found and in-the-library groups, opened (and scrolled to) from their counts in the panel.
  const [openGroups, setOpenGroups] = useState<{ missing: boolean | null; owned: boolean }>({ missing: null, owned: false });
  const groupRefs = { missing: useRef<HTMLDetailsElement>(null), owned: useRef<HTMLDetailsElement>(null) };
  const showGroup = (group: "missing" | "owned") => {
    setOpenGroups((g) => ({ ...g, [group]: true }));
    requestAnimationFrame(() => groupRefs[group].current?.scrollIntoView({ behavior: "smooth", block: "start" }));
  };
  // Each press goes on to the next song to check, then round again.
  const lastChecked = useRef(-1);
  const showNextCheck = () => {
    const at = stats.toCheck.find((i) => i > lastChecked.current) ?? stats.toCheck[0];
    if (at === undefined) return;
    lastChecked.current = at;
    const row = document.getElementById(`playlist-row-${at}`);
    row?.scrollIntoView({ behavior: "smooth", block: "center" });
    row?.querySelector<HTMLElement>("input, button")?.focus({ preventScroll: true });
  };
  // How far down the page the stuck import bar reaches, so a song or group scrolled to lands below it, not under it.
  const section = useRef<HTMLElement>(null);
  const bar = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = bar.current;
    if (!el) return;
    const observer = new ResizeObserver(() => section.current?.style.setProperty("--import-bar-bottom", `${64 + el.offsetHeight}px`));
    observer.observe(el);
    return () => observer.disconnect();
  }, [playlist]);

  useEffect(() => {
    if (isAudioOnlySource(query)) setKind("audio");
  }, [query]);
  // New results start unfiltered, with every song of a playlist selected.
  useEffect(() => {
    setProvider("all");
    setTicks({ mode: "default", except: [] });
    setOpenGroups({ missing: null, owned: false });
  }, [query, kind, attempt]);

  const context = { label: `Search: ${query}`, route: { name: "search", q: query } as const };
  /** The track a result plays as: your saved copy if you have one (a saved video plays as a video), else a stream of it. */
  const trackFor = (c: Candidate, index?: number) => {
    const mine = (index === undefined ? undefined : ownedAt(index)) ?? ownedIndex(getState()).find({ sources: candidateSources(c) })[0];
    if (mine) return mine;
    const key = keyFor(c, kind);
    const { title, artist } = describe(c);
    registerStreams([{ key, candidate: c, title, artist, artwork: c.importMetadata?.artworkURL || c.thumbnailURL || undefined, kind: "discover-search", ...(kind === "video" ? { video: platformFor(c) === "youtube" } : {}) }]);
    return streamTrackId(key);
  };
  const play = (c: Candidate, index?: number) => {
    const id = trackFor(c, index);
    if (getState().currentId === id) return togglePlay();
    playList([id], id, context);
  };
  const menu = (e: MouseEvent, c: Candidate, index: number) => {
    const source = c.importMetadata?.sourceURL || c.sourcePageURL || c.sourceURL;
    const save = isDownloadable(c) && !busy ? () => void saveSearchResults(query, r!, [index]) : null;
    const mine = ownedAt(index) ?? ownedIndex(getState()).find({ sources: candidateSources(c) })[0];
    if (!mine && !canStream(c)) {
      const { title, artist } = describe(c);
      return openSearchResultMenu(e, title, artist, { source, save: playlist ? undefined : save });
    }
    const id = trackFor(c, index);
    if (!getState().tracks[id]) return;
    openTrackMenu(e, [id], { context: { ...context, ids: [id] }, stream: { searchResult: true, source, save } });
  };

  // A single song's sources all describe that one song.
  const results = (r?.candidates ?? [])
    .map((c, index) => ({ c: !c.importMetadata && r!.kind !== "search_results" && !playlist ? { ...c, importMetadata: r!.track } : c, index }))
    .filter(({ c }) => provider === "all" || platformFor(c) === provider);
  const topPlatform = results[0] ? platformFor(results[0].c) : null;
  const owned = playlist ? results.filter(({ index }) => ownedAt(index)) : [];
  const missing = playlist ? results.filter(({ c, index }) => !ownedAt(index) && c.unmatched) : [];
  const row = ({ c, index }: { c: Candidate; index: number }) => (
    <OnlineResult
      key={`${keyFor(c)}:${index}`}
      candidate={c}
      kind={kind}
      playlist={playlist}
      featured={!playlist && index === results[0]?.index}
      busy={busy}
      owned={ownedAt(index)}
      selected={c.pending || c.reading ? tickedNow(index) : selected.includes(index)}
      onSelect={() => setTicks((t) => ({ ...t, except: t.except.includes(index) ? t.except.filter((n) => n !== index) : [...t.except, index] }))}
      onPlay={() => play(c, index)}
      onMenu={(e) => menu(e, c, index)}
      onSave={() => void saveSearchResults(query, r!, [index])}
      rowId={playlist ? `playlist-row-${index}` : undefined}
    />
  );

  return (
    <section ref={section} className="external-search" aria-label="Music from external platforms">
      <div className="section-head">
        <div>
          <h2 className="section-title">Find music online</h2>
          {/* Once results are in, they explain themselves; the line only helps while waiting. */}
          {r ? null : <p className="muted small">Search YouTube, Spotify and SoundCloud, or paste a song or playlist link.</p>}
        </div>
        {/* A Spotify or SoundCloud playlist has no videos: nothing to switch between. */}
        {playlist && isAudioOnlySource(query) ? null : (
          <div className="segmented sm" role="group" aria-label="Search media type">
            {(["audio", "video"] as const).map((k) => (
              <button key={k} type="button" className={kind === k ? "on" : ""} aria-pressed={kind === k} disabled={k === "video" && isAudioOnlySource(query)} onClick={() => setKind(k)}>
                {k === "audio" ? "Songs" : "Videos"}
              </button>
            ))}
          </div>
        )}
      </div>
      {busy && !savingHere ? (
        <div className="import-status" role="status">
          <span className="spinner" />
          <span>{stageLabel(transfer.stage)} — {transfer.transferName}</span>
          <button type="button" className="btn ghost sm" onClick={cancelImport}>Cancel download</button>
        </div>
      ) : null}
      {transfer.error && !busy && transfer.source === query && !outcome ? <p className="import-error" role="alert">{failureText(transfer.error)}</p> : null}
      {loading && !r ? (
        <p className="muted search-progress" role="status">
          <span className="spinner" />
          {reading ? `Reading the songs from Spotify: ${reading.completed} of ${reading.total}…` : "Searching music platforms…"}
        </p>
      ) : null}
      {error ? (
        <p className="import-error" role="alert">
          {error} <button type="button" className="text-btn" onClick={() => setAttempt((n) => n + 1)}>Retry</button>
        </p>
      ) : null}
      {r ? (
        <>
          {r.playlist && !playlist ? <h3>{r.playlist.title || "Playlist"}{r.playlist.truncated ? ` (first ${countSongs(r.candidates.length)})` : ""}</h3> : null}
          {r.playlist?.spotifyLimit ? (
            <p className="muted small">
              Spotify only shows other apps the first 100 songs of a playlist. To bring in all of it, open the playlist in
              the Spotify app, select every song (Ctrl+A), copy them (Ctrl+C) and paste here.
            </p>
          ) : null}
          {r.playlist?.unavailableCount ? <p className="muted small">{countSongs(r.playlist.unavailableCount)} in this playlist {r.playlist.unavailableCount === 1 ? "isn't" : "aren't"} available on {r.kind === "soundcloud_playlist" ? "SoundCloud" : "Spotify"}.</p> : null}
          {r.unavailableProviders?.length ? <p className="muted small">{r.unavailableProviders.map((p) => ({ spotify: "Spotify", soundcloud: "SoundCloud", youtube: "YouTube" })[p] ?? p).join(" and ")} search isn't responding right now, so these results come from the others.</p> : null}
          {kind === "video" ? <p className="muted small">YouTube results play and save as videos. SoundCloud and Spotify have no video, so theirs play as audio.</p> : null}
          {r.kind === "search_results" && new Set(r.candidates.map(platformFor)).size > 1 ? <ProviderFilter resolution={r} value={provider} onChange={setProvider} /> : null}
          {playlist ? (
            <>
              <header className="import-head">
                <h3>{r.playlist?.title || "Playlist"}</h3>
                <p className="muted small">
                  {r.playlist?.truncated ? `First ${countSongs(r.candidates.length)}` : countSongs(r.candidates.length)}
                  {stats.local ? ` · ${stats.local} of them your own files` : ""}
                </p>
              </header>
              {/* Stays in view while the list scrolls: how far it's got, and saving. */}
              <div ref={bar} className="import-bar">
                <div className="import-meter" role="progressbar" aria-label="Songs settled" aria-valuemin={0} aria-valuemax={stats.total} aria-valuenow={stats.total - stats.waiting}>
                  <span className="found" style={{ flexGrow: stats.found }} />
                  <span className="to-check" style={{ flexGrow: stats.check }} />
                  <span className="owned" style={{ flexGrow: stats.owned }} />
                  <span className="missing" style={{ flexGrow: stats.missing }} />
                  <span className="waiting" style={{ flexGrow: stats.waiting }} />
                </div>
                <div className="import-bar-row">
                  <ul className="import-stats">
                    <li className="found"><b>{stats.found}</b> found</li>
                    {stats.check ? <li className="to-check"><button type="button" onClick={showNextCheck} title="Matched by artist and length only, so left unticked. Listen to them before saving."><b>{stats.check}</b> to check</button></li> : null}
                    {stats.owned ? <li className="owned"><button type="button" onClick={() => showGroup("owned")}><b>{stats.owned}</b> in your library</button></li> : null}
                    <li className="missing">{stats.missing ? <button type="button" onClick={() => showGroup("missing")}><b>{stats.missing}</b> not found</button> : <><b>0</b> not found</>}</li>
                    {stats.waiting ? <li className="waiting"><b>{stats.waiting}</b> to go</li> : null}
                  </ul>
                  <div className="import-actions">
                    <button type="button" className="text-btn" disabled={fixedSelection || (selected.length === downloadable(r).filter((i) => !ownedAt(i)).length && stats.waitingTicked === stats.waiting)} onClick={() => setTicks({ mode: "all", except: [] })}>Select all</button>
                    <button type="button" className="text-btn" disabled={fixedSelection || (!selected.length && !stats.waitingTicked)} onClick={() => setTicks({ mode: "none", except: [] })}>Clear</button>
                    {savingHere ? (
                      <>
                        <button type="button" className="btn" disabled>
                          {savingLabel(transfer.batch, matching ? stats.waiting : 0)}
                        </button>
                        <button type="button" className="text-btn" onClick={cancelImport}>Cancel</button>
                      </>
                    ) : selected.length || matching ? (
                      // While songs are still being found, saving starts with the ones found so far and keeps saving the
                      // rest as they're found, in one download.
                      <button
                        type="button"
                        className="btn primary"
                        disabled={busy || !toSave}
                        onClick={save}
                        title={matching ? "Saves the songs found so far, then each one as it's found, even if you leave this page." : undefined}
                      >
                        {`Save ${countSongs(toSave)}`}
                      </button>
                    ) : savedPlaylist ? (
                      <button type="button" className="btn primary" onClick={() => navigate({ name: "playlist", id: savedPlaylist })}>Open playlist</button>
                    ) : owned.length ? (
                      <button type="button" className="btn primary" disabled={busy} onClick={save}>Make playlist</button>
                    ) : (
                      <button type="button" className="btn primary" disabled>Select songs to save</button>
                    )}
                  </div>
                </div>
                <ImportStatus matching={matching} toGo={stats.waiting} saving={savingHere ? transfer : null} outcome={busy ? null : outcome} offerOpen={Boolean(selected.length || matching)} />
              </div>
              <div className="online-song-list playlist-list">{results.filter(({ c, index }) => !ownedAt(index) && !c.unmatched).map(row)}</div>
              {missing.length ? (
                <details
                  ref={groupRefs.missing}
                  className="playlist-group playlist-missing"
                  open={openGroups.missing ?? (!matching && missing.length <= 12)}
                  onToggle={(e) => {
                    const open = e.currentTarget.open;
                    setOpenGroups((g) => (g.missing === open ? g : { ...g, missing: open }));
                  }}
                >
                  <summary>{countSongs(missing.length)} not found</summary>
                  <p className="muted small">
                    {failed || unread ? (
                      <>
                        {unread ? `Spotify didn't answer for ${countSongs(unread)}. ` : ""}
                        {failed ? `YouTube turned away the search for ${countSongs(failed)}. ` : ""}
                        <button type="button" className="text-btn" disabled={busy || Boolean(matching)} onClick={() => setAttempt((n) => n + 1)}>Search again</button>
                      </>
                    ) : "No fitting upload turned up on YouTube or SoundCloud, so these stay out of the playlist."}
                  </p>
                  <div className="online-song-list playlist-list">{missing.map(row)}</div>
                </details>
              ) : null}
              {owned.length ? (
                <details
                  ref={groupRefs.owned}
                  className="playlist-group"
                  open={openGroups.owned}
                  onToggle={(e) => {
                    const open = e.currentTarget.open;
                    setOpenGroups((g) => (g.owned === open ? g : { ...g, owned: open }));
                  }}
                >
                  <summary>{owned.length} in your library</summary>
                  <p className="muted small">{outcome?.kept ? "Saved, and in the playlist." : "Already saved, so they aren't saved again. They go in the playlist with the rest."}</p>
                  <div className="online-song-list playlist-list">{owned.map(row)}</div>
                </details>
              ) : null}
            </>
          ) : (
            // One section per platform, the top result's platform first. With only one platform answering,
            // the filter above already names it, so its section drops the repeated heading.
            [...PROVIDERS].sort(([a], [b]) => Number(b === topPlatform) - Number(a === topPlatform)).map(([p, name]) => {
              const songs = results.filter(({ c }) => platformFor(c) === p);
              if (!songs.length) return null;
              return (
                <section className="online-platform" key={p} aria-label={`${name} results`}>
                  {PROVIDERS.filter(([q]) => results.some(({ c }) => platformFor(c) === q)).length > 1 ? <h3><span className={`prov-dot ${p}`} aria-hidden="true" />{name}</h3> : null}
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
  /** The library song this playlist row already is. */
  owned?: string;
  featured: boolean;
  busy: boolean;
  selected: boolean;
  onSelect: () => void;
  onPlay: () => void;
  onMenu: (e: MouseEvent) => void;
  onSave: () => void;
  /** A playlist row's element id, to scroll to it. */
  rowId?: string;
}

/** Whether two names are one ("Outkast" and "OutkastVEVO", "Ado" and "Ado - Topic"). */
function sameName(a: string, b: string) {
  const plain = (s: string) => s.toLowerCase().replace(/\s+-\s+topic$|vevo$|official/g, "").replace(/[^\p{L}\p{N}]+/gu, "");
  const x = plain(a);
  const y = plain(b);
  return Boolean(x && y) && (x.includes(y) || y.includes(x));
}

/**
 * The import bar's status line: the save under way (this playlist's, while its page is open), where matching has
 * got, or how the last save ended.
 */
/** The Save button while its save runs: how many songs, those still to be found (`toFind`, while it follows the matching) included. */
function savingLabel(b: ImportState["batch"], toFind: number) {
  const total = (b?.total ?? 0) + (b?.following ? toFind : 0);
  if (!total) return b?.streaming ? "Adding…" : "Saving…";
  return `${b?.streaming ? "Adding" : "Saving"} ${countSongs(total)}…`;
}

function ImportStatus({ matching, toGo, saving, outcome, offerOpen }: {
  matching: Resolution["matching"];
  toGo: number;
  saving: ImportState | null;
  outcome: PlaylistSaved | null;
  /** Whether the line offers to open the playlist (not when the bar's main button already does). */
  offerOpen: boolean;
}) {
  const lines: { key: string; text: string }[] = [];
  if (saving) {
    const b = saving.batch;
    const at = saving.transferName.indexOf(" • ");
    const name = at >= 0 ? saving.transferName.slice(at + 3) : "";
    const [doing, done] = b?.streaming ? ["Adding", "Added"] : ["Saving", "Saved"];
    lines.push({
      key: "saving",
      text: !b ? "Saving…"
        : b.index >= b.total ? `${done} ${countSongs(b.total)} so far · waiting for more to be found`
        : `${doing} ${b.index + 1} of ${b.total}${b.following ? " so far" : ""}${name ? ` · ${name}` : ""}`,
    });
  }
  if (matching) {
    const read = matching.reading;
    const listening = matching.listening;
    lines.push({
      key: "matching",
      text: matching.spotifyWaitingSeconds ? `Spotify asked for a pause · reading resumes in ${matching.spotifyWaitingSeconds} s`
        : matching.waitingSeconds ? `YouTube asked for a pause · searching resumes in ${matching.waitingSeconds} s`
        : read && read.completed < read.total ? "Reading songs from Spotify…"
        : toGo ? `Finding matches · ${toGo} to go`
        : listening && listening.completed < listening.total ? `Listening to ${countSongs(listening.total - listening.completed)} matched by length only…`
        : "Finishing…",
    });
  }
  if (lines.length) {
    return (
      <div className="import-lines" role="status">
        {lines.map((line) => <p key={line.key} className="import-note"><span className="spinner" aria-hidden="true" /><span>{line.text}</span></p>)}
      </div>
    );
  }
  if (!outcome) return null;
  const { kept, total, failed, cancelled, playlistTitle, playlistId, streamed } = outcome;
  const text = streamed ? (
    cancelled ? `Stopped. Added ${kept} of ${countSongs(total)} to “${playlistTitle}”.`
      : `Added ${countSongs(kept)} to “${playlistTitle}”, streaming${failed ? `. ${countSongs(failed)} couldn't be streamed` : ""}.`
  )
    : cancelled ? `Stopped. Kept ${kept} of ${countSongs(total)}.`
    : failed ? `Saved ${kept} of ${countSongs(total)} ${playlistTitle ? `to “${playlistTitle}”` : "to your library"}. ${countSongs(failed)} couldn't be downloaded.`
    : total ? `Saved ${countSongs(kept)} ${playlistTitle ? `to “${playlistTitle}”` : "to your library"}.`
    : `Added to “${playlistTitle}”.`;
  return (
    <div className="import-lines" role="status">
      <p className={`import-note done${failed ? " partial" : ""}`}>
        <Icon name={failed || cancelled ? "help" : "checkCircle"} size={15} />
        <span>{text}</span>
        {playlistId && offerOpen ? <button type="button" className="text-btn" onClick={() => navigate({ name: "playlist", id: playlistId })}>Open playlist</button> : null}
      </p>
    </div>
  );
}

/** One search result. YouTube shows video thumbnails and channels; SoundCloud leads with the uploader. */
function OnlineResult({ candidate: c, kind, playlist, owned, featured, busy, selected, onSelect, onPlay, onMenu, onSave, rowId }: ResultProps) {
  // Your saved copy, when you have this result (it's what plays).
  const found = useStore((s) => ownedIndex(s).find({ sources: candidateSources(c) })[0]);
  const mine = owned ?? found;
  const id = mine ?? streamTrackId(keyFor(c, kind));
  const active = useStore((s) => s.currentId === id);
  const playing = useStore((s) => s.isPlaying) && active;
  const buffering = useStore((s) => s.buffering === id);
  // A pasted song known from its link to be in the library isn't read from Spotify: it's shown as saved.
  const saved = useStore((s) => {
    const track = owned ? s.tracks[owned] : undefined;
    return track ? `${track.title}\u0000${s.artists[track.artistId]?.name ?? ""}` : "";
  });
  const described = describe(c);
  const { meta } = described;
  const [savedTitle, savedArtist] = !meta.title && saved ? saved.split("\u0000") : [];
  // A pasted song not read from Spotify yet has no title or artist to show.
  const title = savedTitle || (c.reading || (!meta.title && c.unmatched) ? `Song ${c.playlistIndex ?? ""}`.trim() : described.title);
  const artist = savedTitle ? savedArtist : c.reading ? "" : described.artist;
  const platform = platformFor(c);
  const youtube = platform === "youtube" && !playlist;
  const soundcloud = platform === "soundcloud" && !playlist;
  const source = c.importMetadata?.sourceURL || c.sourcePageURL || c.sourceURL;
  const avatar = c.importMetadata?.creatorAvatarURL || (platform === "youtube" ? c.creatorAvatarURL : undefined) || undefined;
  const cover = (youtube ? c.videoThumbnailURL || c.thumbnailURL || c.importMetadata?.artworkURL : c.importMetadata?.artworkURL || c.thumbnailURL) || undefined;
  const label = `${playing ? "Pause" : "Play"} ${title}`;
  const creator = <div className="online-creator"><CreatorAvatar name={artist} url={avatar} /><span>{artist}</span></div>;
  const playable = Boolean(owned) || canStream(c);
  const status = owned ? null
    : c.reading ? "Reading from Spotify…"
    : c.pending ? "Searching…"
    : c.unmatched === "not_found" ? "No matching upload on YouTube or SoundCloud"
    : c.unmatched === "search_failed" ? "YouTube didn't answer: search again in a minute"
    : c.unmatched === "not_on_spotify" ? "No longer available on Spotify"
    : c.unmatched === "unread" ? "Spotify didn't answer: search again in a minute"
    : unsure(c) ? "Matched by artist and length only (the title couldn't be compared). Listen before saving."
    : null;
  const waiting = Boolean(c.reading || c.pending);

  if (playlist) {
    // A playlist song: its own title and artist, then the upload it was matched to (or why there isn't one).
    const check = !owned && !c.unmatched && !waiting && unsure(c);
    const matchedFrom = !owned && !c.unmatched && !waiting && c.sourceURL && c.title ? (c.sourceProvider === "soundcloud" ? "SoundCloud" : "YouTube") : null;
    // The uploader, unless it's just the artist again ("Hey Ya! · Outkast" for Outkast's Hey Ya!).
    const channel = c.artist && !sameName(c.artist, artist) ? c.artist : "";
    const heard = c.match?.listened;
    const heardSame = typeof heard === "object" && heard?.verdict === "same";
    const checkTip = typeof heard === "object" && heard?.verdict === "unsure"
      ? "Matched by artist and length only, and Deezer's preview couldn't settle it. Listen before saving."
      : "Matched by artist and length only: the title couldn't be compared. Listen before saving.";
    // "Not found" is said once, by the group; a row says only a different reason.
    const note = owned || c.unmatched === "not_found" ? null : status;
    return (
      <article id={rowId} className={`playlist-row${active ? " current" : ""}${waiting ? " waiting" : ""}${c.unmatched ? " unmatched" : ""}`} onContextMenu={onMenu}>
        {/* The whole cell ticks the box: a bigger target than the box itself. */}
        <label className="pl-check">
          {!owned && !c.unmatched ? <input type="checkbox" className="pl-tick" aria-label={`Select ${title}`} checked={selected} disabled={!isDownloadable(c) && !waiting} onChange={onSelect} /> : null}
        </label>
        <button type="button" className="online-play" aria-label={label} disabled={!playable} onClick={onPlay}>
          {owned ? <TrackArt trackId={owned} className="search-cover" /> : <SearchCover url={cover} />}
          {buffering ? <span className="spinner" /> : <Icon name={playing ? "pause" : "play"} size={18} />}
        </button>
        <div className="pl-main">
          <button type="button" className="online-title" aria-label={label} disabled={!playable} onClick={onPlay}>{title}</button>
          <span className="t-sub">
            {c.importMetadata?.localFile ? <span className="badge local" title="A file of your own that you added to Spotify. It's searched for by its name and length.">Your file</span> : null}
            {artist}
            {meta.album ? ` · ${meta.album}` : ""}
          </span>
        </div>
        <div className="pl-match">
          {note && !check ? <span className={`pl-note${waiting ? " waiting" : ""}`}>{waiting ? <span className="spinner sm" aria-hidden="true" /> : null}{note}</span> : null}
          {check && c.listening ? <span className="check-label listening" title="Comparing its sound with Deezer's preview of the song"><span className="spinner sm" aria-hidden="true" />Listening…</span> : null}
          {check && !c.listening ? <span className="check-label" title={checkTip}>Check match</span> : null}
          {matchedFrom ? (
            <a className="pl-upload" href={c.sourceURL} target="_blank" rel="noreferrer" title={`${matchedFrom} upload: ${c.title}${c.artist ? ` · ${c.artist}` : ""}${heardSame ? " · sounds the same as Deezer's preview of the song" : ""}`}>
              <span className="pl-provider">{matchedFrom}</span>
              <span className="pl-upload-title">{c.title}</span>
              {channel ? <span className="pl-upload-by">{channel}</span> : null}
            </a>
          ) : null}
        </div>
        <span className="pl-time">{meta.durationSeconds ? formatTime(meta.durationSeconds) : ""}</span>
        <span className="pl-link">
          {source ? <a className="icon-btn sm" href={source} target="_blank" rel="noreferrer" aria-label={`Open source for ${title}`} title="Open source"><Icon name="link" size={16} /></a> : null}
        </span>
      </article>
    );
  }

  return (
    <article className={`online-song ${platform}${featured ? " featured" : ""}${active ? " current" : ""}`} onContextMenu={onMenu}>
      {featured ? <span className="online-top-label">Top result</span> : null}
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
        {status ? <span className="online-review">{status}</span> : null}
        {c.requiresReview && !owned ? (
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
