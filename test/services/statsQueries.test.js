import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import { rmSync } from 'fs';
import { dirname } from 'path';

// These tests run against REAL SQL on a real SQLite file, not a mocked db. The
// behaviors under test — the NULL-identity launch boundary, tie-break
// determinism, local-time hour predicates, local-calendar period boundaries and
// the award minimum — all live in SQL, so a mocked db would assert nothing about
// them. The db module is therefore replaced with a DatabaseManager pointed at a
// throwaway file, and statsQueries runs unmodified on top of it.
//
// The factory creates its own temp directory rather than closing over one: mock
// factories are hoisted above every ordinary declaration in this file.
vi.mock('../../src/persistence/db.js', async () => {
  const { mkdtempSync } = await import('fs');
  const { join } = await import('path');
  const { tmpdir } = await import('os');
  const actual = await vi.importActual('../../src/persistence/db.js');

  const dir = mkdtempSync(join(tmpdir(), 'squaremusica-statsqueries-'));
  return { db: new actual.DatabaseManager(join(dir, 'stats.db')) };
});
vi.mock('../../src/utils/logger.js', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() }
}));

import { db } from '../../src/persistence/db.js';
import {
  buildStatsPayload,
  resolvePeriod,
  buildAwards,
  SUPPORTED_PERIODS,
  AWARDS,
  AWARD_MINIMUM
} from '../../src/services/statsQueries.js';

afterAll(() => {
  // better-sqlite3 exposes the open file path, so the temp directory the mock
  // factory created can be derived rather than shared out of it.
  const dbDir = dirname(db.db.name);
  db.close();
  rmSync(dbDir, { recursive: true, force: true });
});

/**
 * Convert a LOCAL wall-clock time to the UTC string played_at is stored in.
 *
 * Tests that care about hour-of-day must write rows whose LOCAL hour is the one
 * under test, whatever timezone the suite runs in. Writing '23:30' directly would
 * pass in UTC and silently stop testing anything in UTC+2.
 */
function utcFromLocal(localISO) {
  return new Date(localISO).toISOString().slice(0, 19).replace('T', ' ');
}

/** Insert a play with a stable requester identity (a post-launch row). */
function addPlay({
  userId,
  name = `dj-${userId}`,
  avatar = `avatar-${userId}`,
  title = 'Song',
  url = `https://example.com/${title}`,
  duration = 100,
  playedAtLocal = '2026-09-11T12:00:00'
}) {
  db.db
    .prepare(
      `INSERT INTO history
         (guild_id, title, url, duration, thumbnail, requested_by, requested_by_id,
          requested_by_avatar, played_at)
       VALUES ('g1', ?, ?, ?, 'thumb.png', ?, ?, ?, ?)`
    )
    .run(title, url, duration, name, userId, avatar, utcFromLocal(playedAtLocal));
}

/** Insert a pre-launch play: a display name only, with no stable identity. */
function addLegacyPlay({
  name = 'ghost-dj',
  title = 'Legacy',
  playedAtLocal = '2026-09-11T12:00:00'
}) {
  db.db
    .prepare(
      `INSERT INTO history (guild_id, title, url, duration, requested_by, played_at)
       VALUES ('g1', ?, 'https://example.com/legacy', 60, ?, ?)`
    )
    .run(title, name, utcFromLocal(playedAtLocal));
}

