import Database from 'better-sqlite3';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { mkdirSync, existsSync } from 'fs';
import { randomUUID } from 'crypto';

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
    const schema = readFileSync(join(__dirname, 'schema.sql'), 'utf8');
    this.db.exec(schema);
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
  createSession(userId, token, expiresAt) {
    const id = randomUUID();
    const stmt = this.db.prepare(
      'INSERT INTO sessions (id, user_id, token, expires_at) VALUES (?, ?, ?, ?)'
    );
    stmt.run(id, userId, token, expiresAt.toISOString());
    return { id, userId, token, expiresAt };
  }

  getSessionByToken(token) {
    const stmt = this.db.prepare(
      "SELECT * FROM sessions WHERE token = ? AND expires_at > datetime('now')"
    );
    return stmt.get(token);
  }

  deleteSession(id) {
    const stmt = this.db.prepare('DELETE FROM sessions WHERE id = ?');
    stmt.run(id);
  }

  deleteSessionByToken(token) {
    const stmt = this.db.prepare('DELETE FROM sessions WHERE token = ?');
    stmt.run(token);
  }

  cleanExpiredSessions() {
    const stmt = this.db.prepare("DELETE FROM sessions WHERE expires_at <= datetime('now')");
    return stmt.run();
  }

  // History methods
  addToHistory(track) {
    const stmt = this.db.prepare(
      'INSERT INTO history (title, url, duration, thumbnail, requested_by) VALUES (?, ?, ?, ?, ?)'
    );
    stmt.run(track.title, track.url, track.duration, track.thumbnail, track.requestedBy);
  }

  getHistory(limit = 50, offset = 0) {
    const stmt = this.db.prepare(
      'SELECT * FROM history ORDER BY played_at DESC LIMIT ? OFFSET ?'
    );
    return stmt.all(limit, offset);
  }

  close() {
    this.db.close();
  }
}

export const db = new DatabaseManager();
