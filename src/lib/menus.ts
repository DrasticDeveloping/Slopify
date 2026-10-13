import type { MouseEvent as ReactMouseEvent } from "react";
import {
  addToPlaylist, addToQueue, deleteFromDevice, deleteFromLibrary, deletePlaylist, dismissStream, hideRecommendation, isLiked, isPlayable, likeMany, navigate,
  openMenu, openModal, playList, playNext, removeFromPlaylist, saveStream, startRadio, toggleLike, unhideRecommendation,
} from "../state/actions";
import type { Track } from "../data/types";
import type { ReasonKind } from "../recommend/taste";
import { getState, type MenuItem, type Route } from "../state/store";
import { plural } from "./format";
import { hideFromMix } from "../recommend/mixes";
import { trackKey } from "../recommend/service";
import { downloadTracks } from "../state/server";
import { isSlipIn, toggleSlipIn } from "../state/slipins";

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

/** A streamed recommendation: it plays like any song, and can be added to the library (playlists need it there first). */
function streamMenu(t: Track, context?: { label: string; route?: Route; ids: string[] }): MenuItem[] {
  const liked = isLiked(t.id);
  return [
    { label: "Play", icon: "play", run: () => (context ? playList(context.ids, t.id, context) : playList([t.id], t.id, { label: "Recommended for you" })) },
    { label: "Play next", icon: "queue", run: () => playNext([t.id]) },
    { label: "Add to queue", icon: "list", run: () => addToQueue([t.id]) },
    { separator: true },
    { label: "Add to library", icon: "download", run: () => saveStream(t.id) },
    slipItem([t.id]),
    { label: liked ? "Remove from Liked Songs" : "Add to Liked Songs", icon: liked ? "heartFill" : "heart", run: () => toggleLike(t.id) },
    { separator: true },
    { label: "Start song radio", icon: "radio", run: () => startRadio(t.id) },
    { label: "Not interested", icon: "close", run: () => dismissStream(t.id) },
    { label: "Go to artist", icon: "user", run: () => navigate({ name: "artist", id: t.artistId }) },
  ];
}

/** In a mix, a song can be hidden from that mix alone. New songs are hidden by song key, library songs by id. */
function mixItems(track: Track, route: Route | undefined): MenuItem[] {
  if (route?.name !== "mix") return [];
  const key = track.stream ? trackKey(getState(), track.id) : track.id;
  return [{ label: "Hide from this mix", icon: "close", run: () => hideFromMix(route.id, key) }];
}

/** `why`: the reason a recommendation was shown, so hiding it teaches the recommender. */
export function trackMenu(ids: string[], opts: { playlistId?: string; context?: { label: string; route?: Route; ids: string[] }; why?: ReasonKind } = {}): MenuItem[] {
  const s = getState();
  const tracks = ids.map((id) => s.tracks[id]).filter(Boolean);
  const single = tracks.length === 1 ? tracks[0] : null;
  const mixHide = single ? mixItems(single, opts.context?.route) : [];
  if (single?.stream) return [...streamMenu(single, opts.context), ...mixHide];
  const playlist = opts.playlistId ? s.playlists.find((p) => p.id === opts.playlistId) : undefined;
  const anyPlayable = tracks.some((t) => isPlayable(t, s));
  const serverOnly = tracks.filter((t) => t.storage === "server");
  // Removing a device copy keeps the song on the music server; songs only on this device are just deleted.
  const downloaded = tracks.filter((t) => t.storage === "downloads");
  const items: MenuItem[] = [
    ...mixHide,
    {
      label: single ? "Play" : `Play ${tracks.length} songs`, icon: "play", disabled: !anyPlayable,
      run: () => (single && opts.context ? playList(opts.context.ids, single.id, opts.context) : playList(ids, ids[0], { label: "Selection" })),
    },
    { label: "Play next", icon: "queue", disabled: !anyPlayable, run: () => playNext(ids) },
    { label: "Add to queue", icon: "list", disabled: !anyPlayable, run: () => addToQueue(ids) },
    { separator: true },
    { label: "Add to playlist", icon: "plus", submenu: playlistSubmenu(ids) },
    single
      ? { label: isLiked(single.id, s) ? "Remove from Liked Songs" : "Add to Liked Songs", icon: isLiked(single.id, s) ? "heartFill" : "heart", run: () => toggleLike(single.id) }
      : { label: "Add to Liked Songs", icon: "heart", run: () => likeMany(ids) },
    slipItem(ids),
  ];
  if (playlist && !playlist.system) items.push({ label: "Remove from this playlist", icon: "close", run: () => removeFromPlaylist(playlist.id, ids) });
  if (playlist?.id === "liked" && !single) items.push({ label: "Remove from Liked Songs", icon: "close", run: () => removeFromPlaylist("liked", ids) });
  if (single) {
    items.push(
      { separator: true },
      { label: "Start song radio", icon: "radio", disabled: !isPlayable(single, s), run: () => startRadio(single.id) },
      s.taste.hidden[single.id]
        ? { label: "Show in recommendations", icon: "sparkle", run: () => unhideRecommendation(single.id) }
        : { label: "Hide from recommendations", icon: "close", run: () => hideRecommendation(single.id, opts.why) },
      { label: "Go to artist", icon: "user", run: () => navigate({ name: "artist", id: single.artistId }) },
      { label: "Go to album", icon: "music", run: () => navigate({ name: "album", id: single.albumId }) },
      { label: "Edit clip…", icon: "scissors", disabled: !isPlayable(single, s), run: () => openModal({ type: "clipEditor", trackId: single.id }) },
    );
  }
  if (serverOnly.length || downloaded.length) items.push({ separator: true });
  if (serverOnly.length) items.push({ label: serverOnly.length === 1 ? "Download to device" : `Download ${serverOnly.length} songs`, icon: "download", run: () => downloadTracks(serverOnly.map((t) => t.id)) });
  if (downloaded.length) items.push({ label: downloaded.length === 1 ? "Remove from device" : `Remove ${downloaded.length} from device`, icon: "close", run: () => deleteFromDevice(downloaded.map((t) => t.id)) });
  items.push({ separator: true });
  items.push({ label: single ? "Delete from library" : `Delete ${tracks.length} songs from library`, icon: "trash", danger: true, run: () => deleteFromLibrary(ids) });
  return items;
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
      ...(p.system ? [] : [
        { separator: true },
        { label: "Edit details…", icon: "edit", run: () => openModal({ type: "editPlaylist", id: p.id }) },
        { label: "Add songs…", icon: "plus", run: () => openModal({ type: "addSongs", playlistId: p.id }) },
        { label: "Delete playlist", icon: "trash", danger: true, run: () => deletePlaylist(p.id) },
      ] satisfies MenuItem[]),
    ],
  });
}
