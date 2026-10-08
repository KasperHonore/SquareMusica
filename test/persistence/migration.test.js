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

// The shape every development database on the stats branch has: both
// attribution columns already migrated in, but no is_loop_replay. This is the
// case a nested guard would miss.
const PRE_LOOP_REPLAY_HISTORY_SCHEMA = `
  CREATE TABLE history (
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
`;

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

  it('creates history with both stats columns and is_loop_replay', () => {
    const manager = new DatabaseManager(dbPath);

    const columns = columnNames(manager.db, 'history');
    expect(columns).toContain('requested_by_id');
    expect(columns).toContain('requested_by_avatar');
    expect(columns).toContain('is_loop_replay');

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

describe('DatabaseManager.migrate() — upgrade from a database without is_loop_replay', () => {
  function seedPreLoopReplayDatabase() {
    const seed = new Database(dbPath);
    seed.exec(PRE_LOOP_REPLAY_HISTORY_SCHEMA);
    seed
      .prepare(
        'INSERT INTO history (title, url, duration, requested_by, requested_by_id, requested_by_avatar) VALUES (?, ?, ?, ?, ?, ?)'
      )
      .run('Stats Song', 'https://example.com/stats', 180, 'dj-A', 'A', 'avatar-A');
    const columns = columnNames(seed, 'history');
    expect(columns).toContain('requested_by_id');
    expect(columns).not.toContain('is_loop_replay');
    seed.close();
  }

  it('adds is_loop_replay even though the other stats columns already exist', () => {
    seedPreLoopReplayDatabase();

    const manager = new DatabaseManager(dbPath);

    const column = manager.db
      .pragma('table_info(history)')
      .find((col) => col.name === 'is_loop_replay');
    expect(column).toBeDefined();
    expect(column.notnull).toBe(1);
    expect(column.dflt_value).toBe('0');

    manager.close();
  });

  it('reads existing rows as ordinary counted plays', () => {
    seedPreLoopReplayDatabase();

    const manager = new DatabaseManager(dbPath);

    const row = manager.db.prepare('SELECT * FROM history WHERE title = ?').get('Stats Song');
    expect(row.is_loop_replay).toBe(0);
    expect(row.requested_by_id).toBe('A');
    expect(manager.getLeaderboard({ since: null, limit: 10 })[0].trackCount).toBe(1);

    manager.close();
  });

  it('is a no-op when run twice', () => {
    seedPreLoopReplayDatabase();

    new DatabaseManager(dbPath).close();

    let second;
    expect(() => {
      second = new DatabaseManager(dbPath);
    }).not.toThrow();
    expect(columnNames(second.db, 'history').filter((c) => c === 'is_loop_replay')).toHaveLength(1);

    second.close();
  });
});

describe('DatabaseManager.migrate() — AI DJ history.artist (feature 002)', () => {
  it('adds a nullable artist column and idx_history_url; old rows read as null', () => {
    seedLegacyDatabase();

    const manager = new DatabaseManager(dbPath);
    const column = manager.db.pragma('table_info(history)').find((col) => col.name === 'artist');
    expect(column).toBeDefined();
    expect(column.notnull).toBe(0);
    expect(indexNames(manager.db, 'history')).toContain('idx_history_url');
    expect(manager.db.prepare('SELECT artist FROM history').get().artist).toBeNull();
    manager.close();

    let second;
    expect(() => {
      second = new DatabaseManager(dbPath);
    }).not.toThrow();
    expect(columnNames(second.db, 'history').filter((c) => c === 'artist')).toHaveLength(1);
    second.close();
  });

  it('creates dj_member_names on an existing database, idempotently', () => {
    seedLegacyDatabase();

    const manager = new DatabaseManager(dbPath);
    expect(columnNames(manager.db, 'dj_member_names')).toEqual(
      expect.arrayContaining(['user_id', 'display_name', 'seen_at'])
    );
    manager.recordMemberNames([{ userId: 'K', displayName: 'kasper' }]);
    manager.close();

    const second = new DatabaseManager(dbPath);
    expect(second.getKnownDisplayNames()).toEqual(['kasper']);
    second.close();
  });

  it('creates artist and idx_history_url on a fresh install', () => {
    const manager = new DatabaseManager(dbPath);
    expect(columnNames(manager.db, 'history')).toContain('artist');
    expect(indexNames(manager.db, 'history')).toContain('idx_history_url');
    manager.close();
  });
});

describe('DatabaseManager.migrate() — AI DJ history.added_by_dj (FR-027)', () => {
  it('adds added_by_dj as INTEGER NOT NULL DEFAULT 0; old rows read 0', () => {
    seedLegacyDatabase();

    const manager = new DatabaseManager(dbPath);
    const column = manager.db
      .pragma('table_info(history)')
      .find((col) => col.name === 'added_by_dj');
    expect(column).toBeDefined();
    expect(column.type).toBe('INTEGER');
    expect(column.notnull).toBe(1);
    expect(column.dflt_value).toBe('0');
    expect(manager.db.prepare('SELECT added_by_dj FROM history').get().added_by_dj).toBe(0);
    manager.close();

    let second;
    expect(() => {
      second = new DatabaseManager(dbPath);
    }).not.toThrow();
    expect(columnNames(second.db, 'history').filter((c) => c === 'added_by_dj')).toHaveLength(1);
    second.close();
  });

  it('creates added_by_dj on a fresh install', () => {
    const manager = new DatabaseManager(dbPath);
    expect(columnNames(manager.db, 'history')).toContain('added_by_dj');
    manager.close();
  });
});
