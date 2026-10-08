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
  it('returns defaults on a fresh database and creates row id = 1', () => {
    expect(manager.getDjSettings()).toEqual({ enabled: false, interval: 3, lookahead: 5 });
    const rows = manager.db.prepare('SELECT id FROM dj_settings').all();
    expect(rows).toEqual([{ id: 1 }]);
  });

  it('persists a partial update and leaves other fields untouched', () => {
    manager.getDjSettings();
    manager.updateDjSettings({ interval: 4 });
    expect(manager.getDjSettings()).toEqual({ enabled: false, interval: 4, lookahead: 5 });

    manager.updateDjSettings({ enabled: true, lookahead: 10 });
    expect(manager.getDjSettings()).toEqual({ enabled: true, interval: 4, lookahead: 10 });
  });

  it('updateDjSettings works before getDjSettings created the row', () => {
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
  it('returns zeros for a day with no row', () => {
    expect(manager.getDjUsage('2026-10-08')).toEqual({ lines: 0, themed_tracks: 0 });
  });

  it('increments via upsert', () => {
    manager.incrementDjUsage('2026-10-08', 'lines');
    manager.incrementDjUsage('2026-10-08', 'lines');
    manager.incrementDjUsage('2026-10-08', 'themed_tracks');
    expect(manager.getDjUsage('2026-10-08')).toEqual({ lines: 2, themed_tracks: 1 });
    expect(manager.getDjUsage('2026-10-09')).toEqual({ lines: 0, themed_tracks: 0 });
  });

  it('rejects a field outside the whitelist', () => {
    expect(() => manager.incrementDjUsage('2026-10-08', 'bogus')).toThrow();
    expect(() => manager.incrementDjUsage('2026-10-08', 'lines = 99; --')).toThrow();
    expect(manager.getDjUsage('2026-10-08')).toEqual({ lines: 0, themed_tracks: 0 });
  });
});

describe('dj_shoutout_optouts table', () => {
  it('exists on a fresh database', () => {
    expect(() =>
      manager.db.prepare('INSERT INTO dj_shoutout_optouts (user_id) VALUES (?)').run('123')
    ).not.toThrow();
  });
});

describe('themed-mode history (US4, FR-021b, FR-027)', () => {
  const play = (url, userId, { loopReplay = false, addedByDj = false, title = url } = {}) =>
    manager.addToHistory(
      {
        title,
        url,
        duration: 200,
        thumbnail: `${url}.jpg`,
        requestedBy: addedByDj ? 'SquareMusica DJ' : `user-${userId}`,
        requestedById: addedByDj ? null : userId,
        addedByDj
      },
      'g1',
      { loopReplay, addedByDj }
    );

  it('addToHistory writes added_by_dj = 1 and requested_by_id NULL for a DJ pick', () => {
    play('dj-url', null, { addedByDj: true });
    play('member-url', 'A');
    const rows = manager.db
      .prepare('SELECT url, added_by_dj, requested_by, requested_by_id FROM history ORDER BY id')
      .all();
    expect(rows).toEqual([
      { url: 'dj-url', added_by_dj: 1, requested_by: 'SquareMusica DJ', requested_by_id: null },
      { url: 'member-url', added_by_dj: 0, requested_by: 'user-A', requested_by_id: 'A' }
    ]);
  });

  it('getTopTracks counts plays, excluding loop replays and DJ picks', () => {
    play('u1', 'A');
    play('u1', 'B');
    play('u1', 'A', { loopReplay: true });
    play('u1', null, { addedByDj: true });
    play('u2', 'A');
    play('u2', 'A', { loopReplay: true });
    play('u2', 'A', { loopReplay: true });
    play('dj-only', null, { addedByDj: true });
    play('dj-only', null, { addedByDj: true });

    const top = manager.getTopTracks({ limit: 10 });
    expect(top.map(({ url, count }) => ({ url, count }))).toEqual([
      { url: 'u1', count: 2 },
      { url: 'u2', count: 1 }
    ]);
    expect(top[0]).toMatchObject({ title: 'u1', duration: 200, thumbnail: 'u1.jpg' });
    expect(top[0]).toHaveProperty('artist');
  });

  it('getTopTracks with userIds counts only those members, and honours limit', () => {
    play('u1', 'A');
    play('u2', 'B');
    play('u2', 'B');
    play('u3', 'C');
    expect(manager.getTopTracks({ userIds: ['A', 'C'], limit: 10 }).map((t) => t.url)).toEqual([
      'u1',
      'u3'
    ]);
    expect(manager.getTopTracks({ limit: 1 }).map((t) => t.url)).toEqual(['u2']);
    expect(manager.getTopTracks({ userIds: [], limit: 10 })).toEqual([]);
  });

  it('getDjSkipAward ignores skip events whose target is NULL (DJ picks)', () => {
    const skip = (actor, target) =>
      manager.logEvent({
        type: 'skip',
        actor: { id: actor, name: `user-${actor}` },
        track: {
          title: 'T',
          url: 'u',
          requestedById: target,
          requestedBy: target ? `user-${target}` : 'SquareMusica DJ'
        }
      });
    for (let i = 0; i < 5; i++) skip('A', null);
    skip('A', 'B');

    const award = manager.getDjSkipAward();
    expect(award?.userId).toBe('B');
    expect(award?.value).toBe(1);
  });
});
