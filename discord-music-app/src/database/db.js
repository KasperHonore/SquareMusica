import Database from 'better-sqlite3';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { mkdirSync, existsSync } from 'fs';
import { randomUUID, createHash } from 'crypto';

const __dirname = dirname(fileURLToPath(import.meta.url));

class DatabaseManager {
  constructor() {
    // Ensure data directory exists
    const dataDir = join(__dirname, '../../data');
    if (!existsSync(dataDir)) {
      mkdirSync(dataDir, { recursive: true });
    }

    this.db = new Database(join(dataDir, 'music.db'));
    this.db.pragma('journal_mode = WAL');
    this.init();
  }

  init() {
    // Run migrations before schema to handle existing tables
    this.migrate();
    const schema = readFileSync(join(__dirname, 'schema.sql'), 'utf8');
    this.db.exec(schema);
    console.log('[Database] Schema initialized successfully');
  }

  migrate() {
    // Check if history table exists first
    const tables = this.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='history'").all();
    if (tables.length === 0) {
      return; // Table doesn't exist yet, schema.sql will create it with guild_id
    }

    // Add guild_id column to history table if it doesn't exist
    const tableInfo = this.db.pragma('table_info(history)');
    const hasGuildId = tableInfo.some(col => col.name === 'guild_id');
    if (!hasGuildId) {
      this.db.exec('ALTER TABLE history ADD COLUMN guild_id TEXT');
      this.db.exec('CREATE INDEX IF NOT EXISTS idx_history_guild_id ON history(guild_id)');
      console.log('[Database] Migrated: added guild_id to history table');
    }
  }

  // User methods
  findOrCreateUser(discordId, username, avatar) {
    const existing = this.getUserByDiscordId(discordId);
    if (existing) {
      // Update user info
      const stmt = this.db.prepare(
        'UPDATE users SET username = ?, avatar = ? WHERE discord_id = ?'
      );
      stmt.run(username, avatar, discordId);
      return this.getUserByDiscordId(discordId);
    }

    const id = randomUUID();
    const stmt = this.db.prepare(
      'INSERT INTO users (id, discord_id, username, avatar) VALUES (?, ?, ?, ?)'
    );
    stmt.run(id, discordId, username, avatar);
    return this.getUserById(id);
  }

  getUserById(id) {
    const stmt = this.db.prepare('SELECT * FROM users WHERE id = ?');
    return stmt.get(id);
  }

  getUserByDiscordId(discordId) {
    const stmt = this.db.prepare('SELECT * FROM users WHERE discord_id = ?');
    return stmt.get(discordId);
  }

  // Session methods
  hashToken(token) {
    return createHash('sha256').update(String(token)).digest('hex');
  }

  createSession(userId, token, expiresAt) {
    const id = randomUUID();
    const tokenHash = this.hashToken(token);
    const stmt = this.db.prepare(
      'INSERT INTO sessions (id, user_id, token, expires_at) VALUES (?, ?, ?, ?)'
    );
    stmt.run(id, userId, tokenHash, expiresAt.toISOString());
    return { id, userId, expiresAt };
  }

  getSessionByToken(token) {
    const tokenHash = this.hashToken(token);
    const stmt = this.db.prepare(
      "SELECT * FROM sessions WHERE token = ? AND expires_at > datetime('now')"
    );
    return stmt.get(tokenHash);
  }

  deleteSessionByToken(token) {
    const tokenHash = this.hashToken(token);
    const stmt = this.db.prepare('DELETE FROM sessions WHERE token = ?');
    stmt.run(tokenHash);
  }

  // History methods
  addToHistory(track, guildId = null) {
    try {
      if (!track?.title || !track?.url) {
        console.warn('[Database] addToHistory: Missing required track fields', { title: track?.title, url: track?.url });
        return;
      }
      const stmt = this.db.prepare(
        'INSERT INTO history (guild_id, title, url, duration, thumbnail, requested_by) VALUES (?, ?, ?, ?, ?, ?)'
      );
      stmt.run(guildId, track.title, track.url, track.duration || 0, track.thumbnail || null, track.requestedBy || 'Unknown');
    } catch (error) {
      console.error('[Database] addToHistory failed:', error.message, { track: track?.title });
    }
  }

  getHistory(limit = 50, offset = 0) {
    const stmt = this.db.prepare(
      'SELECT * FROM history ORDER BY played_at DESC LIMIT ? OFFSET ?'
    );
    return stmt.all(limit, offset);
  }

  clearHistoryByGuild(guildId) {
    try {
      // Clear history for this guild, including old records with NULL guild_id
      const stmt = this.db.prepare('DELETE FROM history WHERE guild_id = ? OR guild_id IS NULL');
      const result = stmt.run(guildId);
      console.log(`[Database] Cleared ${result.changes} history entries for guild ${guildId}`);
      return result.changes;
    } catch (error) {
      console.error('[Database] clearHistoryByGuild failed:', error.message);
      return 0;
    }
  }

  clearAllHistory() {
    try {
      const stmt = this.db.prepare('DELETE FROM history');
      const result = stmt.run();
      console.log(`[Database] Cleared all ${result.changes} history entries`);
      return result.changes;
    } catch (error) {
      console.error('[Database] clearAllHistory failed:', error.message);
      return 0;
    }
  }

  // Playlist methods
  getPlaylists() {
    const stmt = this.db.prepare('SELECT * FROM playlists ORDER BY created_at DESC');
    return stmt.all();
  }

  createPlaylist(id, name, spotifyUrl, coverImage, createdBy) {
    try {
      const stmt = this.db.prepare(
        'INSERT INTO playlists (id, name, spotify_url, cover_image, created_by) VALUES (?, ?, ?, ?, ?)'
      );
      stmt.run(id, name, spotifyUrl, coverImage || null, createdBy || null);
      return this.getPlaylistById(id);
    } catch (error) {
      console.error('[Database] createPlaylist failed:', error.message);
      return null;
    }
  }

  getPlaylistById(id) {
    const stmt = this.db.prepare('SELECT * FROM playlists WHERE id = ?');
    return stmt.get(id);
  }

  deletePlaylist(id) {
    try {
      const stmt = this.db.prepare('DELETE FROM playlists WHERE id = ?');
      const result = stmt.run(id);
      return result.changes > 0;
    } catch (error) {
      console.error('[Database] deletePlaylist failed:', error.message);
      return false;
    }
  }

  close() {
    this.db.close();
  }
}

export const db = new DatabaseManager();
