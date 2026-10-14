export type Genre = "lofi" | "synthwave" | "house" | "ambient" | "indie";

/**
 * Where a song lives:
 * - "server": saved on the music server as a link; plays through the server until this device keeps a copy.
 * - "downloads": saved on the music server, with a verified copy kept on this device.
 * - "files": added from this computer; stays on this device only and is never synced.
 */
export type StorageClass = "files" | "downloads" | "server";

export interface Palette {
  a: string;
  b: string;
  c: string;
}

export interface Artist {
  id: string;
  name: string;
  genre: Genre;
  palette: Palette;
  listeners: number;
  /** A picture from the artist's verified online profile. */
  image?: string;
  /** Which of several same-named artists this is, when found through artist search. */
  musicBrainzId?: string;
}

export interface Album {
  id: string;
  title: string;
  artistId: string;
  /** When it came out, if known (catalog lookup or file tags). Never the date it was saved. */
  year?: number;
  /** Full release date (YYYY-MM-DD), when known. */
  released?: string;
  palette: Palette;
  glyph: number;
  /** Real cover art (imported songs). Falls back to the generated palette art. */
  artworkUrl?: string;
}

export interface Track {
  id: string;
  title: string;
  /** The main artist; others credited on the song are in `featuring`. */
  artistId: string;
  /** Further credited artists ("Lady Gaga, Bruno Mars": Bruno Mars), in credit order. */
  featuring?: string[];
  albumId: string;
  duration: number;
  addedAt: number;
  kind: "audio" | "video";
  storage: StorageClass;
  size: number;
  plays: number;
  seed: number;
  /** Object URL for a file the user imported in this session. */
  fileUrl?: string;
  /** Where the music server provides this song's audio (`/api/songs/:id/file`). */
  mediaUrl?: string;
  /** Id of this song on the music server. */
  serverId?: string;
  /** Page the song was imported from (YouTube, SoundCloud, Spotify…). */
  sourceUrl?: string;
  /** The YouTube or SoundCloud page its audio comes from, when that isn't sourceUrl (a song saved from Spotify). */
  playableUrl?: string;
  /** A recommended song streamed in full from its source: playable like any song, but not in the library and never saved. */
  stream?: boolean;
}

export interface Playlist {
  id: string;
  name: string;
  description: string;
  trackIds: string[];
  createdAt: number;
  palette: Palette;
  system?: boolean;
}

export interface ClipRange {
  start: number;
  end: number;
}
