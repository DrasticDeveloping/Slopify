-- Usernames: unique (lowercase), changeable, shown as @name; friends can add each other by it (src/social.ts).
ALTER TABLE users ADD COLUMN username TEXT;
CREATE UNIQUE INDEX users_by_username ON users (username);
