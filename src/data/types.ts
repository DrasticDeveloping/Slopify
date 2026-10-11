export type Genre = "lofi" | "synthwave" | "house" | "ambient" | "indie";

/** Where a song's bytes live, mirroring the old app's storage classes. */
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
  image?: string;
  musicBrainzId?: string;
}

export interface Album {
  id: string;
  title: string;
  artistId: string;
  year: number;
  palette: Palette;
  glyph: number;
  /** Real cover art (imported songs). Falls back to the generated palette art. */
  artworkUrl?: string;
}

export interface Track {
  id: string;
  title: string;
  artistId: string;
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
  /** A local file that has also been uploaded to the music server. */
  uploaded?: boolean;
  /** Durable media served by the Slopify import API (`/api/media/:id`). */
  mediaUrl?: string;
  /** Id of this song in the import API's library. */
  serverId?: string;
  /** Page the song was imported from (YouTube, SoundCloud, Spotify…). */
  sourceUrl?: string;
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
