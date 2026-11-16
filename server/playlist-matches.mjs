import { readFileSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { writeDurably } from "./durable-file.mjs";

/*
 * Playlist songs' YouTube matches, remembered for a while (playlist-matches.json in the library folder). Matching a
 * playlist means one YouTube search per song at the pace YouTube tolerates (minutes for a long playlist), so pasting
 * the same playlist again, or one sharing its songs, reuses these instead of searching again. A song found missing
 * is remembered for less long, since an upload may turn up. Only a cache: losing it just means searching again.
 */

const FOUND_MS = 7 * 24 * 3_600_000;
const MISSING_MS = 12 * 3_600_000;
const MAX_ENTRIES = 5_000;
const SAVE_DELAY_MS = 5_000;
/** Raised whenever matching changes (local-import-core.cjs scoreAudioSource and friends), so old matches are redone. */
const MATCHER_VERSION = 9;

/**
 * A playlist song's key: its provider and track id ("spotify:6CIQOFf01zQ9qJaqhD6rlH"), a pasted file of the user's
 * own by its tags, or none.
 */
const keyOf = (track) => {
  if (track?.localFile && track.title) {
    return `local:${[track.artist, track.album, track.title, track.durationSeconds].map((part) => String(part ?? "").toLowerCase()).join("|")}`;
  }
  return track?.provider && track?.trackID ? `${track.provider}:${track.trackID}` : null;
};

/**
 * Entries kept in a JSON file in `dataDir`, oldest dropped first past `maxEntries`, each until `fresh(entry)` says
 * it's stale. Read synchronously once, at first use (callers ask synchronously); saved a few seconds after a change.
 */
function jsonCache(dataDir, name, { version, maxEntries, fresh, now }) {
  const file = path.join(dataDir, name);
  /** key -> { at, row }, oldest first (a Map keeps insertion order). */
  let entries = new Map();
  let loaded = false;
  let saveTimer = null;

  const load = () => {
    if (loaded) return;
    loaded = true;
    try {
      const value = JSON.parse(readFileSync(file, "utf8"));
      if (value?.matcher === version && value.entries && typeof value.entries === "object") {
        entries = new Map(Object.entries(value.entries).filter(([, entry]) => entry && typeof entry.at === "number" && entry.row));
      }
    } catch {
      entries = new Map();
    }
  };
  const save = () => {
    saveTimer ??= setTimeout(() => {
      saveTimer = null;
      for (const [key, entry] of entries) if (!fresh(entry)) entries.delete(key);
      const text = JSON.stringify({ version: 1, matcher: version, entries: Object.fromEntries(entries) });
      void fs.mkdir(dataDir, { recursive: true })
        .then(() => writeDurably(file, text))
        .catch((error) => console.warn(`[slopify] ${name}:`, error?.message || error));
    }, SAVE_DELAY_MS);
    saveTimer.unref?.();
  };
  return {
    get(key) {
      load();
      const entry = key ? entries.get(key) : null;
      if (!entry) return null;
      if (!fresh(entry)) {
        entries.delete(key);
        return null;
      }
      return entry.row;
    },
    set(key, row) {
      load();
      if (!key || !row) return;
      entries.delete(key);
      entries.set(key, { at: now(), row });
      while (entries.size > maxEntries) entries.delete(entries.keys().next().value);
      save();
    },
  };
}

export function createPlaylistMatches(dataDir, { now = Date.now } = {}) {
  const cache = jsonCache(dataDir, "playlist-matches.json", {
    version: MATCHER_VERSION,
    maxEntries: MAX_ENTRIES,
    now,
    fresh: (entry) => now() - entry.at < (typeof entry.row.sourceURL === "string" && entry.row.sourceURL ? FOUND_MS : MISSING_MS),
  });
  return {
    /** The row remembered for this playlist song, if still fresh. */
    get: (track) => cache.get(keyOf(track)),
    /** Remembers a song's row: matched, or `unmatched: "not_found"`. Search failures aren't remembered. */
    set(track, row) {
      if (!row || (row.unmatched && row.unmatched !== "not_found")) return;
      cache.set(keyOf(track), row);
    },
  };
}

/*
 * Spotify songs' details (title, artists, length, artwork) as read from their pages (spotify-tracks.json), so a list
 * of songs pasted again, or one sharing songs with an earlier one, needn't be read from Spotify again: reading is
 * paced to what Spotify tolerates. Kept a month; a song's details hardly change.
 */
const TRACK_DETAILS_MS = 30 * 24 * 3_600_000;
const MAX_TRACK_DETAILS = 20_000;

export function createSpotifyTrackDetails(dataDir, { now = Date.now } = {}) {
  const cache = jsonCache(dataDir, "spotify-tracks.json", {
    version: 1,
    maxEntries: MAX_TRACK_DETAILS,
    now,
    fresh: (entry) => now() - entry.at < TRACK_DETAILS_MS,
  });
  return {
    get: (trackID) => cache.get(typeof trackID === "string" ? trackID : null),
    set(trackID, details) {
      if (typeof trackID !== "string" || !details?.title || !details?.artist) return;
      const { title, artist, durationSeconds = null, artworkURL = null } = details;
      cache.set(trackID, { title, artist, durationSeconds, artworkURL });
    },
  };
}
