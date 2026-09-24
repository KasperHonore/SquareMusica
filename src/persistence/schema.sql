-- Users table (for OAuth)
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  discord_id TEXT UNIQUE NOT NULL,
  username TEXT NOT NULL,
  avatar TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Play history
-- requested_by holds the display-name snapshot at play time; requested_by_id is
-- the stable Discord user id the DJ stats page groups on. Rows predating the
-- stats feature have a NULL requested_by_id, and that NULL-ness is the launch
-- boundary — no stats query counts them.
CREATE TABLE IF NOT EXISTS history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  guild_id TEXT,
  title TEXT NOT NULL,
  url TEXT NOT NULL,
  duration INTEGER,
  thumbnail TEXT,
  requested_by TEXT NOT NULL,
  requested_by_id TEXT,
  requested_by_avatar TEXT,
  played_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Recorded control actions and natural track completions, one row each.
-- guild_id mirrors history.guild_id for consistency and never keys state
-- (single-guild scope). created_at is UTC, so every read applies 'localtime'.
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  guild_id TEXT,
  event_type TEXT NOT NULL,
  actor_id TEXT,
  actor_name TEXT,
  actor_avatar TEXT,
  target_user_id TEXT,
  target_user_name TEXT,
  track_title TEXT,
  track_url TEXT,
  metadata TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Web sessions
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  token TEXT NOT NULL,
  expires_at DATETIME NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id)
);

-- Playlists (global, shared across all users)
CREATE TABLE IF NOT EXISTS playlists (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  spotify_url TEXT NOT NULL,
  cover_image TEXT,
  created_by TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_history_played_at ON history(played_at DESC);
CREATE INDEX IF NOT EXISTS idx_history_guild_id ON history(guild_id);
CREATE INDEX IF NOT EXISTS idx_sessions_token ON sessions(token);
CREATE INDEX IF NOT EXISTS idx_users_discord_id ON users(discord_id);
CREATE INDEX IF NOT EXISTS idx_playlists_created_at ON playlists(created_at);

-- Declared here as well as in migrate(): migrate() returns early when the
-- history table does not exist, which is exactly the fresh-install case, so an
-- index created only there would never exist on a new deployment and every
-- stats query would scan unindexed. IF NOT EXISTS makes the duplication safe.
CREATE INDEX IF NOT EXISTS idx_history_requested_by_id ON history(requested_by_id);
CREATE INDEX IF NOT EXISTS idx_events_type_created ON events(event_type, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_events_actor ON events(actor_id);
CREATE INDEX IF NOT EXISTS idx_events_target ON events(target_user_id);