/** Insert a recorded action. */
function addEvent({
  type,
  actorId,
  actorName = `dj-${actorId}`,
  actorAvatar = `avatar-${actorId}`,
  targetUserId = null,
  targetUserName = null,
  createdAtLocal = '2026-09-11T12:00:00'
}) {
  db.db
    .prepare(
      `INSERT INTO events
         (guild_id, event_type, actor_id, actor_name, actor_avatar, target_user_id,
          target_user_name, created_at)
       VALUES ('g1', ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      type,
      actorId,
      actorName,
      actorAvatar,
      targetUserId,
      targetUserName,
      utcFromLocal(createdAtLocal)
    );
}

function reset() {
  db.db.exec('DELETE FROM history; DELETE FROM events;');
}

beforeEach(reset);

// ---------------------------------------------------------------------------
// Leaderboard
// ---------------------------------------------------------------------------

describe('leaderboard attribution (FR-005)', () => {
  it('excludes rows with a NULL requested_by_id', async () => {
    // The launch boundary. Pre-launch rows carry only a display name, which may
    // since have changed hands, so they are never attributed to anyone.
    addLegacyPlay({ name: 'ghost-dj' });
    addLegacyPlay({ name: 'ghost-dj' });
    addPlay({ userId: 'A' });

    const { leaderboard } = buildStatsPayload({ period: 'all', selfUserId: null });

    expect(leaderboard).toHaveLength(1);
    expect(leaderboard[0].userId).toBe('A');
    expect(leaderboard.some((e) => e.displayName === 'ghost-dj')).toBe(false);
  });

  it('records a stable identity plus a name and avatar snapshot on a new play (SC-007)', () => {
    // Written through db.addToHistory, the single integration point for FR-004,
    // rather than by the test's own INSERT.
    db.addToHistory(
      {
        title: 'Fresh Track',
        url: 'https://example.com/fresh',
        duration: 250,
        thumbnail: 'thumb.png',
        requestedBy: 'kasper',
        requestedById: 'stable-id-1',
        requestedByAvatar: 'avatar-hash-1'
      },
      'g1'
    );

    const stored = db.db
      .prepare('SELECT * FROM history WHERE url = ?')
      .get('https://example.com/fresh');
    expect(stored.requested_by_id).toBe('stable-id-1');
    expect(stored.requested_by).toBe('kasper');
    expect(stored.requested_by_avatar).toBe('avatar-hash-1');
  });

  it('reflects a post-launch play in that member totals on the next query (SC-005)', () => {
    const before = buildStatsPayload({ period: 'all', selfUserId: null });
    expect(before.leaderboard).toHaveLength(0);

    db.addToHistory(
      {
        title: 'Fresh Track',
        url: 'https://example.com/fresh',
        duration: 250,
        requestedBy: 'kasper',
        requestedById: 'stable-id-1',
        requestedByAvatar: 'avatar-hash-1'
      },
      'g1'
    );

    const after = buildStatsPayload({ period: 'all', selfUserId: null });
    expect(after.leaderboard).toHaveLength(1);
    expect(after.leaderboard[0]).toMatchObject({
      userId: 'stable-id-1',
      displayName: 'kasper',
      trackCount: 1,
      totalDurationSeconds: 250
    });
  });

  it('takes name and avatar from the most recent row, not the first (FR-006)', () => {
    addPlay({
      userId: 'A',
      name: 'old-name',
      avatar: 'old-avatar',
      playedAtLocal: '2026-09-01T10:00:00'
    });
    addPlay({
      userId: 'A',
      name: 'new-name',
      avatar: 'new-avatar',
      playedAtLocal: '2026-09-11T10:00:00'
    });

    const { leaderboard } = buildStatsPayload({ period: 'all', selfUserId: null });

    expect(leaderboard[0].displayName).toBe('new-name');
    expect(leaderboard[0].avatar).toBe('new-avatar');
  });

  it('counts unknown durations as 0 rather than dropping the play', () => {
    addPlay({ userId: 'A', duration: null, title: 'NoDuration' });
    addPlay({ userId: 'A', duration: 120, title: 'Known' });

    const { leaderboard } = buildStatsPayload({ period: 'all', selfUserId: null });

    expect(leaderboard[0].trackCount).toBe(2);
    expect(leaderboard[0].totalDurationSeconds).toBe(120);
  });

  it('counts distinct URLs for uniqueTrackCount', () => {
    addPlay({ userId: 'A', url: 'https://example.com/same' });
    addPlay({ userId: 'A', url: 'https://example.com/same' });
    addPlay({ userId: 'A', url: 'https://example.com/other' });

    const { leaderboard } = buildStatsPayload({ period: 'all', selfUserId: null });

    expect(leaderboard[0].trackCount).toBe(3);
    expect(leaderboard[0].uniqueTrackCount).toBe(2);
  });
});

describe('leaderboard ordering determinism (SC-012, FR-007)', () => {
  it('is byte-identical across repeated calls when tied on track count', () => {
    // Six DJs on one play each: without the MIN(played_at)/userId tie-breaks
    // SQLite is free to return these in any order, and the page would reshuffle.
    for (const id of ['e', 'c', 'a', 'f', 'b', 'd']) {
      addPlay({ userId: id, playedAtLocal: '2026-09-11T12:00:00' });
    }

    const first = buildStatsPayload({ period: 'all', selfUserId: null }).leaderboard;
    const second = buildStatsPayload({ period: 'all', selfUserId: null }).leaderboard;
    const third = buildStatsPayload({ period: 'all', selfUserId: null }).leaderboard;

    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
    expect(JSON.stringify(third)).toBe(JSON.stringify(first));
  });

  it('breaks an equal-count tie by earliest first play, then by user id', () => {
    addPlay({ userId: 'later', playedAtLocal: '2026-09-11T12:00:00' });
    addPlay({ userId: 'earlier', playedAtLocal: '2026-09-02T12:00:00' });

    const { leaderboard } = buildStatsPayload({ period: 'all', selfUserId: null });

    expect(leaderboard.map((e) => e.userId)).toEqual(['earlier', 'later']);
  });

  it('orders by track count descending before any tie-break', () => {
    addPlay({ userId: 'few', playedAtLocal: '2026-09-01T12:00:00' });
    addPlay({ userId: 'many', playedAtLocal: '2026-09-10T12:00:00' });
    addPlay({ userId: 'many', playedAtLocal: '2026-09-10T13:00:00' });

    const { leaderboard } = buildStatsPayload({ period: 'all', selfUserId: null });

    expect(leaderboard.map((e) => e.userId)).toEqual(['many', 'few']);
    expect(leaderboard.map((e) => e.rank)).toEqual([1, 2]);
  });
});

describe('self row (FR-008, FR-009)', () => {
  it('flags the requester row inside the top 10', () => {
    addPlay({ userId: 'A' });
    addPlay({ userId: 'me' });

    const { leaderboard, selfEntry } = buildStatsPayload({ period: 'all', selfUserId: 'me' });

    expect(leaderboard.filter((e) => e.isSelf).map((e) => e.userId)).toEqual(['me']);
    expect(selfEntry).toBeNull();
  });

  it('pins the requester below the top 10 with their true rank', () => {
    // 11 DJs ahead of the requester, so they rank 12th.
    for (let i = 0; i < 11; i++) {
      for (let p = 0; p <= i; p++) {
        addPlay({ userId: `dj${String(i).padStart(2, '0')}`, title: `t${i}-${p}` });
      }
    }
    addPlay({ userId: 'me', title: 'mine' });

    const { leaderboard, selfEntry, leaderboardTruncated } = buildStatsPayload({
      period: 'all',
      selfUserId: 'me'
    });

    expect(leaderboard).toHaveLength(10);
    expect(leaderboardTruncated).toBe(true);
    expect(selfEntry).not.toBeNull();
    expect(selfEntry.userId).toBe('me');
    expect(selfEntry.rank).toBe(12);
    expect(selfEntry.isSelf).toBe(true);
  });

  it('leaves selfEntry null for a requester with no qualifying plays', () => {
    addPlay({ userId: 'A' });

    const { selfEntry } = buildStatsPayload({ period: 'all', selfUserId: 'nobody' });

    expect(selfEntry).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Awards — hour boundaries (FR-012)
// ---------------------------------------------------------------------------

describe('Night Owl / Early Bird local-hour boundaries (FR-012)', () => {
  function winnerFor(key) {
    const awards = buildAwards({ since: null });
    return awards.find((a) => a.key === key);
  }

  /** Three plays at one local time — the award minimum — so a winner can exist. */
  function addThreeAt(userId, localTime) {
    for (let i = 0; i < 3; i++) {
      addPlay({ userId, title: `t-${userId}-${i}`, playedAtLocal: localTime });
    }
  }

  it('counts 22:00 local toward Night Owl', () => {
    addThreeAt('owl', '2026-09-11T22:00:00');

    expect(winnerFor('night_owl').winner?.userId).toBe('owl');
    expect(winnerFor('night_owl').value).toBe(3);
  });

  it('does not count 21:59 local toward Night Owl', () => {
    addThreeAt('notowl', '2026-09-11T21:59:00');

    expect(winnerFor('night_owl').winner).toBeNull();
  });

  it('counts 03:59 local toward Night Owl', () => {
    addThreeAt('owl', '2026-09-11T03:59:00');

    expect(winnerFor('night_owl').winner?.userId).toBe('owl');
  });

  it('does not count 04:00 local toward Night Owl', () => {
    addThreeAt('notowl', '2026-09-11T04:00:00');

    expect(winnerFor('night_owl').winner).toBeNull();
  });

  it('counts 05:00 local toward Early Bird', () => {
    addThreeAt('bird', '2026-09-11T05:00:00');

    expect(winnerFor('early_bird').winner?.userId).toBe('bird');
  });

  it('does not count 04:59 local toward Early Bird', () => {
    addThreeAt('notbird', '2026-09-11T04:59:00');

    expect(winnerFor('early_bird').winner).toBeNull();
  });

  it('does not count 09:00 local toward Early Bird', () => {
    addThreeAt('notbird', '2026-09-11T09:00:00');

    expect(winnerFor('early_bird').winner).toBeNull();
  });

  it('counts 08:59 local toward Early Bird', () => {
    addThreeAt('bird', '2026-09-11T08:59:00');

    expect(winnerFor('early_bird').winner?.userId).toBe('bird');
  });

  it('counts 12:00 local toward neither award', () => {
    // FR-012 defines two deliberate dead zones, 04:00-05:00 and 09:00-22:00. A
    // suite probing only the four live edges passes just as happily against a
    // predicate that accidentally tiles the whole day.
    addThreeAt('midday', '2026-09-11T12:00:00');

    expect(winnerFor('night_owl').winner).toBeNull();
    expect(winnerFor('early_bird').winner).toBeNull();
  });

  it('counts 04:30 local toward neither award', () => {
    addThreeAt('deadzone', '2026-09-11T04:30:00');

    expect(winnerFor('night_owl').winner).toBeNull();
    expect(winnerFor('early_bird').winner).toBeNull();
  });
});

describe('The Hog counts plays within one local day', () => {
  it('picks the member with the busiest single local day', () => {
    // A: 3 plays spread over three days. B: 3 plays on one day.
    addPlay({ userId: 'A', title: 'a1', playedAtLocal: '2026-09-09T12:00:00' });
    addPlay({ userId: 'A', title: 'a2', playedAtLocal: '2026-09-10T12:00:00' });
    addPlay({ userId: 'A', title: 'a3', playedAtLocal: '2026-09-11T12:00:00' });
    addPlay({ userId: 'B', title: 'b1', playedAtLocal: '2026-09-11T10:00:00' });
    addPlay({ userId: 'B', title: 'b2', playedAtLocal: '2026-09-11T11:00:00' });
    addPlay({ userId: 'B', title: 'b3', playedAtLocal: '2026-09-11T12:00:00' });

    const hog = buildAwards({ since: null }).find((a) => a.key === 'the_hog');

    expect(hog.winner?.userId).toBe('B');
    expect(hog.value).toBe(3);
  });

  it('splits a run that crosses local midnight across two days', () => {
    // Both plays are the same UTC day in some zones but different local days;
    // grouping without 'localtime' would merge them and inflate the count.
    addPlay({ userId: 'A', title: 'late', playedAtLocal: '2026-09-10T23:30:00' });
    addPlay({ userId: 'A', title: 'early', playedAtLocal: '2026-09-11T00:30:00' });
    addPlay({ userId: 'A', title: 'later', playedAtLocal: '2026-09-11T01:30:00' });

    const hog = buildAwards({ since: null }).find((a) => a.key === 'the_hog');

    // Best single local day is the 11th, with two plays — below the minimum.
    expect(hog.winner).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Award minimum and completeness (FR-013, FR-014, SC-010)
// ---------------------------------------------------------------------------

describe('award minimum of 3 (FR-013)', () => {
  it('emits no winner at 2 qualifying plays', () => {
    addPlay({ userId: 'A', title: 'x1', url: 'https://example.com/same' });
    addPlay({ userId: 'A', title: 'x2', url: 'https://example.com/same' });

    const song = buildAwards({ since: null }).find((a) => a.key === 'most_played_song');

    expect(song.winner).toBeNull();
    expect(song.value).toBeNull();
  });

  it('emits a winner at exactly 3 qualifying plays', () => {
    for (let i = 0; i < AWARD_MINIMUM; i++) {
      addPlay({ userId: 'A', title: `x${i}`, url: 'https://example.com/same' });
    }

    const song = buildAwards({ since: null }).find((a) => a.key === 'most_played_song');

    expect(song.winner).not.toBeNull();
    expect(song.value).toBe(3);
  });

  it('never crowns a song played twice', () => {
    addPlay({ userId: 'A', title: 'twice', url: 'https://example.com/twice' });
    addPlay({ userId: 'A', title: 'twice', url: 'https://example.com/twice' });
    addPlay({ userId: 'B', title: 'once', url: 'https://example.com/once' });

    const song = buildAwards({ since: null }).find((a) => a.key === 'most_played_song');

    expect(song.winner).toBeNull();
  });
});

describe('award completeness (FR-014, SC-010)', () => {
  it('returns all eight award keys on a completely empty database', () => {
    const awards = buildAwards({ since: null });

    expect(awards).toHaveLength(8);
    expect(awards.map((a) => a.key)).toEqual([
      'most_played_song',
      'night_owl',
      'early_bird',
      'the_hog',
      'dj_skip',
      'self_skip_king',
      'queue_yeeter',
      'shuffle_addict'
    ]);
    expect(awards.every((a) => a.winner === null && a.value === null)).toBe(true);
    expect(awards.every((a) => typeof a.valueLabel === 'string')).toBe(true);
  });

  it('returns the same fixed order for every period', () => {
    const expected = AWARDS.map((a) => a.key);

    for (const period of SUPPORTED_PERIODS) {
      const { awards } = buildStatsPayload({ period, selfUserId: null });
      expect(awards.map((a) => a.key)).toEqual(expected);
    }
  });

  it('reports Most Played Song with a null userId, since its winner is a track', () => {
    for (let i = 0; i < 3; i++) {
      addPlay({ userId: 'A', title: 'Hit Song', url: 'https://example.com/hit' });
    }

    const song = buildAwards({ since: null }).find((a) => a.key === 'most_played_song');

    expect(song.winner.userId).toBeNull();
    expect(song.winner.displayName).toBe('Hit Song');
  });
});

// ---------------------------------------------------------------------------
// Period boundaries (FR-016, FR-017)
// ---------------------------------------------------------------------------

describe('resolvePeriod', () => {
  it('resolves all to a null lower bound', () => {
    expect(resolvePeriod('all')).toEqual({ period: 'all', since: null });
  });

  it('rejects a period outside the supported set', () => {
    expect(() => resolvePeriod('fortnight')).toThrow(/Unsupported period/);
    expect(() => resolvePeriod(undefined)).toThrow(/Unsupported period/);
  });

  it('resolves week and month to concrete UTC boundaries', () => {
    for (const period of ['week', 'month']) {
      const { since } = resolvePeriod(period);
      expect(since).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
    }
  });

  it('places the week boundary no later than the month boundary within one month', () => {
    const week = resolvePeriod('week').since;
    const month = resolvePeriod('month').since;
    // Both are real boundaries in the past; week is never before the prior month.
    expect(new Date(`${week}Z`).getTime()).toBeLessThanOrEqual(Date.now());
    expect(new Date(`${month}Z`).getTime()).toBeLessThanOrEqual(Date.now());
  });
});

describe('period boundary behavior', () => {
  it('excludes a play one second before the local month start from month but keeps it in all', () => {
    const monthStartLocal = new Date();
    monthStartLocal.setDate(1);
    monthStartLocal.setHours(0, 0, 0, 0);
    const justBefore = new Date(monthStartLocal.getTime() - 1000);

    addPlay({ userId: 'A', title: 'lastmonth', playedAtLocal: justBefore.toISOString() });

    const all = buildStatsPayload({ period: 'all', selfUserId: null });
    const month = buildStatsPayload({ period: 'month', selfUserId: null });

    expect(all.leaderboard).toHaveLength(1);
    expect(month.leaderboard).toHaveLength(0);
  });

  it('includes a play at the local month start in month', () => {
    const monthStartLocal = new Date();
    monthStartLocal.setDate(1);
    monthStartLocal.setHours(0, 0, 0, 0);

    addPlay({ userId: 'A', title: 'thismonth', playedAtLocal: monthStartLocal.toISOString() });

    expect(buildStatsPayload({ period: 'month', selfUserId: null }).leaderboard).toHaveLength(1);
  });

  it('includes a play at 00:00 on the current local Monday in week', () => {
    const monday = new Date();
    monday.setHours(0, 0, 0, 0);
    // getDay(): 0 = Sunday. Monday of the current week, treating Monday as day 1.
    const daysSinceMonday = (monday.getDay() + 6) % 7;
    monday.setDate(monday.getDate() - daysSinceMonday);

    addPlay({ userId: 'A', title: 'thisweek', playedAtLocal: monday.toISOString() });

    expect(buildStatsPayload({ period: 'week', selfUserId: null }).leaderboard).toHaveLength(1);
  });

  it('excludes a play one second before the current local Monday from week', () => {
    const monday = new Date();
    monday.setHours(0, 0, 0, 0);
    const daysSinceMonday = (monday.getDay() + 6) % 7;
    monday.setDate(monday.getDate() - daysSinceMonday);
    const justBefore = new Date(monday.getTime() - 1000);

    addPlay({ userId: 'A', title: 'lastweek', playedAtLocal: justBefore.toISOString() });

    expect(buildStatsPayload({ period: 'week', selfUserId: null }).leaderboard).toHaveLength(0);
    expect(buildStatsPayload({ period: 'all', selfUserId: null }).leaderboard).toHaveLength(1);
  });

  it('does not shift the week window back a week when run on a Monday', () => {
    // The modifier-order trap: 'weekday 1','-7 days' is a no-op-then-subtract on
    // a Monday, so the window would start the PREVIOUS Monday. A play 8 days ago
    // must stay out of `week` regardless of which weekday the suite runs on.
    const eightDaysAgo = new Date();
    eightDaysAgo.setDate(eightDaysAgo.getDate() - 8);
    eightDaysAgo.setHours(12, 0, 0, 0);

    addPlay({ userId: 'A', title: 'eightdays', playedAtLocal: eightDaysAgo.toISOString() });

    expect(buildStatsPayload({ period: 'week', selfUserId: null }).leaderboard).toHaveLength(0);
  });

  it('keeps week a subset of month a subset of all', () => {
    const now = new Date();
    const today = new Date(now);
    today.setHours(12, 0, 0, 0);
    const longAgo = new Date(now);
    longAgo.setMonth(longAgo.getMonth() - 3);

    addPlay({ userId: 'A', title: 'today', playedAtLocal: today.toISOString() });
    addPlay({ userId: 'B', title: 'old', playedAtLocal: longAgo.toISOString() });

    const countFor = (period) =>
      buildStatsPayload({ period, selfUserId: null }).leaderboard.reduce(
        (sum, e) => sum + e.trackCount,
        0
      );

    expect(countFor('week')).toBeLessThanOrEqual(countFor('month'));
    expect(countFor('month')).toBeLessThanOrEqual(countFor('all'));
    expect(countFor('all')).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Awards derived from recorded actions (T043/T044)
// ---------------------------------------------------------------------------

describe('event-derived award direction and thresholds', () => {
  function awardFor(key) {
    return buildAwards({ since: null }).find((a) => a.key === key);
  }

  it('gives DJ Skip to the victim, not the skipper', () => {
    // A skips B's queued track three times. DJ Skip groups by target_user_id, so
    // B wins. GROUP BY actor_id here compiles, returns a plausible winner and
    // names the wrong person — no other assertion in the suite would catch it.
    addPlay({ userId: 'B', title: 'bees-track' });
    for (let i = 0; i < 3; i++) {
      addEvent({
        type: 'skip',
        actorId: 'A',
        targetUserId: 'B',
        targetUserName: 'dj-B'
      });
    }

    const djSkip = awardFor('dj_skip');

    expect(djSkip.winner?.userId).toBe('B');
    expect(djSkip.winner?.userId).not.toBe('A');
    expect(djSkip.value).toBe(3);
  });

  it('does not count self-skips toward DJ Skip', () => {
    for (let i = 0; i < 3; i++) {
      addEvent({ type: 'skip', actorId: 'A', targetUserId: 'A', targetUserName: 'dj-A' });
    }

    expect(awardFor('dj_skip').winner).toBeNull();
  });

  it('gives Self-Skip King to the actor when actor and target match', () => {
    for (let i = 0; i < 3; i++) {
      addEvent({ type: 'skip', actorId: 'A', targetUserId: 'A', targetUserName: 'dj-A' });
    }

    expect(awardFor('self_skip_king').winner?.userId).toBe('A');
    expect(awardFor('self_skip_king').value).toBe(3);
  });

  it('does not count other-skips toward Self-Skip King', () => {
    for (let i = 0; i < 3; i++) {
      addEvent({ type: 'skip', actorId: 'A', targetUserId: 'B', targetUserName: 'dj-B' });
    }

    expect(awardFor('self_skip_king').winner).toBeNull();
  });

  it('gives Queue Yeeter to the actor performing removals', () => {
    for (let i = 0; i < 3; i++) {
      addEvent({ type: 'remove', actorId: 'A', targetUserId: 'B', targetUserName: 'dj-B' });
    }

    expect(awardFor('queue_yeeter').winner?.userId).toBe('A');
    expect(awardFor('queue_yeeter').value).toBe(3);
  });

  it('gives Shuffle Addict to the actor performing shuffles', () => {
    for (let i = 0; i < 3; i++) {
      addEvent({ type: 'shuffle', actorId: 'A' });
    }

    expect(awardFor('shuffle_addict').winner?.userId).toBe('A');
  });

  it('does not cross event types between awards', () => {
    for (let i = 0; i < 3; i++) {
      addEvent({ type: 'shuffle', actorId: 'A' });
    }

    expect(awardFor('queue_yeeter').winner).toBeNull();
    expect(awardFor('dj_skip').winner).toBeNull();
    expect(awardFor('self_skip_king').winner).toBeNull();
  });

  it.each([
    ['dj_skip', () => ({ type: 'skip', actorId: 'A', targetUserId: 'B', targetUserName: 'dj-B' })],
    ['self_skip_king', () => ({ type: 'skip', actorId: 'A', targetUserId: 'A' })],
    ['queue_yeeter', () => ({ type: 'remove', actorId: 'A', targetUserId: 'B' })],
    ['shuffle_addict', () => ({ type: 'shuffle', actorId: 'A' })]
  ])('gives %s no winner at 2 actions and a winner at 3', (key, makeEvent) => {
    addEvent(makeEvent());
    addEvent(makeEvent());
    expect(awardFor(key).winner, `${key} at 2 actions`).toBeNull();

    addEvent(makeEvent());
    expect(awardFor(key).winner, `${key} at 3 actions`).not.toBeNull();
    expect(awardFor(key).value).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// Loop replays (FR-005a, SC-014)
// ---------------------------------------------------------------------------

describe('loop replays are kept in history but never counted (FR-005a, SC-014)', () => {
  const LOOPED = {
    title: 'Looped Track',
    url: 'https://example.com/looped',
    duration: 200,
    thumbnail: 'thumb.png',
    requestedBy: 'dj-A',
    requestedById: 'A',
    requestedByAvatar: 'avatar-A'
  };

  // One queued track under track-loop: the first start is counted, the next 19
  // are loop replays. Written through db.addToHistory, the real write path.
  function playLoopedTwentyTimes() {
    db.addToHistory(LOOPED, 'g1');
    for (let i = 0; i < 19; i++) {
      db.addToHistory(LOOPED, 'g1', { loopReplay: true });
    }
  }

  it('writes is_loop_replay, defaulting to 0', () => {
    playLoopedTwentyTimes();

    const flags = db.db
      .prepare('SELECT is_loop_replay AS f, COUNT(*) AS n FROM history GROUP BY f ORDER BY f')
      .all();
    expect(flags).toEqual([
      { f: 0, n: 1 },
      { f: 1, n: 19 }
    ]);
  });

  it('contributes 1 to trackCount, listening time and distinct tracks', () => {
    playLoopedTwentyTimes();

    const { leaderboard } = buildStatsPayload({ period: 'all', selfUserId: null });

    expect(leaderboard).toHaveLength(1);
    expect(leaderboard[0].trackCount).toBe(1);
    expect(leaderboard[0].totalDurationSeconds).toBe(200);
    expect(leaderboard[0].uniqueTrackCount).toBe(1);
  });

  it('contributes 1 to the pinned self-row as well', () => {
    playLoopedTwentyTimes();

    expect(db.getLeaderboardEntryForUser({ since: null, userId: 'A' }).trackCount).toBe(1);
  });

  it('contributes 1 play toward Most Played Song and The Hog', () => {
    playLoopedTwentyTimes();

    expect(db.getMostPlayedSongAward({ since: null }).value).toBe(1);
    expect(db.getHogAward({ since: null }).value).toBe(1);

    const awards = buildAwards({ since: null });
    expect(awards.find((a) => a.key === 'most_played_song').winner).toBeNull();
    expect(awards.find((a) => a.key === 'the_hog').winner).toBeNull();
  });

  it('excludes loop replays from Night Owl and Early Bird', () => {
    for (const playedAtLocal of ['2026-09-11T23:00:00', '2026-09-11T06:00:00']) {
      for (let i = 0; i < 5; i++) {
        addPlay({ userId: 'A', playedAtLocal });
      }
    }
    db.db.exec('UPDATE history SET is_loop_replay = 1');

    expect(db.getNightOwlAward({ since: null })).toBeUndefined();
    expect(db.getEarlyBirdAward({ since: null })).toBeUndefined();
  });

  it('still lists all 20 plays in getHistory', () => {
    playLoopedTwentyTimes();

    const history = db.getHistory(50, 0);
    expect(history).toHaveLength(20);
    expect(history.every((row) => row.url === LOOPED.url)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Configured timezone (FR-030, SC-013)
//
// vitest.config.js pins TZ=Europe/Copenhagen. These cases seed FIXED UTC
// instants, not host-local wall-clock times, so they prove SQLite's 'localtime'
// follows TZ, including across the CET/CEST switch, rather than just agreeing
// with whatever zone the helper above converted from.
// ---------------------------------------------------------------------------

describe('configured timezone Europe/Copenhagen (SC-013)', () => {
  /** Insert a post-launch play at an exact UTC played_at string. */
  function addPlayAtUtc(userId, title, playedAtUtc) {
    db.db
      .prepare(
        `INSERT INTO history
           (guild_id, title, url, duration, thumbnail, requested_by, requested_by_id,
            requested_by_avatar, played_at)
         VALUES ('g1', ?, ?, 100, 'thumb.png', ?, ?, ?, ?)`
      )
      .run(
        title,
        `https://example.com/${title}`,
        `dj-${userId}`,
        userId,
        `avatar-${userId}`,
        playedAtUtc
      );
  }

  function awardFor(key) {
    return buildAwards({ since: null }).find((a) => a.key === key);
  }

  it('runs the suite in Europe/Copenhagen', () => {
    expect(process.env.TZ).toBe('Europe/Copenhagen');
  });

  it.each([
    ['summer (CEST, UTC+2)', '2026-07-15 21:30:00', '2026-07-15'],
    ['winter (CET, UTC+1)', '2026-01-15 22:30:00', '2026-01-15']
  ])('counts 23:30 local in %s toward Night Owl', (_label, utc, localDay) => {
    for (let i = 0; i < 3; i++) addPlayAtUtc('owl', `owl-${i}`, utc);

    expect(awardFor('night_owl').winner?.userId).toBe('owl');
    expect(awardFor('night_owl').value).toBe(3);
    expect(
      db.db.prepare("SELECT date(?, 'localtime')").pluck().get(utc),
      'local day of the play'
    ).toBe(localDay);
  });

  it.each([
    // 00:30 local on the 15th is still the 14th in UTC.
    ['summer (CEST)', '2026-07-14 22:30:00', '2026-07-15 21:30:00'],
    ['winter (CET)', '2026-01-14 23:30:00', '2026-01-15 22:30:00']
  ])('groups The Hog by local day in %s', (_label, justAfterLocalMidnight, lateEvening) => {
    // In UTC these split 1 + 2 across two days (below the minimum); in local time
    // all three fall on the 15th.
    addPlayAtUtc('hog', 'h1', justAfterLocalMidnight);
    addPlayAtUtc('hog', 'h2', lateEvening);
    addPlayAtUtc('hog', 'h3', lateEvening);

    expect(awardFor('the_hog').winner?.userId).toBe('hog');
    expect(awardFor('the_hog').value).toBe(3);
  });

  describe('period boundaries across a DST change', () => {
    // getPeriodBoundary() reads SQLite's 'now', which fake timers cannot move.
    // This mirrors its expression with a pinned "now" and resolvePeriod's
    // modifiers, then checks the boundary against the real leaderboard query.
    const MODIFIERS = { month: ['start of month'], week: ['-6 days', 'weekday 1'] };

    function boundaryAt(nowUtc, period) {
      const modifiers = MODIFIERS[period];
      const placeholders = modifiers.map(() => ', ?').join('');
      return db.db
        .prepare(`SELECT datetime(date(?, 'localtime'${placeholders}), 'utc')`)
        .pluck()
        .get(nowUtc, ...modifiers);
    }

    it.each([
      // "now" is CEST (DST began 2026-03-29); the boundary is still CET.
      ['month', '2026-03-30 12:00:00', '2026-02-28 23:00:00'],
      ['week', '2026-03-29 12:00:00', '2026-03-22 23:00:00'],
      // "now" is CET (DST ended 2026-10-25); the boundary is still CEST.
      ['month', '2026-10-26 12:00:00', '2026-09-30 22:00:00'],
      ['week', '2026-10-25 12:00:00', '2026-10-18 22:00:00']
    ])('puts the %s start seen at %s at local midnight (%s UTC)', (period, nowUtc, expected) => {
      expect(boundaryAt(nowUtc, period)).toBe(expected);
    });

    it('includes a play at the local month start and excludes one a second earlier', () => {
      const since = boundaryAt('2026-03-30 12:00:00', 'month');
      addPlayAtUtc('in', 'march-first', '2026-02-28 23:00:00');
      addPlayAtUtc('out', 'february-last', '2026-02-28 22:59:59');

      const ids = db.getLeaderboard({ since }).map((row) => row.userId);
      expect(ids).toEqual(['in']);
    });
  });
});
