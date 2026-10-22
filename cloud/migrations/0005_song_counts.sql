-- How many songs each account keeps (not deleted), so saving a song checks the
-- limit without counting the whole library each time (src/library.ts putSong).
-- Triggers keep it right however songs change.
CREATE TABLE song_counts (
  user_id TEXT PRIMARY KEY,
  saved INTEGER NOT NULL DEFAULT 0
);
INSERT INTO song_counts (user_id, saved) SELECT user_id, COUNT(*) FROM songs WHERE deleted = 0 GROUP BY user_id;

CREATE TRIGGER songs_count_insert AFTER INSERT ON songs WHEN NEW.deleted = 0
BEGIN
  INSERT INTO song_counts (user_id, saved) VALUES (NEW.user_id, 1) ON CONFLICT(user_id) DO UPDATE SET saved = saved + 1;
END;

CREATE TRIGGER songs_count_update AFTER UPDATE OF deleted ON songs WHEN OLD.deleted <> NEW.deleted
BEGIN
  INSERT INTO song_counts (user_id, saved) VALUES (NEW.user_id, CASE WHEN NEW.deleted = 0 THEN 1 ELSE 0 END)
    ON CONFLICT(user_id) DO UPDATE SET saved = MAX(0, saved + CASE WHEN NEW.deleted = 0 THEN 1 ELSE -1 END);
END;

CREATE TRIGGER songs_count_delete AFTER DELETE ON songs WHEN OLD.deleted = 0
BEGIN
  UPDATE song_counts SET saved = MAX(0, saved - 1) WHERE user_id = OLD.user_id;
END;
