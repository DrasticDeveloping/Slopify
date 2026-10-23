import type { MouseEvent as ReactMouseEvent } from "react";
import {
  addToPlaylist, addToQueue, deleteFromDevice, deleteFromLibrary, deletePlaylist, dismissStream, hideRecommendation, isPlayable, navigate,
  openMenu, openModal, playList, playNext, removeFromPlaylist, saveStream, startRadio, toast, unhideRecommendation,
} from "../state/actions";
import { streamLink } from "../state/importer";
import { shareOf } from "../state/social";
import type { Track } from "../data/types";
import type { ReasonKind } from "../recommend/taste";
import { getState, type MenuItem, type Route } from "../state/store";
import { plural } from "./format";
import { hideFromMix } from "../recommend/mixes";
import { trackKey } from "../recommend/service";
import { downloadTracks } from "../state/server";
import { isSlipIn, toggleSlipIn } from "../state/slipins";
import { snoozeItem } from "../state/snooze";

/** Slip a song into your listening now and then, or stop. */
function slipItem(ids: string[]): MenuItem {
  const all = ids.every(isSlipIn);
  return { label: all ? "Stop slipping in" : "Slip into my listening", icon: "shuffle", run: () => toggleSlipIn(ids) };
}

export function menuPosition(e: ReactMouseEvent | { clientX: number; clientY: number } | HTMLElement) {
  if (e instanceof HTMLElement) {
    const r = e.getBoundingClientRect();
    return { x: r.left, y: r.bottom + 6 };
  }
  return { x: e.clientX, y: e.clientY };
}

function playlistSubmenu(ids: string[]): MenuItem[] {
  const s = getState();
  return [
    { label: "New playlist…", icon: "plus", run: () => openModal({ type: "createPlaylist", addIds: ids }) },
    { separator: true },
    ...s.playlists.filter((p) => !p.system).map((p) => ({ label: p.name, icon: "playlists", run: () => addToPlaylist(p.id, ids) })),
  ];
}

/** The page a song came from (YouTube, SoundCloud, Spotify…), when known. */
const songLink = (t: Track, source?: string) => source || t.sourceUrl || t.playableUrl || (t.stream ? streamLink(t.id) : null) || undefined;

async function copyLink(url: string) {
  try {
    await navigator.clipboard.writeText(url);
    toast("Link copied", { tone: "success" });
  } catch {
    toast("Couldn't copy the link");
  }
}

/** Copy the song's page on its platform. */
function linkItems(url: string | undefined): MenuItem[] {
  return url ? [{ label: "Copy link", icon: "copy", run: () => void copyLink(url) }] : [];
}

/** Menu groups with a separator between each; empty groups are left out. */
function grouped(...groups: MenuItem[][]): MenuItem[] {
  return groups.filter((g) => g.length).flatMap((g, i) => (i ? [{ separator: true }, ...g] : g));
}

export interface StreamMenuOptions {
  /** Saves the song to the library its own way (a search result saves as found, video or audio); null when it can't be saved now. */
  save?: (() => void) | null;
  /** The song's page on its platform. */
  source?: string;
  /** A search result rather than a recommendation, so there's nothing to be "not interested" in. */
  searchResult?: boolean;
}

/** A streamed song: it plays like any song, and can be added to the library (playlists add it there first). */
function streamMenu(t: Track, opts: StreamMenuOptions = {}): MenuItem[] {
  return grouped(
    [
      { label: "Play next", icon: "queue", run: () => playNext([t.id]) },
      { label: "Add to queue", icon: "list", run: () => addToQueue([t.id]) },
    ],
    [
      { label: "Add to library", icon: "download", disabled: opts.save === null, run: opts.save ?? (() => saveStream(t.id)) },
      { label: "Add to playlist", icon: "plus", submenu: playlistSubmenu([t.id]) },
    ],
    [
      { label: "Start song radio", icon: "radio", run: () => startRadio(t.id) },
      slipItem([t.id]),
      ...(opts.searchResult ? [] : [{ label: "Not interested", icon: "close", run: () => dismissStream(t.id) }]),
    ],
    linkItems(songLink(t, opts.source)),
  );
}

/** In a mix, a song can be hidden from that mix alone. New songs are hidden by song key, library songs by id. */
function mixItems(track: Track, route: Route | undefined): MenuItem[] {
  if (route?.name !== "mix") return [];
  const key = track.stream ? trackKey(getState(), track.id) : track.id;
  return [{ label: "Hide from this mix", icon: "close", run: () => hideFromMix(route.id, key) }];
}

