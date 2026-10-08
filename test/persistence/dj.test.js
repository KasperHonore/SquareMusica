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

describe('history.added_by_dj and getTopTracks (FR-021b, FR-027)', () => {
  const member = (id, url, title = url, extra = {}) => ({
    title,
    url,
    duration: 200,
    thumbnail: `thumb-${url}`,
    requestedBy: `name-${id}`,
    requestedById: id,
    ...extra
  });
  const djPick = (url) => ({
    title: url,
    url,
    duration: 180,
    requestedBy: 'SquareMusica DJ',
    requestedById: null,
    addedByDj: true
  });

  it('records added_by_dj = 1 for DJ picks and 0 for member tracks', () => {
    manager.addToHistory(djPick('https://yt/dj'), 'g', { addedByDj: true });
    manager.addToHistory(member('A', 'https://yt/m'), 'g');
    const rows = manager.db
      .prepare('SELECT url, added_by_dj, requested_by, requested_by_id FROM history ORDER BY id')
      .all();
    expect(rows).toEqual([
      {
        url: 'https://yt/dj',
        added_by_dj: 1,
        requested_by: 'SquareMusica DJ',
        requested_by_id: null
      },
      { url: 'https://yt/m', added_by_dj: 0, requested_by: 'name-A', requested_by_id: 'A' }
    ]);
  });

  it('orders by counted plays and excludes loop replays and DJ rows', () => {
    manager.addToHistory(member('A', 'https://yt/1'), 'g');
    manager.addToHistory(member('B', 'https://yt/2'), 'g');
    manager.addToHistory(member('A', 'https://yt/2'), 'g');
    // Loop replays and DJ picks of /3 must not lift it above /1.
    manager.addToHistory(member('A', 'https://yt/3'), 'g', { loopReplay: true });
    manager.addToHistory(member('A', 'https://yt/3'), 'g', { loopReplay: true });
    manager.addToHistory(djPick('https://yt/3'), 'g', { addedByDj: true });
    manager.addToHistory(djPick('https://yt/4'), 'g', { addedByDj: true });

    const top = manager.getTopTracks({ limit: 10 });
    expect(top.map((t) => [t.url, t.count])).toEqual([
      ['https://yt/2', 2],
      ['https://yt/1', 1]
    ]);
    expect(top[0]).toEqual({
      url: 'https://yt/2',
      title: 'https://yt/2',
      artist: null,
      count: 2,
      duration: 200,
      thumbnail: 'thumb-https://yt/2'
    });
  });

  it('filters by userIds and honours limit', () => {
    manager.addToHistory(member('A', 'https://yt/1'), 'g');
    manager.addToHistory(member('B', 'https://yt/2'), 'g');
    manager.addToHistory(member('B', 'https://yt/2'), 'g');
    expect(manager.getTopTracks({ userIds: ['A'], limit: 10 }).map((t) => t.url)).toEqual([
      'https://yt/1'
    ]);
    expect(manager.getTopTracks({ limit: 1 }).map((t) => t.url)).toEqual(['https://yt/2']);
    expect(manager.getTopTracks({ userIds: [], limit: 10 })).toEqual([]);
  });
});

describe('getDjSkipAward ignores skips of DJ picks (R8 awards gap)', () => {
  function skip(actorId, targetId) {
    manager.db
      .prepare(
        `INSERT INTO events (event_type, actor_id, actor_name, target_user_id, target_user_name)
         VALUES ('skip', ?, ?, ?, ?)`
      )
      .run(actorId, `name-${actorId}`, targetId, targetId ? `name-${targetId}` : null);
  }

  it('never returns a NULL-target group', () => {
    skip('A', null);
    skip('B', null);
    skip('C', null);
    expect(manager.getDjSkipAward({})).toBeUndefined();
    skip('A', 'B');
    expect(manager.getDjSkipAward({})).toMatchObject({ userId: 'B', value: 1 });
  });
});
