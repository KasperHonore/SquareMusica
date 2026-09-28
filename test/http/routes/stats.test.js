import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import express from 'express';

// The stats router transitively imports statsQueries, which imports the
// SQLite-backed db. Both the db and the auth middleware are mocked so the router
// mounts without native bindings and each request reaches the handler logic.
//
// Unlike the playback-route test's pass-through auth mock, this one can also
// reject: the 401 case is the only thing keeping per-member behavioral data off
// the open internet, so it has to be exercised rather than assumed.
const { authState } = vi.hoisted(() => ({ authState: { mode: 'allow', user: null } }));

vi.mock('../../../src/transports/http/middleware/auth.js', () => ({
  authMiddleware: (req, res, next) => {
    if (authState.mode === 'reject') {
      return res.status(401).json({ error: 'Authentication required' });
    }
    req.user = authState.user ?? { username: 'tester', discord_id: 'self-1' };
    next();
  },
  optionalAuth: (req, _res, next) => {
    req.user = authState.user ?? { username: 'tester', discord_id: 'self-1' };
    next();
  }
}));

vi.mock('../../../src/persistence/db.js', () => ({
  db: {
    getLeaderboard: vi.fn(() => []),
    getLeaderboardEntryForUser: vi.fn(() => null),
    getPeriodBoundary: vi.fn(() => '2026-08-31 22:00:00'),
    getMostPlayedSongAward: vi.fn(() => undefined),
    getNightOwlAward: vi.fn(() => undefined),
    getEarlyBirdAward: vi.fn(() => undefined),
    getHogAward: vi.fn(() => undefined),
    getDjSkipAward: vi.fn(() => undefined),
    getSelfSkipAward: vi.fn(() => undefined),
    getQueueYeeterAward: vi.fn(() => undefined),
    getShuffleAddictAward: vi.fn(() => undefined)
  }
}));
vi.mock('../../../src/utils/logger.js', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() }
}));

import statsRouter from '../../../src/transports/http/routes/stats.js';
import { db } from '../../../src/persistence/db.js';
import { SUPPORTED_PERIODS, AWARDS } from '../../../src/services/statsQueries.js';

let server;
let baseUrl;

function get(query = '') {
  return fetch(`${baseUrl}/api/stats${query}`);
}

/** A leaderboard row as db.getLeaderboard returns it. */
function row(userId, trackCount, overrides = {}) {
  return {
    userId,
    trackCount,
    totalDurationSeconds: trackCount * 100,
    uniqueTrackCount: trackCount,
    firstPlayedAt: '2026-09-01 10:00:00',
    displayName: `dj-${userId}`,
    avatar: `avatar-${userId}`,
    ...overrides
  };
}