/** `why`: the reason a recommendation was shown, so hiding it teaches the recommender. */
export function trackMenu(ids: string[], opts: { playlistId?: string; context?: { label: string; route?: Route; ids: string[] }; why?: ReasonKind; stream?: StreamMenuOptions } = {}): MenuItem[] {
  const s = getState();
  const tracks = ids.map((id) => s.tracks[id]).filter(Boolean);
  const single = tracks.length === 1 ? tracks[0] : null;
  const mixHide = single ? mixItems(single, opts.context?.route) : [];
  if (single?.stream) return grouped(streamMenu(single, opts.stream), mixHide);
  const playlist = opts.playlistId ? s.playlists.find((p) => p.id === opts.playlistId) : undefined;
  const anyPlayable = tracks.some((t) => isPlayable(t, s));
  const singlePlayable = single ? isPlayable(single, s) : false;
  const serverOnly = tracks.filter((t) => t.storage === "server");
  // Removing a device copy keeps the song on the music server; songs only on this device are just deleted.
  const downloaded = tracks.filter((t) => t.storage === "downloads");
  const removeFromPlaylistItem: MenuItem[] =
    playlist && !playlist.system ? [{ label: "Remove from this playlist", icon: "close", run: () => removeFromPlaylist(playlist.id, ids) }]
    : playlist?.id === "liked" ? [{ label: "Remove from Liked Songs", icon: "close", run: () => removeFromPlaylist("liked", ids) }]
    : [];
  return grouped(
    [
      { label: "Play next", icon: "queue", disabled: !anyPlayable, run: () => playNext(ids) },
      { label: "Add to queue", icon: "list", disabled: !anyPlayable, run: () => addToQueue(ids) },
    ],
    [
      { label: "Add to playlist", icon: "plus", submenu: playlistSubmenu(ids) },
      ...removeFromPlaylistItem,
    ],
    [
      ...(single ? [{ label: "Start song radio", icon: "radio", disabled: !singlePlayable, run: () => startRadio(single.id) }] : []),
      slipItem(ids),
      ...[snoozeItem(ids)].filter((item): item is MenuItem => item !== null),
      ...(single
        ? [s.taste.hidden[single.id]
          ? { label: "Show in recommendations", icon: "sparkle", run: () => unhideRecommendation(single.id) }
          : { label: "Hide from recommendations", icon: "close", run: () => hideRecommendation(single.id, opts.why) }]
        : []),
      ...mixHide,
    ],
    single ? linkItems(songLink(single)) : [],
    [
      ...(single ? [{ label: "Edit clip…", icon: "scissors", disabled: !singlePlayable, run: () => openModal({ type: "clipEditor", trackId: single.id }) }] : []),
      ...(serverOnly.length ? [{ label: serverOnly.length === 1 ? "Download to device" : `Download ${serverOnly.length} songs`, icon: "download", run: () => downloadTracks(serverOnly.map((t) => t.id)) }] : []),
      ...(downloaded.length ? [{ label: downloaded.length === 1 ? "Remove from device" : `Remove ${downloaded.length} from device`, icon: "downloaded", run: () => deleteFromDevice(downloaded.map((t) => t.id)) }] : []),
      { label: single ? "Delete from library" : `Delete ${tracks.length} songs from library`, icon: "trash", danger: true, run: () => deleteFromLibrary(ids) },
    ],
  );
}

export function openTrackMenu(e: ReactMouseEvent | HTMLElement, ids: string[], opts: Parameters<typeof trackMenu>[1] = {}) {
  if (!(e instanceof HTMLElement)) e.preventDefault();
  const s = getState();
  const single = ids.length === 1 ? s.tracks[ids[0]] : null;
  openMenu({
    ...menuPosition(e),
    title: single ? single.title : plural(ids.length, "song"),
    subtitle: single ? s.artists[single.artistId]?.name : "Selected",
    items: trackMenu(ids, opts),
  });
}

/** A search result that can't be streamed: it can still be saved, and its link copied. */
export function openSearchResultMenu(e: ReactMouseEvent, title: string, artist: string, opts: Pick<StreamMenuOptions, "save" | "source">) {
  const items = grouped(
    opts.save !== undefined ? [{ label: "Add to library", icon: "download", disabled: opts.save === null, run: opts.save ?? undefined }] : [],
    linkItems(opts.source),
  );
  if (!items.length) return;
  e.preventDefault();
  openMenu({ ...menuPosition(e), title, subtitle: artist, items });
}

export function openPlaylistMenu(e: ReactMouseEvent | HTMLElement, playlistId: string) {
  if (!(e instanceof HTMLElement)) e.preventDefault();
  const s = getState();
  const p = s.playlists.find((pl) => pl.id === playlistId);
  if (!p) return;
  const route: Route = { name: "playlist", id: p.id };
  openMenu({
    ...menuPosition(e),
    title: p.name,
    subtitle: plural(p.trackIds.length, "song"),
    items: [
      { label: "Play", icon: "play", disabled: !p.trackIds.length, run: () => playList(p.trackIds, undefined, { label: p.name, route }) },
      { label: "Add to queue", icon: "list", disabled: !p.trackIds.length, run: () => addToQueue(p.trackIds) },
      { label: "Open", icon: "external", run: () => navigate(route) },
      ...(p.system ? [] : [{ label: shareOf(p.id) ? "Sharing…" : "Share…", icon: "link", run: () => openModal({ type: "sharePlaylist", id: p.id }) }]),
      ...(p.system ? [] : [
        { separator: true },
        { label: "Edit details…", icon: "edit", run: () => openModal({ type: "editPlaylist", id: p.id }) },
        { label: "Add songs…", icon: "plus", run: () => openModal({ type: "addSongs", playlistId: p.id }) },
        { label: "Delete playlist", icon: "trash", danger: true, run: () => deletePlaylist(p.id) },
      ] satisfies MenuItem[]),
    ],
  });
}
