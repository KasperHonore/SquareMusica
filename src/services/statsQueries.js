import { db } from '../persistence/db.js';

/**
 * DJ stats period resolution, award registry and response shaping.
 *
 * This module owns no SQL — every query lives in persistence/db.js, which is the
 * only module that reaches the database. What lives here is the part that is
 * policy rather than storage: which periods exist, where their boundaries fall,
 * which awards are defined and in what order, and how the HTTP payload is shaped.
 */

/**
 * The periods the API actually honours. Exported so the route validates against
 * it rather than a literal list of its own: a hardcoded list in the route could
 * accept a period this module cannot yet resolve, which would serve all-time
 * figures under a narrower label — the silent substitution FR-019/FR-020 forbid.
 */
export const SUPPORTED_PERIODS = ['all', 'week', 'month'];

/** How many leaderboard entries are rendered before the list is cut. */
export const LEADERBOARD_LIMIT = 10;

/** Minimum qualifying items before an award has a winner (FR-013). */
export const AWARD_MINIMUM = 3;

/**
 * Resolve a period name to its inclusive lower bound.
 *
 * Boundaries are computed on LOCAL calendar edges and returned on the UTC scale
 * `played_at` is stored on, so "this week" means the viewer's week rather than
 * UTC's. Rejects anything outside SUPPORTED_PERIODS; the route turns that into a
 * 400 rather than falling back to a wider window.
 *
 * @param {string} period
 * @returns {{ period: string, since: string|null }} `since` is null for 'all'.
 */
export function resolvePeriod(period) {
  if (!SUPPORTED_PERIODS.includes(period)) {
    throw new Error(`Unsupported period: ${period}`);
  }

  if (period === 'all') {
    return { period, since: null };
  }

  // SQLite date modifiers applied to the LOCAL date; db.js applies them and
  // converts the result back to the UTC scale played_at is stored on. Passed as
  // data rather than as a SQL fragment so all SQL stays inside db.js.
  //
  // The week modifier order is load-bearing: '-6 days','weekday 1' lands on the
  // Monday of the current local week. The reverse order, 'weekday 1','-7 days',
  // looks equivalent and is not — `weekday 1` is a no-op when today is already
  // Monday, so the '-7 days' still applies and the window starts a week early
  // every Monday.
  const modifiers = period === 'month' ? ['start of month'] : ['-6 days', 'weekday 1'];

  return { period, since: db.getPeriodBoundary(modifiers) };
}

/**
 * Award registry — a fixed, code-defined order so cards never reshuffle between
 * loads, and `key` is the stable identity clients key off.
 *
 * `valueLabel` is the unit the winning number is counted in. It is returned on
 * every award whether or not there is a winner, because the card renders its unit
 * in the "no winner yet" state too.
 *
 * `source` names the db method that resolves the award. `winnerIsTrack` marks the
 * one award whose winner is a track rather than a member — Most Played Song —
 * which the frontend must not render as a member avatar.
 */
export const AWARDS = [
  {
    key: 'most_played_song',
    name: 'Most Played Song',
    description: 'The track this server cannot get enough of',
    valueLabel: 'plays',
    source: 'getMostPlayedSongAward',
    winnerIsTrack: true
  },
  {
    key: 'night_owl',
    name: 'Night Owl',
    description: 'Queued the most tracks between 22:00 and 04:00',
    valueLabel: 'tracks',
    source: 'getNightOwlAward'
  },
  {
    key: 'early_bird',
    name: 'Early Bird',
    description: 'Queued the most tracks between 05:00 and 09:00',
    valueLabel: 'tracks',
    source: 'getEarlyBirdAward'
  },
  {
    key: 'the_hog',
    name: 'The Hog',
    description: 'Queued the most tracks in a single day',
    valueLabel: 'tracks',
    source: 'getHogAward'
  },
  {
    key: 'dj_skip',
    name: 'DJ Skip',
    description: 'Had their tracks skipped by other people the most',
    valueLabel: 'skips',
    source: 'getDjSkipAward'
  },
  {
    key: 'self_skip_king',
    name: 'Self-Skip King',
    description: 'Skipped their own tracks more than anyone else',
    valueLabel: 'skips',
    source: 'getSelfSkipAward'
  },
  {
    key: 'queue_yeeter',
    name: 'Queue Yeeter',
    description: 'Removed the most tracks from the queue',
    valueLabel: 'removals',
    source: 'getQueueYeeterAward'
  },
  {
    key: 'shuffle_addict',
    name: 'Shuffle Addict',
    description: 'Hit shuffle more than anyone else',
    valueLabel: 'shuffles',
    source: 'getShuffleAddictAward'
  }
];