beforeEach(async () => {
  vi.clearAllMocks();
  authState.mode = 'allow';
  authState.user = null;
  db.getLeaderboard.mockReturnValue([]);
  db.getLeaderboardEntryForUser.mockReturnValue(null);
  db.getPeriodBoundary.mockReturnValue('2026-08-31 22:00:00');

  const app = express();
  app.use(express.json());
  app.use('/api/stats', statsRouter);

  server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

afterEach(async () => {
  await new Promise((resolve) => server.close(resolve));
});

describe('GET /api/stats authentication', () => {
  it('returns 401 when the session token is missing or invalid', async () => {
    // FR-002: the route is gated by authMiddleware, not optionalAuth. optionalAuth
    // never rejects, so using it would leave this endpoint publicly readable.
    authState.mode = 'reject';

    const res = await get();

    expect(res.status).toBe(401);
    expect(await res.json()).toHaveProperty('error');
  });

  it('does not run any query when authentication fails', async () => {
    authState.mode = 'reject';

    await get();

    expect(db.getLeaderboard).not.toHaveBeenCalled();
  });
});

describe('GET /api/stats period validation', () => {
  it('defaults to all when period is absent', async () => {
    const res = await get();

    expect(res.status).toBe(200);
    expect((await res.json()).period).toBe('all');
  });

  it('echoes the resolved period so the client labels from the response', async () => {
    const res = await get('?period=month');

    expect(res.status).toBe(200);
    expect((await res.json()).period).toBe('month');
  });

  it('rejects an unrecognised period with 400 rather than falling back', async () => {
    const res = await get('?period=fortnight');

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/^Invalid period\. Use /);
    // The message enumerates what is actually supported.
    for (const period of SUPPORTED_PERIODS) {
      expect(body.error).toContain(period);
    }
  });

  it('rejects an empty period rather than treating it as absent', async () => {
    const res = await get('?period=');

    expect(res.status).toBe(400);
  });

  it('validates against SUPPORTED_PERIODS rather than a list of its own', async () => {
    // The guard against the route drifting ahead of the service: a hardcoded list
    // here could accept a period resolvePeriod cannot honour, which would serve
    // all-time figures under a narrower label. Every supported value must be
    // accepted and every unsupported one rejected, driven off the exported set.
    for (const period of SUPPORTED_PERIODS) {
      const res = await get(`?period=${period}`);
      expect(res.status, `${period} should be accepted`).toBe(200);
      expect((await res.json()).period).toBe(period);
    }

    for (const period of ['day', 'year', 'quarter', 'ALL', 'Week']) {
      if (SUPPORTED_PERIODS.includes(period)) continue;
      const res = await get(`?period=${period}`);
      expect(res.status, `${period} should be rejected`).toBe(400);
    }
  });
});

describe('GET /api/stats response shape', () => {
  it('always includes generatedAt as an ISO-8601 timestamp', async () => {
    const res = await get();
    const body = await res.json();

    expect(body.generatedAt).toBeTypeOf('string');
    expect(new Date(body.generatedAt).toISOString()).toBe(body.generatedAt);
  });

  it('returns an empty leaderboard array rather than omitting it', async () => {
    db.getLeaderboard.mockReturnValue([]);

    const body = await (await get()).json();

    expect(body.leaderboard).toEqual([]);
    expect(body.leaderboardTruncated).toBe(false);
    expect(body.selfEntry).toBeNull();
  });

  it('returns at most 10 entries with 1-based ranks', async () => {
    // 12 qualifying DJs; the query returns 11 (limit + 1).
    db.getLeaderboard.mockReturnValue(Array.from({ length: 11 }, (_, i) => row(`u${i}`, 100 - i)));

    const body = await (await get()).json();

    expect(body.leaderboard).toHaveLength(10);
    expect(body.leaderboard.map((e) => e.rank)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  });

  it('sets leaderboardTruncated when an eleventh DJ qualifies', async () => {
    db.getLeaderboard.mockReturnValue(Array.from({ length: 11 }, (_, i) => row(`u${i}`, 100 - i)));

    expect((await (await get()).json()).leaderboardTruncated).toBe(true);
  });

  it('leaves leaderboardTruncated false on a full but untruncated page of 10', async () => {
    // The case a plain LIMIT 10 cannot distinguish from a truncated list.
    db.getLeaderboard.mockReturnValue(Array.from({ length: 10 }, (_, i) => row(`u${i}`, 100 - i)));

    const body = await (await get()).json();

    expect(body.leaderboard).toHaveLength(10);
    expect(body.leaderboardTruncated).toBe(false);
  });

  it('marks exactly one row isSelf when the requester is in the top 10', async () => {
    db.getLeaderboard.mockReturnValue([row('other-1', 50), row('self-1', 40), row('other-2', 30)]);

    const body = await (await get()).json();

    expect(body.leaderboard.filter((e) => e.isSelf)).toHaveLength(1);
    expect(body.leaderboard.find((e) => e.isSelf).userId).toBe('self-1');
  });

  it('omits selfEntry when the requester already appears in the top 10', async () => {
    db.getLeaderboard.mockReturnValue([row('self-1', 40)]);

    expect((await (await get()).json()).selfEntry).toBeNull();
    expect(db.getLeaderboardEntryForUser).not.toHaveBeenCalled();
  });

  it('includes selfEntry with its true rank when the requester is outside the top 10', async () => {
    db.getLeaderboard.mockReturnValue(
      Array.from({ length: 11 }, (_, i) => row(`other-${i}`, 100 - i))
    );
    db.getLeaderboardEntryForUser.mockReturnValue({
      rank: 14,
      userId: 'self-1',
      trackCount: 3,
      totalDurationSeconds: 540,
      uniqueTrackCount: 3,
      displayName: 'tester',
      avatar: null
    });

    const body = await (await get()).json();

    expect(body.selfEntry).toMatchObject({ rank: 14, userId: 'self-1', isSelf: true });
    expect(body.leaderboard.every((e) => !e.isSelf)).toBe(true);
  });

  it('leaves selfEntry null when the requester has no qualifying plays', async () => {
    db.getLeaderboard.mockReturnValue([row('other-1', 5)]);
    db.getLeaderboardEntryForUser.mockReturnValue(null);

    expect((await (await get()).json()).selfEntry).toBeNull();
  });

  it('returns every defined award, in registry order, on an empty database', async () => {
    const body = await (await get()).json();

    expect(body.awards.map((a) => a.key)).toEqual(AWARDS.map((a) => a.key));
  });

  it('returns valueLabel on every award even when there is no winner', async () => {
    const body = await (await get()).json();

    for (const award of body.awards) {
      expect(award.winner).toBeNull();
      expect(award.value).toBeNull();
      // The card renders its unit in the "no winner yet" state too.
      expect(award.valueLabel).toBeTypeOf('string');
      expect(award.valueLabel.length).toBeGreaterThan(0);
    }
  });
});

describe('GET /api/stats failure handling', () => {
  it('returns 500 with the documented body when a query throws', async () => {
    db.getLeaderboard.mockImplementation(() => {
      throw new Error('database is locked');
    });

    const res = await get();

    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'Failed to load stats.' });
  });

  it('still renders the page payload when a single award query throws', async () => {
    // One failing award must not blank the leaderboard and the other seven.
    db.getLeaderboard.mockReturnValue([row('self-1', 9)]);
    db.getNightOwlAward.mockImplementation(() => {
      throw new Error('malformed expression');
    });

    const res = await get();
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.leaderboard).toHaveLength(1);
    expect(body.awards).toHaveLength(AWARDS.length);
    expect(body.awards.find((a) => a.key === 'night_owl').winner).toBeNull();
  });
});
