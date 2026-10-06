import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { DatabaseManager } from '../../src/persistence/db.js';

let dbm;

beforeEach(() => {
  dbm = new DatabaseManager(':memory:');
});

afterEach(() => {
  dbm.close();
});

describe('dj_settings (FR-013, FR-014)', () => {
  it('returns the defaults on a fresh database and creates row id = 1', () => {
    expect(dbm.getDjSettings()).toEqual({ enabled: false, interval: 3, lookahead: 5 });
    expect(dbm.db.prepare('SELECT id FROM dj_settings').all()).toEqual([{ id: 1 }]);
  });

  it('persists a partial update and leaves other fields alone', () => {
    dbm.getDjSettings();
    dbm.updateDjSettings({ interval: 4 });
    expect(dbm.getDjSettings()).toEqual({ enabled: false, interval: 4, lookahead: 5 });

    dbm.updateDjSettings({ enabled: true, lookahead: 10 });
    expect(dbm.getDjSettings()).toEqual({ enabled: true, interval: 4, lookahead: 10 });
  });

  it('rejects a second settings row', () => {
    dbm.getDjSettings();
    expect(() => dbm.db.prepare('INSERT INTO dj_settings (id) VALUES (2)').run()).toThrow();
  });

  it.each([0, 11])('rejects interval %i', (interval) => {
    expect(() =>
      dbm.db.prepare('INSERT INTO dj_settings (id, interval) VALUES (1, ?)').run(interval)
    ).toThrow();
  });

  it.each([3, 7])('rejects lookahead %i', (lookahead) => {
    expect(() =>
      dbm.db.prepare('INSERT INTO dj_settings (id, lookahead) VALUES (1, ?)').run(lookahead)
    ).toThrow();
  });
});

describe('dj_usage (FR-034)', () => {
  it('reads zeros for a day with no row', () => {
    expect(dbm.getDjUsage('2026-10-06')).toEqual({ lines: 0, themed_tracks: 0 });
  });

  it('upserts the counter', () => {
    dbm.incrementDjUsage('2026-10-06', 'lines');
    dbm.incrementDjUsage('2026-10-06', 'lines');
    dbm.incrementDjUsage('2026-10-06', 'themed_tracks');
    expect(dbm.getDjUsage('2026-10-06')).toEqual({ lines: 2, themed_tracks: 1 });
    expect(dbm.getDjUsage('2026-10-07')).toEqual({ lines: 0, themed_tracks: 0 });
  });

  it('only accepts whitelisted fields', () => {
    expect(() => dbm.incrementDjUsage('2026-10-06', 'bogus')).toThrow();
    expect(() => dbm.incrementDjUsage('2026-10-06', 'lines = 99; --')).toThrow();
  });
});
