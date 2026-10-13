-- Slopify accounts and their libraries.

-- One row per Clerk user (id = the token's "sub").
CREATE TABLE users (
  id TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  avatar_url TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- Saved songs: a link and its details, as the music server keeps them (server/songs.mjs).
-- A deleted song stays as a tombstone, so other devices learn it's gone.
CREATE TABLE songs (
  user_id TEXT NOT NULL,
  id TEXT NOT NULL,
  data TEXT NOT NULL,
  deleted INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, id)
);
CREATE INDEX songs_by_change ON songs (user_id, updated_at);

-- Playlists, likes, history and settings: one document per user, with a revision
-- for detecting conflicting writes (as server/library-state.mjs).
CREATE TABLE library_state (
  user_id TEXT PRIMARY KEY,
  rev INTEGER NOT NULL,
  data TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