/**
 * Shape one registry entry plus its winning row into the contract's award object.
 *
 * A row below the 3-item minimum yields `winner: null` and `value: null` rather
 * than crowning a leader on one or two plays. Every award is returned regardless
 * of period or data (FR-014, SC-010) — never filtered out for being empty.
 */
function shapeAward(award, row) {
  const qualifies = row && row.value >= AWARD_MINIMUM;

  if (!qualifies) {
    return {
      key: award.key,
      name: award.name,
      description: award.description,
      winner: null,
      value: null,
      valueLabel: award.valueLabel
    };
  }

  return {
    key: award.key,
    name: award.name,
    description: award.description,
    winner: {
      // Most Played Song's winner is a track: displayName carries the title and
      // there is no member behind it, so userId stays null.
      userId: award.winnerIsTrack ? null : row.userId || null,
      displayName: row.displayName || 'Unknown',
      avatar: row.avatar || null
    },
    value: row.value,
    valueLabel: award.valueLabel
  };
}

/**
 * Resolve every award for a period, in registry order.
 *
 * A single award's query failing must not blank the whole page, so each is
 * wrapped: on failure that award reports no winner and the rest still render.
 */
export function buildAwards({ since }) {
  return AWARDS.map((award) => {
    let row = null;
    try {
      row = db[award.source]({ since });
    } catch {
      row = null;
    }
    return shapeAward(award, row);
  });
}

/**
 * Build the full `GET /api/stats` payload for one period.
 *
 * @param {{ period: string, selfUserId: string|null }} params
 */
export function buildStatsPayload({ period, selfUserId = null }) {
  const { period: resolvedPeriod, since } = resolvePeriod(period);

  // getLeaderboard returns LEADERBOARD_LIMIT + 1 rows, so the extra row is what
  // tells us the list is cut. Compute the flag BEFORE slicing, or a full page and
  // a truncated one look identical.
  const rows = db.getLeaderboard({ since, limit: LEADERBOARD_LIMIT });
  const leaderboardTruncated = rows.length > LEADERBOARD_LIMIT;

  const leaderboard = rows.slice(0, LEADERBOARD_LIMIT).map((row, index) => ({
    rank: index + 1,
    userId: row.userId,
    displayName: row.displayName || 'Unknown',
    avatar: row.avatar || null,
    trackCount: row.trackCount,
    totalDurationSeconds: row.totalDurationSeconds || 0,
    uniqueTrackCount: row.uniqueTrackCount,
    isSelf: Boolean(selfUserId) && row.userId === selfUserId
  }));

  // The pinned self-row exists only for a member who qualifies but ranks outside
  // the rendered top 10. Someone already in the list is not repeated below it.
  let selfEntry = null;
  const selfInTopTen = leaderboard.some((entry) => entry.isSelf);
  if (selfUserId && !selfInTopTen) {
    const own = db.getLeaderboardEntryForUser({ since, userId: selfUserId });
    if (own) {
      selfEntry = {
        rank: own.rank,
        userId: own.userId,
        displayName: own.displayName || 'Unknown',
        avatar: own.avatar || null,
        trackCount: own.trackCount,
        totalDurationSeconds: own.totalDurationSeconds || 0,
        uniqueTrackCount: own.uniqueTrackCount,
        isSelf: true
      };
    }
  }

  return {
    period: resolvedPeriod,
    generatedAt: new Date().toISOString(),
    leaderboard,
    leaderboardTruncated,
    selfEntry,
    awards: buildAwards({ since })
  };
}
