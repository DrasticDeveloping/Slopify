import { useSyncExternalStore } from "react";
import { ownedIndex } from "../recommend/owned";
import { createPlaylist, navigate, toast } from "./actions";
import { cloudCall, cloudConfig, CloudError, getAccount, onSignedIn, subscribeAccount } from "./cloud";
import { registerStreams, streamLink, streamTrackId } from "./importer";
import { getState, subscribe } from "./store";

/*
 * Friends and shared playlists, on Slopify's online service (cloud/src/social.ts).
 *
 * - Friends add each other with a friend code. Friends see each other's shared
 *   playlists, what they're playing (Settings can turn that off), and the
 *   Listen Along room they're hosting, to join in one click.
 * - A shared playlist has a link anyone signed in can open, play and follow.
 *   It stays live: this app republishes it whenever you change the playlist.
 *   Its songs travel as links (as in Listen Along), so they stream on other
 *   people's devices, or play from their own copy if they have one.
 *
 * Like library sync, it only contacts the service when something changes, at
 * sign-in, when the window comes back into focus, and every 30 seconds while
 * it has focus.
 */

export interface Person { id: string; displayName: string; avatarUrl: string | null; username?: string | null }
export interface FriendActivity {
  song: { title: string; artist: string; sourceURL: string | null; artworkUrl: string | null } | null;
  playing: boolean;
  roomCode: string | null;
  at: number;
}
export interface Friend extends Person { since: number; activity: FriendActivity | null }
export interface SharedSummary { shareId: string; name: string; description: string; songCount: number; artworkUrl: string | null; updatedAt: number; owner: Person }
export interface Social {
  friends: Friend[];
  incoming: Array<Person & { at: number }>;
  outgoing: Array<Person & { at: number }>;
  inbox: Array<SharedSummary & { sentAt: number }>;
  shared: Array<{ shareId: string; playlistId: string; onProfile: boolean; updatedAt: number }>;
  following: Array<SharedSummary & { followedAt: number }>;
}
export interface SharedSong { title: string; artist: string; album: string | null; sourceURL: string; savedAs: "audio" | "video"; durationSeconds: number | null; artworkUrl: string | null }
export interface SharedPlaylist { shareId: string; name: string; description: string; tracks: SharedSong[]; updatedAt: number; owner: Person; mine: boolean; playlistId?: string; following: boolean }

const POLL = 30_000;
/** What you're playing is told again this often while it plays, so friends still see it (it's shown for 10 minutes). */
const ACTIVITY_REFRESH = 4 * 60_000;
const REPUBLISH_AFTER = 3_000;
const PUBLISHED_KEY = "slopify.shared-playlists.v1";

/* ───────────────────────── state ───────────────────────── */

let social: Social | null = null;
const listeners = new Set<() => void>();
function setSocial(next: Social | null) {
  social = next;
  listeners.forEach((l) => l());
}
const subscribeSocial = (l: () => void) => {
  listeners.add(l);
  return () => void listeners.delete(l);
};
export const useSocial = () => useSyncExternalStore(subscribeSocial, () => social);
/** Why friends couldn't be loaded last time, or "" (cleared when they load). */
let socialError = "";
export const useSocialError = () => useSyncExternalStore(subscribeSocial, () => socialError);
export const getSocial = () => social;

const signedIn = () => getAccount().status === "signedIn";
const reason = (error: unknown) => (error instanceof Error ? error.message : "Couldn't reach Slopify's online service.");
const inFront = () => document.visibilityState === "visible" && document.hasFocus();

let loading: Promise<void> | null = null;
/** When friends, requests, inbox and shares last arrived (from here, or with the library's sync). */
let loadedAt = 0;
/** When the latest load from here was asked for: anything asked for before it is older. */
let askedAt = 0;
/** When the library's sync last said it would bring them (claimSocial). */
let claimedAt = 0;
/** How long such a claim holds: longer than a call to the service can take (cloud.ts). */
const CLAIM = 25_000;
/** Whether they're due again, and not already on their way. */
const socialWanted = () => signedIn() && !loading && Date.now() - loadedAt >= POLL - 5_000 && Date.now() - claimedAt >= CLAIM;
/**
 * Whether the library's sync (sync.ts) should ask for them with its own call:
 * when they're due. Until they arrive (or the claim runs out) they aren't asked for here as well.
 */
