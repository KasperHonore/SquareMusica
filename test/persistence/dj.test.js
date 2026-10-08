import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('../../src/utils/logger.js', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() }
}));

import { DatabaseManager } from '../../src/persistence/db.js';

let manager;

beforeEach(() => {
  manager = new DatabaseManager(':memory:');
});

afterEach(() => {
  manager.close();
});

describe('dj_settings (FR-013, FR-014, R11)', () => {
  it('returns the defaults on a fresh database and creates row id = 1', () => {
    expect(manager.getDjSettings()).toEqual({ enabled: false, interval: 3, lookahead: 5 });
    const rows = manager.db.prepare('SELECT id FROM dj_settings').all();
    expect(rows).toEqual([{ id: 1 }]);
  });

  it('getDjSettings is idempotent: repeated calls never add rows', () => {
    manager.getDjSettings();
    manager.getDjSettings();
    expect(manager.db.prepare('SELECT COUNT(*) AS n FROM dj_settings').get().n).toBe(1);
  });

  it('updateDjSettings persists a partial update and leaves other fields alone', () => {
    manager.getDjSettings();
    manager.updateDjSettings({ interval: 4 });
    expect(manager.getDjSettings()).toEqual({ enabled: false, interval: 4, lookahead: 5 });

    manager.updateDjSettings({ enabled: true, lookahead: 10 });
    expect(manager.getDjSettings()).toEqual({ enabled: true, interval: 4, lookahead: 10 });
  });

  it('updateDjSettings works before the row was ever read', () => {
    manager.updateDjSettings({ enabled: true });
    expect(manager.getDjSettings().enabled).toBe(true);
  });

  it('rejects a second settings row (CHECK id = 1)', () => {
    manager.getDjSettings();
    expect(() => manager.db.prepare('INSERT INTO dj_settings (id) VALUES (2)').run()).toThrow();
  });

  it.each([0, 11])('rejects interval %i (CHECK BETWEEN 1 AND 10)', (interval) => {
    expect(() =>
      manager.db.prepare('INSERT INTO dj_settings (id, interval) VALUES (1, ?)').run(interval)
    ).toThrow();
  });

  it.each([4, 6, 0])('rejects lookahead %i (CHECK IN (5, 10))', (lookahead) => {
    expect(() =>
      manager.db.prepare('INSERT INTO dj_settings (id, lookahead) VALUES (1, ?)').run(lookahead)
    ).toThrow();
  });
});

describe('dj_usage (FR-034, R9)', () => {
  const day = '2026-10-08';

  it('reads zeros for a day with no row', () => {
    expect(manager.getDjUsage(day)).toEqual({ lines: 0, themed_tracks: 0 });
  });

  it('increments via upsert', () => {
    manager.incrementDjUsage(day, 'lines');
    manager.incrementDjUsage(day, 'lines');
    manager.incrementDjUsage(day, 'themed_tracks');
    expect(manager.getDjUsage(day)).toEqual({ lines: 2, themed_tracks: 1 });
    expect(manager.getDjUsage('2026-10-09')).toEqual({ lines: 0, themed_tracks: 0 });
  });

  it('rejects a field outside the whitelist', () => {
    expect(() => manager.incrementDjUsage(day, 'bogus')).toThrow();
    expect(() => manager.incrementDjUsage(day, 'lines = 0; --')).toThrow();
    expect(manager.getDjUsage(day)).toEqual({ lines: 0, themed_tracks: 0 });
  });
});

describe('dj_shoutout_optouts table', () => {
  it('exists with user_id as primary key', () => {
    const cols = manager.db.pragma('table_info(dj_shoutout_optouts)');
    expect(cols.find((c) => c.name === 'user_id')?.pk).toBe(1);
  });
});
