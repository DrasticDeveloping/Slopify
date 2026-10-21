-- Friends, shared playlists and what friends are playing (src/social.ts).

-- A short code people give friends to add them, and whether friends see what they're playing.
ALTER TABLE users ADD COLUMN friend_code TEXT;
ALTER TABLE users ADD COLUMN share_activity INTEGER NOT NULL DEFAULT 1;
CREATE UNIQUE INDEX users_by_friend_code ON users (friend_code);

-- What each account is playing now, for its friends. Only while share_activity is on.
CREATE TABLE activity (
  user_id TEXT PRIMARY KEY,
  data TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

-- Friend requests waiting for an answer.
CREATE TABLE friend_requests (
  from_id TEXT NOT NULL,
  to_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (from_id, to_id)
);
CREATE INDEX friend_requests_to ON friend_requests (to_id);

-- Friendships, one row each way.
CREATE TABLE friends (
  user_id TEXT NOT NULL,
  friend_id TEXT NOT NULL,
  since INTEGER NOT NULL,
  PRIMARY KEY (user_id, friend_id)
);

-- Playlists their owners share: anyone signed in with the link can open one,
-- and friends see those on the owner's profile. The owner's app republishes
-- the playlist when it changes, so viewers always see the current version.
CREATE TABLE shared_playlists (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  playlist_id TEXT NOT NULL,
  on_profile INTEGER NOT NULL DEFAULT 1,
  data TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX shared_playlists_by_owner ON shared_playlists (owner_id, playlist_id);

-- Shared playlists someone follows (they show in their library).
CREATE TABLE playlist_follows (
  user_id TEXT NOT NULL,
  share_id TEXT NOT NULL,
  at INTEGER NOT NULL,
  PRIMARY KEY (user_id, share_id)
);
CREATE INDEX playlist_follows_by_share ON playlist_follows (share_id);

-- Shared playlists a friend sent someone, until they open or dismiss it.
CREATE TABLE playlist_inbox (
  user_id TEXT NOT NULL,
  share_id TEXT NOT NULL,
  from_id TEXT NOT NULL,
  at INTEGER NOT NULL,
  PRIMARY KEY (user_id, share_id)
);
CREATE INDEX playlist_inbox_by_share ON playlist_inbox (share_id);