export function claimSocial() {
  if (!socialWanted()) return false;
  claimedAt = Date.now();
  return true;
}
/** They arrived, from a call made at `asked` (one made before the latest load from here is ignored). */
export function receiveSocial(next: Social, asked: number) {
  if (!signedIn() || asked < askedAt) return;
  loadedAt = Date.now();
  socialError = "";
  setSocial(next);
  republishChanged();
}
/** Loads friends, requests, inbox and shares. */
export function refreshSocial(): Promise<void> {
  if (!signedIn()) return Promise.resolve();
  if (loading) return loading;
  const asked = (askedAt = Date.now());
  loading = cloudCall<Social>("/v1/social")
    .then((next) => receiveSocial(next, asked))
    .catch((error: unknown) => {
      socialError = reason(error);
      listeners.forEach((l) => l());
    })
    .finally(() => {
      loading = null;
    });
  return loading;
}

/** After a change: the call's result, then everything fresh. Failures are told as a toast. */
async function act<T>(what: string, call: () => Promise<T>): Promise<T | null> {
  try {
    const result = await call();
    void refreshSocial();
    return result;
  } catch (error) {
    toast(what, { tone: "error", detail: reason(error) });
    return null;
  }
}

/* ───────────────────────── friends ───────────────────────── */

export async function addFriend(code: string) {
  const result = await act("Couldn't add that friend", () => cloudCall<{ status: "friends" | "requested"; person: Person }>("/v1/friends/requests", { method: "POST", body: { code: code.trim() } }));
  if (result) toast(result.status === "friends" ? `You and ${result.person.displayName} are friends` : `Friend request sent to ${result.person.displayName}`, { tone: "success" });
  return Boolean(result);
}
export async function acceptFriend(person: Person) {
  if (await act("Couldn't accept that request", () => cloudCall(`/v1/friends/requests/${encodeURIComponent(person.id)}`, { method: "POST" }))) toast(`You and ${person.displayName} are friends`, { tone: "success" });
}
/** Declines a request to you, or cancels one you sent. */
export const dropRequest = (person: Person) => act("Couldn't remove that request", () => cloudCall(`/v1/friends/requests/${encodeURIComponent(person.id)}`, { method: "DELETE" }));
export async function removeFriend(person: Person) {
  if (await act("Couldn't remove that friend", () => cloudCall(`/v1/friends/${encodeURIComponent(person.id)}`, { method: "DELETE" }))) toast(`Removed ${person.displayName} from your friends`);
}
export const friendPlaylists = (friendId: string) => cloudCall<SharedSummary[]>(`/v1/friends/${encodeURIComponent(friendId)}/playlists`);

/* ───────────────────────── songs as links ───────────────────────── */

/** A song as other people's devices can play it: its link and details. Null for a file only this device has. */
export function portableSong(id: string): SharedSong | null {
  const s = getState();
  const t = s.tracks[id];
  if (!t) return null;
  const link = t.stream ? streamLink(t.id) : t.playableUrl ?? t.sourceUrl;
  if (!link?.startsWith("https://")) return null;
  const album = s.albums[t.albumId];
  return {
    title: t.title,
    artist: s.artists[t.artistId]?.name ?? "Unknown artist",
    album: album && album.title !== t.title ? album.title : null,
    sourceURL: link,
    savedAs: t.kind === "video" ? "video" : "audio",
    durationSeconds: t.duration || null,
    artworkUrl: album?.artworkUrl?.startsWith("https://") ? album.artworkUrl : null,
  };
}

/** The song here: your own copy if you have it, otherwise streamed in full from its link. */
export function trackForSong(song: SharedSong) {
  const mine = ownedIndex(getState()).find({ artist: song.artist, title: song.title, sources: [song.sourceURL] })[0];
  if (mine) return mine;
  const soundcloud = /soundcloud\.com/i.test(song.sourceURL);
  const video = song.savedAs === "video" && !soundcloud;
  const key = `shared:${video ? "video:" : ""}${song.sourceURL}`;
  registerStreams([{
    video,
    key,
    candidate: {
      sourceURL: song.sourceURL,
      sourceProvider: soundcloud ? "soundcloud" : "youtube",
      title: song.title,
      artist: song.artist,
      durationSeconds: song.durationSeconds,
      thumbnailURL: song.artworkUrl,
      importMetadata: { title: song.title, artist: song.artist, album: song.album ?? undefined, durationSeconds: song.durationSeconds ?? undefined, artworkURL: song.artworkUrl ?? undefined },
    },
    title: song.title,
    artist: song.artist,
    artwork: song.artworkUrl ?? undefined,
    album: song.album ?? undefined,
    kind: "discover-search",
  }]);
  return streamTrackId(key);
}

