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

describe('dj_settings (FR-013, FR-014)', () => {
  it('returns the defaults on a fresh database and creates row id = 1', () => {
    expect(manager.getDjSettings()).toEqual({ enabled: false, interval: 3, lookahead: 5 });

    const rows = manager.db.prepare('SELECT id FROM dj_settings').all();
    expect(rows).toEqual([{ id: 1 }]);
  });

  it('updateDjSettings persists a partial update and leaves other fields alone', () => {
    manager.getDjSettings();
    manager.updateDjSettings({ interval: 4 });
    expect(manager.getDjSettings()).toEqual({ enabled: false, interval: 4, lookahead: 5 });

    manager.updateDjSettings({ enabled: true, lookahead: 10 });
    expect(manager.getDjSettings()).toEqual({ enabled: true, interval: 4, lookahead: 10 });
  });

  it('updateDjSettings works before the row has been read', () => {
    manager.updateDjSettings({ enabled: true });
    expect(manager.getDjSettings().enabled).toBe(true);
  });

  it('rejects a second settings row (CHECK id = 1)', () => {
    manager.getDjSettings();
    expect(() => manager.db.prepare('INSERT INTO dj_settings (id) VALUES (2)').run()).toThrow();
  });

  it('rejects an interval outside 1..10', () => {
    for (const bad of [0, 11]) {
      expect(() =>
        manager.db.prepare('INSERT INTO dj_settings (id, interval) VALUES (1, ?)').run(bad)
      ).toThrow();
    }
  });

  it('rejects a lookahead other than 5 or 10', () => {
    expect(() =>
      manager.db.prepare('INSERT INTO dj_settings (id, lookahead) VALUES (1, 7)').run()
    ).toThrow();
  });
});

describe('dj_usage (FR-034, R9)', () => {
  it('returns zeros for a day with no row', () => {
    expect(manager.getDjUsage('2026-10-08')).toEqual({ lines: 0, themed_tracks: 0 });
  });

  it('incrementDjUsage upserts and counts', () => {
    manager.incrementDjUsage('2026-10-08', 'lines');
    manager.incrementDjUsage('2026-10-08', 'lines');
    manager.incrementDjUsage('2026-10-08', 'themed_tracks');

    expect(manager.getDjUsage('2026-10-08')).toEqual({ lines: 2, themed_tracks: 1 });
    expect(manager.getDjUsage('2026-10-09')).toEqual({ lines: 0, themed_tracks: 0 });
  });

  it('incrementDjUsage rejects a field outside the whitelist', () => {
    expect(() => manager.incrementDjUsage('2026-10-08', 'bogus')).toThrow();
    expect(() => manager.incrementDjUsage('2026-10-08', 'lines = 0; --')).toThrow();
  });
});
