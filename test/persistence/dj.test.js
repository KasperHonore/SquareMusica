import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { DatabaseManager } from '../../src/persistence/db.js';

let manager;

beforeEach(() => {
  manager = new DatabaseManager(':memory:');
});

afterEach(() => {
  manager.close();
});

describe('dj_settings (FR-012, FR-013, FR-014)', () => {
  it('getDjSettings() on a fresh database returns the defaults and creates row id = 1', () => {
    expect(manager.getDjSettings()).toEqual({ enabled: false, interval: 3, lookahead: 5 });
    const rows = manager.db.prepare('SELECT id FROM dj_settings').all();
    expect(rows).toEqual([{ id: 1 }]);
  });

  it('updateDjSettings() persists a partial change and leaves the rest', () => {
    manager.updateDjSettings({ interval: 4 });
    expect(manager.getDjSettings()).toEqual({ enabled: false, interval: 4, lookahead: 5 });

    manager.updateDjSettings({ enabled: true, lookahead: 10 });
    expect(manager.getDjSettings()).toEqual({ enabled: true, interval: 4, lookahead: 10 });
  });

  it('rejects a second settings row', () => {
    manager.getDjSettings();
    expect(() => manager.db.prepare('INSERT INTO dj_settings (id) VALUES (2)').run()).toThrow(
      /CHECK/
    );
  });

  it.each([0, 11])('rejects interval %i', (interval) => {
    expect(() =>
      manager.db.prepare('INSERT INTO dj_settings (id, interval) VALUES (1, ?)').run(interval)
    ).toThrow(/CHECK/);
  });

  it.each([3, 7])('rejects lookahead %i', (lookahead) => {
    expect(() =>
      manager.db.prepare('INSERT INTO dj_settings (id, lookahead) VALUES (1, ?)').run(lookahead)
    ).toThrow(/CHECK/);
  });
});

describe('dj_usage (FR-033)', () => {
  it('returns zeros for a day with no row', () => {
    expect(manager.getDjUsage('2026-10-06')).toEqual({ lines: 0, themed_tracks: 0 });
  });

  it('incrementDjUsage() upserts', () => {
    manager.incrementDjUsage('2026-10-06', 'lines');
    manager.incrementDjUsage('2026-10-06', 'lines');
    manager.incrementDjUsage('2026-10-06', 'themed_tracks');
    expect(manager.getDjUsage('2026-10-06')).toEqual({ lines: 2, themed_tracks: 1 });
    expect(manager.getDjUsage('2026-10-07')).toEqual({ lines: 0, themed_tracks: 0 });
  });

  it('rejects a field outside the whitelist', () => {
    expect(() => manager.incrementDjUsage('2026-10-06', 'bogus')).toThrow(/bogus/);
    expect(() => manager.incrementDjUsage('2026-10-06', 'lines = 0; --')).toThrow();
  });

  it('pruneDjUsage() drops rows older than 30 days', () => {
    manager.incrementDjUsage('2000-01-01', 'lines');
    const today = manager.db.prepare("SELECT date('now','localtime') AS d").get().d;
    manager.incrementDjUsage(today, 'lines');
    manager.pruneDjUsage();
    expect(manager.getDjUsage('2000-01-01').lines).toBe(0);
    expect(manager.getDjUsage(today).lines).toBe(1);
  });
});