/* ───────────────────────── sharing your playlists ───────────────────────── */

export const shareLink = (shareId: string) => `${cloudConfig.url}/p/${shareId}`;
/** The share id in a pasted playlist link, or null. */
export function parseShareLink(text: string) {
  const match = /\/p\/([a-z0-9]{16})\/?(?:[?#].*)?$/.exec(text.trim());
  if (!match || !cloudConfig.url) return null;
  try {
    return new URL(text.trim()).origin === new URL(cloudConfig.url).origin ? match[1] : null;
  } catch {
    return null;
  }
}

export const shareOf = (playlistId: string, s: Social | null = social) => s?.shared.find((x) => x.playlistId === playlistId) ?? null;

function snapshot(playlistId: string) {
  const p = getState().playlists.find((x) => x.id === playlistId);
  if (!p) return null;
  const songs = p.trackIds.map(portableSong);
  return { name: p.name, description: p.description ?? "", tracks: songs.filter((x): x is SharedSong => Boolean(x)), skipped: songs.filter((x) => !x).length };
}

/** What each shared playlist was last published as, so it's republished only when it changes. */
function published(): Record<string, string> {
  try {
    return JSON.parse(localStorage.getItem(PUBLISHED_KEY) ?? "{}") as Record<string, string>;
  } catch {
    return {};
  }
}
function notePublished(playlistId: string, fingerprint: string | null) {
  const next = published();
  if (fingerprint === null) delete next[playlistId];
  else next[playlistId] = fingerprint;
  try {
    localStorage.setItem(PUBLISHED_KEY, JSON.stringify(next));
  } catch {
    // Republished again next time; harmless.
  }
}

/**
 * Publishes a playlist. `baseUpdatedAt` (automatic republishing) is the version
 * this device last saw: if another device published since, the service refuses
 * (409) and this device catches up with your account first rather than
 * replacing the newer version.
 */
async function publish(playlistId: string, onProfile: boolean, baseUpdatedAt?: number) {
  const snap = snapshot(playlistId);
  if (!snap) return null;
  const { skipped, ...body } = snap;
  const result = await cloudCall<{ shareId: string; updatedAt: number }>(`/v1/shares/${encodeURIComponent(playlistId)}`, {
    method: "PUT",
    body: { ...body, onProfile, ...(baseUpdatedAt ? { baseUpdatedAt } : {}) },
  });
  notePublished(playlistId, JSON.stringify([body, onProfile]));
  if (social) setSocial({ ...social, shared: social.shared.map((x) => (x.playlistId === playlistId ? { ...x, updatedAt: result.updatedAt } : x)) });
  return { shareId: result.shareId, skipped };
}

/** Shares a playlist (or changes whether it's on your profile), and returns its link. */
export async function sharePlaylist(playlistId: string, onProfile = shareOf(playlistId)?.onProfile ?? true) {
  const result = await act("Couldn't share this playlist", () => publish(playlistId, onProfile));
  if (!result) return null;
  if (result.skipped) toast(`${result.skipped} songs aren't in the shared playlist`, { detail: "They're files on this device, so nobody else can play them. Songs saved from the web are shared." });
  return shareLink(result.shareId);
}

export async function stopSharing(playlistId: string, { quiet = false } = {}) {
  if (await act("Couldn't stop sharing", () => cloudCall(`/v1/shares/${encodeURIComponent(playlistId)}`, { method: "DELETE" }))) {
    notePublished(playlistId, null);
    if (!quiet) toast("Stopped sharing", { detail: "Its link no longer works." });
  }
}

/**
 * Shared playlists you changed on this device since they were last published
 * from it go out again. Only once the library has loaded (a half-loaded
 * playlist is never published). A device that hasn't published a playlist
 * before only notes how it looks here: it may be behind your other devices,
 * so it doesn't replace what they published until you change it here.
 */
/** When this session started: the library counts as caught up once your account has synced since. */
const SESSION_START = Date.now();
/** The library here has caught up with your account this session (so it isn't behind your other devices). */
const caughtUp = () => (getState().server.cloudSyncedAt ?? 0) >= SESSION_START;

let republishTimer = 0;
function republishChanged() {
  clearTimeout(republishTimer);
  republishTimer = window.setTimeout(() => {
    if (!social || !signedIn() || !caughtUp()) return;
    const last = published();
    for (const share of social.shared) {
      const snap = snapshot(share.playlistId);
      if (!snap) continue;
      const { skipped: _skipped, ...body } = snap;
      const now = JSON.stringify([body, share.onProfile]);
      if (last[share.playlistId] === undefined) notePublished(share.playlistId, now);
      else if (last[share.playlistId] !== now) {
        void publish(share.playlistId, share.onProfile, share.updatedAt).catch((error: unknown) => {
          // Another device published a newer version: catch up first; a change you make here then goes out.
          if (error instanceof CloudError && error.status === 409) {
            notePublished(share.playlistId, null);
            void refreshSocial();
          }
        });
      }
    }
    void unsharePending();
  }, REPUBLISH_AFTER);
}

/*
 * A shared playlist you delete on this device stops being shared, once Undo
 * has had its chance. Kept in localStorage until it's done, so a reload or a
 * failed request doesn't forget it; Undo (the playlist coming back) cancels it.
 */
const UNSHARE_AFTER = 15_000;
const UNSHARE_KEY = "slopify.unshare-pending.v1";
function pendingUnshares(): Record<string, number> {
  try {
    return JSON.parse(localStorage.getItem(UNSHARE_KEY) ?? "{}") as Record<string, number>;
  } catch {
    return {};
  }
}
function setPendingUnshares(next: Record<string, number>) {
  try {
    localStorage.setItem(UNSHARE_KEY, JSON.stringify(next));
  } catch {
    // Tried again this session only.
  }
}
function playlistsChanged(before: { id: string }[], after: { id: string }[]) {
  const now = new Set(after.map((p) => p.id));
  const pending = pendingUnshares();
  let changed = false;
  for (const id of Object.keys(pending)) {
    if (now.has(id)) {
      delete pending[id];
      changed = true;
    }
  }
  for (const { id } of before) {
    if (now.has(id) || !shareOf(id) || pending[id]) continue;
    pending[id] = Date.now();
    changed = true;
  }
  if (!changed) return;
  setPendingUnshares(pending);
  window.setTimeout(() => void unsharePending(), UNSHARE_AFTER + 100);
}
let unsharing = false;
async function unsharePending() {
  if (unsharing || !signedIn() || !caughtUp()) return;
  const pending = pendingUnshares();
  const due = Object.entries(pending).filter(([, at]) => Date.now() - at >= UNSHARE_AFTER).map(([id]) => id);
  if (!due.length) return;
  unsharing = true;
  try {
    for (const id of due) {
      // Back (Undo, or synced from another device): keep sharing it.
      if (getState().playlists.some((p) => p.id === id)) {
        const next = pendingUnshares();
        delete next[id];
        setPendingUnshares(next);
        continue;
      }
      try {
        await cloudCall(`/v1/shares/${encodeURIComponent(id)}`, { method: "DELETE" });
        notePublished(id, null);
        const next = pendingUnshares();
        delete next[id];
        setPendingUnshares(next);
      } catch {
        // Tried again with the next refresh.
      }
    }
  } finally {
    unsharing = false;
  }
  void refreshSocial();
}

export async function copyText(text: string, what = "Link") {
  try {
    await navigator.clipboard.writeText(text);
    toast(`${what} copied`, { tone: "success" });
  } catch {
    toast(`Couldn't copy the ${what.toLowerCase()}`, { detail: "Select it and copy it yourself." });
  }
}

/* ───────────────────────── other people's shared playlists ───────────────────────── */

export const loadShared = (shareId: string) => cloudCall<SharedPlaylist>(`/v1/shared/${shareId}`);
export async function followShared(shareId: string, follow: boolean) {
  const result = await act(follow ? "Couldn't follow this playlist" : "Couldn't unfollow this playlist", () => cloudCall(`/v1/shared/${shareId}/follow`, { method: follow ? "PUT" : "DELETE" }));
  if (result) toast(follow ? "Following: it's in Your Library" : "Unfollowed", { tone: follow ? "success" : undefined });
  return Boolean(result);
}
export async function sendShared(shareId: string, friendIds: string[]) {
  const result = await act("Couldn't send it", () => cloudCall<{ sent: number }>(`/v1/shared/${shareId}/send`, { method: "POST", body: { friendIds } }));
  if (result) toast(result.sent === 1 ? "Sent to 1 friend" : `Sent to ${result.sent} friends`, { tone: "success" });
}
export const dismissInbox = (shareId: string) => act("Couldn't dismiss it", () => cloudCall(`/v1/inbox/${shareId}`, { method: "DELETE" }));

/** Opens a shared playlist (from its link, the inbox or a friend's profile). */
export function openShared(shareId: string) {
  navigate({ name: "shared", id: shareId });
}

/** A copy of a shared playlist in your own library: its songs are saved there too. */
export function saveSharedCopy(playlist: SharedPlaylist) {
  const ids = playlist.tracks.map(trackForSong);
  const id = createPlaylist(playlist.name, ids, playlist.description || `Shared by ${playlist.owner.displayName}`);
  toast(`Saved “${playlist.name}” to your playlists`, { tone: "success", detail: ids.length ? "Its songs are being added to your library." : undefined, action: { label: "Open", run: () => navigate({ name: "playlist", id }) } });
}

/** Error text for a shared playlist that couldn't load. */
export const sharedError = (error: unknown) => (error instanceof CloudError && error.status === 404 ? "This playlist isn't shared anymore, or the link is wrong." : reason(error));

/* ───────────────────────── what you're playing ───────────────────────── */

let activitySent = "";
let activityAt = 0;
let activityTimer = 0;
function tellActivity(force = false) {
  const account = getAccount();
  if (account.status !== "signedIn" || !account.profile?.shareActivity) return;
  const s = getState();
  const song = s.currentId ? portableSong(s.currentId) : null;
  const t = s.currentId ? s.tracks[s.currentId] : null;
  const roomCode = s.listen.mode === "host" ? s.listen.code : null;
  const body = {
    // A song that's only a file here is shown by name, without a link.
    song: song ?? (t ? { title: t.title, artist: s.artists[t.artistId]?.name ?? "Unknown artist", sourceURL: null, artworkUrl: null } : null),
    playing: s.isPlaying,
    roomCode,
  };
  const key = JSON.stringify(body);
  if (!force && key === activitySent) return;
  activitySent = key;
  activityAt = Date.now();
  void cloudCall("/v1/me/activity", { method: "PUT", body }).catch(() => {
    activitySent = "";
  });
}

/* ───────────────────────── keeping up ───────────────────────── */

let watching = false;
/** Started once, by App. */
export function watchSocial() {
  if (watching) return;
  watching = true;
  onSignedIn(() => void refreshSocial());
  subscribeAccount(() => {
    if (!signedIn() && social) setSocial(null);
  });
  let last = getState();
  subscribe(() => {
    const s = getState();
    const prev = last;
    last = s;
    if (s.currentId !== prev.currentId || s.isPlaying !== prev.isPlaying || s.listen.mode !== prev.listen.mode || s.listen.code !== prev.listen.code) {
      clearTimeout(activityTimer);
      activityTimer = window.setTimeout(() => tellActivity(), 1500);
    }
    if (s.playlists !== prev.playlists && social?.shared.length) {
      playlistsChanged(prev.playlists, s.playlists);
      republishChanged();
    }
    // Caught up with your account: shared playlists changed meanwhile can go out, and deletions finish.
    if (s.server.cloudSyncedAt !== prev.server.cloudSyncedAt && caughtUp() && social) republishChanged();
  });
  window.setInterval(() => {
    // Usually they came with the library's last sync, so nothing is asked for here.
    if (!inFront() || !socialWanted()) return;
    void refreshSocial();
  }, POLL);
  window.setInterval(() => {
    if (getState().isPlaying && Date.now() - activityAt > ACTIVITY_REFRESH) tellActivity(true);
  }, 60_000);
  const back = () => {
    if (inFront()) void refreshSocial();
  };
  window.addEventListener("focus", back);
  document.addEventListener("visibilitychange", back);
  void refreshSocial();
}
