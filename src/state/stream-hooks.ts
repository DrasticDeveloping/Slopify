/*
 * Where streamed songs' hooks (importer.ts) are kept for actions.ts. It imports
 * nothing, so it is always set up before either: actions.ts and importer.ts import
 * each other, and the build may run importer.ts's connectStreams call before
 * actions.ts's own top-level code, which would reset a hook kept there.
 */

/** Where a streamed song plays from. A video can start on its audio, with `picture` (its video, or null if it has none) to follow. */
export interface StreamMedia {
  url: string;
  picture?: Promise<string | null>;
}

export interface StreamHooks {
  /** The full song's audio, or its video. */
  source(id: string): Promise<StreamMedia>;
  /** Downloads the song into the library (one at a time, in order), then hands `then` its library id. */
  save(id: string, then?: (libraryId: string) => void): void;
  dismiss(id: string): void;
}

export const streamHooks: { current: StreamHooks | null } = { current: null };
