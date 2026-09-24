import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { DatabaseManager } from '../../src/persistence/db.js';

// The pre-stats history table, exactly as it shipped: no requested_by_id and no
// requested_by_avatar. Seeding this shape is what makes these upgrade tests
// rather than fresh-install tests — migrate() returns early when `history` does
// not exist, so a fresh database never reaches the ALTER TABLE path at all.
const LEGACY_HISTORY_SCHEMA = `
  CREATE TABLE history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    guild_id TEXT,
    title TEXT NOT NULL,
    url TEXT NOT NULL,
    duration INTEGER,
    thumbnail TEXT,
    requested_by TEXT NOT NULL,
    played_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
`;

let tmpDir;
let dbPath;

// A temp file, not ':memory:' — every in-memory connection is a private
// database, so the seeded legacy table has to live somewhere DatabaseManager's
// own handle can reopen it. That is what lets these tests drive the real
// migrate() instead of a copy of it.
beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'squaremusica-migration-'));
  dbPath = join(tmpDir, 'music.db');
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

function columnNames(db, table) {
  return db.pragma(`table_info(${table})`).map((col) => col.name);
}

function indexNames(db, table) {
  return db.pragma(`index_list(${table})`).map((idx) => idx.name);
}

function seedLegacyDatabase() {
  const seed = new Database(dbPath);
  seed.exec(LEGACY_HISTORY_SCHEMA);
  seed
    .prepare('INSERT INTO history (title, url, duration, requested_by) VALUES (?, ?, ?, ?)')
    .run('Old Song', 'https://example.com/old', 210, 'legacy-dj');
  expect(columnNames(seed, 'history')).not.toContain('requested_by_id');
  seed.close();
}

describe('DatabaseManager.migrate() — fresh install', () => {
  it('creates the events table and its three indexes', () => {
    const manager = new DatabaseManager(dbPath);

    const tables = manager.db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='events'")
      .all();
    expect(tables).toHaveLength(1);

    const eventIndexes = indexNames(manager.db, 'events');
    expect(eventIndexes).toContain('idx_events_type_created');
    expect(eventIndexes).toContain('idx_events_actor');
    expect(eventIndexes).toContain('idx_events_target');

    manager.close();
  });

  it('creates idx_history_requested_by_id even though migrate() returns early', () => {
    // The regression the duplicated index declaration exists for: on a fresh
    // database migrate() bails before its own CREATE INDEX, so this index can
    // only come from schema.sql. Without it every stats query scans unindexed.
    const manager = new DatabaseManager(dbPath);

    expect(indexNames(manager.db, 'history')).toContain('idx_history_requested_by_id');

    manager.close();
  });

  it('creates history with both stats columns', () => {
    const manager = new DatabaseManager(dbPath);

    const columns = columnNames(manager.db, 'history');
    expect(columns).toContain('requested_by_id');
    expect(columns).toContain('requested_by_avatar');

    manager.close();
  });
});

describe('DatabaseManager.migrate() — upgrade from a pre-stats database', () => {
  it('adds both stats columns to the existing history table', () => {
    seedLegacyDatabase();

    const manager = new DatabaseManager(dbPath);

    const columns = columnNames(manager.db, 'history');
    expect(columns).toContain('requested_by_id');
    expect(columns).toContain('requested_by_avatar');

    manager.close();
  });

  it('keeps pre-existing rows intact with NULL in both new columns', () => {
    seedLegacyDatabase();

    const manager = new DatabaseManager(dbPath);

    const row = manager.db.prepare('SELECT * FROM history WHERE title = ?').get('Old Song');
    expect(row.title).toBe('Old Song');
    expect(row.requested_by).toBe('legacy-dj');
    expect(row.duration).toBe(210);
    // NULL here is the launch boundary, not missing data: no stats query counts
    // a row whose requested_by_id is NULL.
    expect(row.requested_by_id).toBeNull();
    expect(row.requested_by_avatar).toBeNull();

    manager.close();
  });

  it('adds the events table alongside the migrated history table', () => {
    seedLegacyDatabase();

    const manager = new DatabaseManager(dbPath);

    const tables = manager.db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='events'")
      .all();
    expect(tables).toHaveLength(1);
    expect(indexNames(manager.db, 'history')).toContain('idx_history_requested_by_id');

    manager.close();
  });

  it('is a no-op when run twice — migrate() runs on every boot', () => {
    seedLegacyDatabase();

    const first = new DatabaseManager(dbPath);
    const columnsAfterFirst = columnNames(first.db, 'history');
    const rowsAfterFirst = first.db.prepare('SELECT COUNT(*) AS n FROM history').get().n;
    first.close();

    // Second boot against the already-migrated file must not throw on the
    // ALTER TABLE statements, and must not disturb the data.
    let second;
    expect(() => {
      second = new DatabaseManager(dbPath);
    }).not.toThrow();

    expect(columnNames(second.db, 'history')).toEqual(columnsAfterFirst);
    expect(second.db.prepare('SELECT COUNT(*) AS n FROM history').get().n).toBe(rowsAfterFirst);
    expect(second.db.prepare('SELECT * FROM history').get().requested_by).toBe('legacy-dj');

    second.close();
  });
});
