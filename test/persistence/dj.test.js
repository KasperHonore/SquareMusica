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

function play(
  m,
  { url, title = 'Song', userId, name = `name-${userId}`, loop = 0, artist = null, playedAt = null }
) {
  m.db
    .prepare(
      `INSERT INTO history (title, url, requested_by, requested_by_id, is_loop_replay, artist, played_at)
       VALUES (?, ?, ?, ?, ?, ?, COALESCE(?, CURRENT_TIMESTAMP))`
    )
    .run(title, url, name, userId ?? null, loop, artist, playedAt);
}

describe('dj_shoutout_optouts (FR-019)', () => {
  it('setShoutoutOptOut(uid, true) opts out; false deletes the row', () => {
    expect(manager.isShoutoutOptedOut('A')).toBe(false);
    manager.setShoutoutOptOut('A', true);
    manager.setShoutoutOptOut('A', true);
    expect(manager.isShoutoutOptedOut('A')).toBe(true);
    expect(manager.getShoutoutOptOuts()).toEqual(new Set(['A']));

    manager.setShoutoutOptOut('A', false);
    expect(manager.isShoutoutOptedOut('A')).toBe(false);
    expect(manager.getShoutoutOptOuts().size).toBe(0);
    expect(manager.db.prepare('SELECT COUNT(*) AS n FROM dj_shoutout_optouts').get().n).toBe(0);
  });
});

describe('DJ grounding reads (R6, FR-018)', () => {
  it('getUserPlayCountsForUrl() excludes loop replays and DJ picks', () => {
    const url = 'https://y/x';
    for (let i = 0; i < 3; i++) play(manager, { url, userId: 'A' });
    play(manager, { url, userId: 'A', loop: 1 });
    play(manager, { url, userId: 'B' });
    play(manager, { url, userId: null, name: 'SquareMusica DJ' });
    play(manager, { url: 'https://y/other', userId: 'A' });
    play(manager, { url, userId: 'C' });

    expect(manager.getUserPlayCountsForUrl(url, ['A', 'B'])).toEqual([
      { userId: 'A', count: 3 },
      { userId: 'B', count: 1 }
    ]);
    expect(manager.getUserPlayCountsForUrl(url, [])).toEqual([]);
  });

  it('getUserTopTrack() returns the most-played counted track, or null', () => {
    expect(manager.getUserTopTrack('A')).toBeNull();
    play(manager, { url: 'https://y/loop', userId: 'A', loop: 1 });
    expect(manager.getUserTopTrack('A')).toBeNull();

    play(manager, { url: 'https://y/1', title: 'One', userId: 'A' });
    play(manager, { url: 'https://y/2', title: 'Two', userId: 'A' });
    play(manager, { url: 'https://y/2', title: 'Two', userId: 'A' });
    for (let i = 0; i < 5; i++) play(manager, { url: 'https://y/loop', userId: 'A', loop: 1 });
    expect(manager.getUserTopTrack('A')).toEqual({ url: 'https://y/2', title: 'Two', count: 2 });
  });

  it('getKnownMemberNames() returns the latest name per member and never DJ picks', () => {
    play(manager, { url: 'u', userId: 'A', name: 'Old A' });
    play(manager, { url: 'u', userId: 'A', name: 'New A' });
    play(manager, { url: 'u', userId: 'B', name: 'Bea' });
    play(manager, { url: 'u', userId: null, name: 'SquareMusica DJ' });
    play(manager, { url: 'u', userId: null, name: 'Legacy Person' });

    const names = manager.getKnownMemberNames();
    expect(names.sort()).toEqual(['Bea', 'New A']);
    expect(names).not.toContain('SquareMusica DJ');
  });

  it('recordMemberNames() keeps every display name seen per member', () => {
    manager.recordMemberNames([
      { userId: 'A', displayName: 'Anna' },
      { userId: 'B', displayName: null }
    ]);
    manager.recordMemberNames([{ userId: 'A', displayName: 'Anna B.' }]);
    manager.recordMemberNames([{ userId: 'A', displayName: 'Anna' }]);
    expect(manager.getKnownDisplayNames()).toEqual(['Anna', 'Anna B.']);
  });

  it('getArtistQueuersSince() counts distinct present members in the window', () => {
    play(manager, { url: 'u1', userId: 'A', artist: 'ABBA' });
    play(manager, { url: 'u2', userId: 'A', artist: 'abba' });
    play(manager, { url: 'u3', userId: 'B', artist: 'ABBA' });
    play(manager, { url: 'u4', userId: 'C', artist: 'ABBA' }); // not present
    play(manager, { url: 'u5', userId: 'D', artist: 'ABBA', loop: 1 }); // loop replay
    play(manager, { url: 'u6', userId: 'E', artist: 'ABBA', playedAt: '2000-01-01 12:00:00' });
    play(manager, { url: 'u7', userId: 'F', artist: null });

    expect(manager.getArtistQueuersSince('Abba', ['A', 'B', 'D', 'E', 'F'], 7)).toBe(2);
    expect(manager.getArtistQueuersSince(null, ['F'], 7)).toBe(0);
    expect(manager.getArtistQueuersSince('', ['F'], 7)).toBe(0);
  });

  it('addToHistory() writes the artist from Spotify data, else the channel', () => {
    manager.addToHistory({
      title: 'S',
      url: 'u1',
      requestedBy: 'A',
      requestedById: 'A',
      channel: 'Chan',
      spotifyData: { artists: ['Spot Artist'] }
    });
    manager.addToHistory({ title: 'S', url: 'u2', requestedBy: 'A', channel: 'Chan' });
    manager.addToHistory({ title: 'S', url: 'u3', requestedBy: 'A' });
    const rows = manager.db.prepare('SELECT url, artist FROM history ORDER BY id').all();
    expect(rows.map((r) => r.artist)).toEqual(['Spot Artist', 'Chan', null]);
  });
});

