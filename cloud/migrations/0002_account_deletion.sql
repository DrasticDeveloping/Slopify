-- Account deletion (DELETE /v1/me).

-- Accounts deleted in the last few minutes. Writes for them are refused, so a
-- sync another device had already started can't put the deleted data back.
-- Rows are removed once they're older than that (src/library.ts).
CREATE TABLE deleted_users (
  id TEXT PRIMARY KEY,
  deleted_at INTEGER NOT NULL
);

-- Which Listen Along rooms an account started or joined, so deleting it can
-- remove it from them (and end the ones it hosts). Rows older than two days
-- are removed: rooms never last that long (src/room.ts).
CREATE TABLE room_members (
  user_id TEXT NOT NULL,
  code TEXT NOT NULL,
  at INTEGER NOT NULL,
  PRIMARY KEY (user_id, code)
);
CREATE INDEX room_members_by_age ON room_members (at);