describe('themed-mode history (FR-021b, FR-027)', () => {
  const play = (url, userId, { loop = false, dj = false, title = url, artist = null } = {}) =>
    manager.db
      .prepare(
        `INSERT INTO history (title, url, duration, requested_by, requested_by_id,
           is_loop_replay, artist, added_by_dj)
         VALUES (?, ?, 200, ?, ?, ?, ?, ?)`
      )
      .run(title, url, userId ?? 'SquareMusica DJ', userId, loop ? 1 : 0, artist, dj ? 1 : 0);

  it('getTopTracks() ranks counted plays and excludes loop replays and DJ rows', () => {
    play('a', 'U1', { artist: 'ABBA', title: 'Dancing Queen' });
    play('a', 'U1', { title: 'Dancing Queen' });
    play('b', 'U2');
    play('b', 'U2', { loop: true });
    play('b', 'U2', { loop: true });
    play('c', null, { dj: true });
    play('c', null, { dj: true });
    play('c', null, { dj: true });

    const rows = manager.getTopTracks({ limit: 10 });
    expect(rows.map((r) => [r.url, r.count])).toEqual([
      ['a', 2],
      ['b', 1]
    ]);
    expect(rows[0]).toMatchObject({ title: 'Dancing Queen', artist: 'ABBA', duration: 200 });
    expect(rows[1].artist).toBeNull();
  });

  it('getTopTracks({ userIds }) counts only those members’ plays', () => {
    play('a', 'U1');
    play('b', 'U2');
    play('b', 'U2');
    expect(manager.getTopTracks({ userIds: ['U1'], limit: 10 }).map((r) => r.url)).toEqual(['a']);
    expect(manager.getTopTracks({ userIds: [], limit: 10 })).toEqual([]);
  });

  it('getTopTracks() honours the limit', () => {
    for (const url of ['a', 'b', 'c']) play(url, 'U1');
    expect(manager.getTopTracks({ limit: 2 })).toHaveLength(2);
  });

  it('addToHistory() records a DJ pick as the DJ, with no member id', () => {
    manager.addToHistory(
      {
        title: 'Pick',
        url: 'https://y/p',
        duration: 100,
        addedByDj: true,
        requestedBy: 'SquareMusica DJ',
        requestedById: null
      },
      'g1',
      { addedByDj: true }
    );
    expect(
      manager.db.prepare('SELECT requested_by, requested_by_id, added_by_dj FROM history').get()
    ).toEqual({ requested_by: 'SquareMusica DJ', requested_by_id: null, added_by_dj: 1 });
  });

  it('addToHistory() records a member track with added_by_dj = 0', () => {
    manager.addToHistory({ title: 'M', url: 'https://y/m', requestedBy: 'K', requestedById: 'U1' });
    expect(manager.db.prepare('SELECT added_by_dj FROM history').get().added_by_dj).toBe(0);
  });

  it('getDjSkipAward() ignores skips of DJ picks (target_user_id IS NULL)', () => {
    const skip = manager.db.prepare(
      `INSERT INTO events (event_type, actor_id, actor_name, target_user_id, target_user_name)
       VALUES ('skip', ?, ?, ?, ?)`
    );
    skip.run('U1', 'Kasper', null, null);
    skip.run('U1', 'Kasper', null, null);
    expect(manager.getDjSkipAward()).toBeUndefined();
    skip.run('U1', 'Kasper', 'U2', 'Anna');
    expect(manager.getDjSkipAward()).toMatchObject({ userId: 'U2', value: 1 });
  });
});
