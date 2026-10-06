import { musicManager } from '../../core/musicManager.js';
import { db } from '../../persistence/db.js';
import { getDjConfig, isDjConfigured } from '../../config/env.js';
import { logger } from '../../utils/logger.js';
import { DjError, DJ_UNAVAILABLE, INVALID_INTERVAL, INVALID_LOOKAHEAD } from './errors.js';

// The AI DJ service: the one API all three transports call (research R12). It
// is only constructed when the DJ env group is configured (src/index.js), and
// never imports src/transports/ (Constitution II).

// Circuit breaker (research R9).
const BREAKER_THRESHOLD = 3;
const BREAKER_OPEN_MS = 5 * 60 * 1000;
const QUOTA_OPEN_MS = 30 * 60 * 1000;

let initialised = false;
let settings = null;
let health = 'ok';
let caps = null;
let midnightTimer = null;

const breaker = {
  consecutiveFailures: 0,
  openUntil: null, // epoch ms; non-null means open (or half-open once passed)
  halfOpenAttempt: false
};

/**
 * Local calendar date as YYYY-MM-DD. The process TZ is the configured zone and
 * DatabaseManager.checkTimezone() guarantees SQLite agrees with it, so this is
 * the same day as SQLite's date('now','localtime').
 * @param {Date} [now]
 * @returns {string}
 */
export function today(now = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

/**
 * The next local midnight, as an ISO string carrying the local UTC offset
 * (e.g. 2026-10-07T00:00:00+02:00). Date#setHours handles DST changes.
 * @param {Date} [now]
 * @returns {string}
 */
function nextLocalMidnight(now = new Date()) {
  const d = new Date(now);
  d.setHours(24, 0, 0, 0);
  const pad = (n) => String(n).padStart(2, '0');
  const offset = -d.getTimezoneOffset();
  const sign = offset >= 0 ? '+' : '-';
  const abs = Math.abs(offset);
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
    `T00:00:00${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`
  );
}

function computeCaps() {
  const limits = getDjConfig().caps;
  const usage = db.getDjUsage(today());
  return {
    lines: { used: usage.lines, limit: limits.lines, reached: usage.lines >= limits.lines },
    themedTracks: {
      used: usage.themed_tracks,
      limit: limits.themedTracks,
      reached: usage.themed_tracks >= limits.themedTracks
    },
    resetsAt: nextLocalMidnight()
  };
}

/**
 * The DjState broadcast to every surface (contracts §1).
 * @returns {Object} `{ available: false }` when the service was never initialised
 */
export function getState() {
  if (!initialised) return { available: false };
  return {
    available: true,
    enabled: settings.enabled,
    interval: settings.interval,
    lookahead: settings.lookahead,
    health,
    caps: {
      lines: { ...caps.lines },
      themedTracks: { ...caps.themedTracks },
      resetsAt: caps.resetsAt
    },
    theme: null
  };
}

/**
 * getState() that never throws, for transports to call whether or not the
 * service was constructed.
 * @returns {Object}
 */
export function getStateOrUnavailable() {
  try {
    return getState();
  } catch (error) {
    logger.warn('[DJ] getState failed:', error.message);
    return { available: false };
  }
}

// Exactly one dj:state per call; socketServer re-broadcasts it.
function broadcast() {
  musicManager.emit('dj:state', getState());
}

function requireAvailable() {
  if (!initialised || !isDjConfigured()) {
    throw new DjError(DJ_UNAVAILABLE, 'The DJ is not configured');
  }
}

function scheduleMidnightReset() {
  if (midnightTimer) clearTimeout(midnightTimer);
  const delay = Math.max(0, new Date(caps.resetsAt).getTime() - Date.now());
  midnightTimer = setTimeout(() => {
    midnightTimer = null;
    caps = computeCaps();
    broadcast();
    scheduleMidnightReset();
  }, delay);
  // Never keep the process alive just for the cap reset.
  midnightTimer.unref?.();
}

/**
 * Load persisted settings and today's usage, and register the state getter with
 * the mediator so `dj` is part of initial:state. Safe to call again; it starts
 * from a clean slate.
 */
export function init() {
  settings = db.getDjSettings();
  health = 'ok';
  breaker.consecutiveFailures = 0;
  breaker.openUntil = null;
  breaker.halfOpenAttempt = false;
  caps = computeCaps();
  initialised = true;
  musicManager.setGetDjState(getState);
  scheduleMidnightReset();
  logger.info(
    `[DJ] Initialised: enabled=${settings.enabled} interval=${settings.interval} lookahead=${settings.lookahead}`
  );
}

/**
 * Stop the service's timers. Used on shutdown and between tests.
 */
export function shutdown() {
  if (midnightTimer) clearTimeout(midnightTimer);
  midnightTimer = null;
  initialised = false;
  musicManager.setGetDjState(null);
}

/**
 * Change any subset of the DJ settings. The whole partial is validated before
 * anything is written, so a bad field leaves every setting unchanged (US2
 * scenario 3). A successful call emits exactly one dj:state (FR-015, SC-004).
 *
 * @param {{ enabled?: boolean, interval?: number, lookahead?: number }} partial
 * @param {{ id: string|null, name: string }|null} [actor]
 * @returns {Object} The new DjState
 * @throws {DjError} DJ_UNAVAILABLE, INVALID_INTERVAL or INVALID_LOOKAHEAD
 */
export function setSettings(partial, actor = null) {
  requireAvailable();
  const input = partial ?? {};

  const update = {};
  if (input.interval !== undefined) {
    if (!Number.isInteger(input.interval) || input.interval < 1 || input.interval > 10) {
      throw new DjError(INVALID_INTERVAL, 'Interval must be a whole number from 1 to 10');
    }
    update.interval = input.interval;
  }
  if (input.lookahead !== undefined) {
    if (input.lookahead !== 5 && input.lookahead !== 10) {
      throw new DjError(INVALID_LOOKAHEAD, 'Lookahead must be 5 or 10');
    }
    update.lookahead = input.lookahead;
  }
  if (input.enabled !== undefined) {
    if (typeof input.enabled !== 'boolean') {
      // contracts/dj-api.md §2 defines no error code for a non-boolean `enabled`.
      throw new TypeError('enabled must be a boolean');
    }
    update.enabled = input.enabled;
  }

  settings = db.updateDjSettings(update);
  logger.info(`[DJ] Settings changed by ${actor?.name ?? 'unknown'}: ${JSON.stringify(update)}`);
  broadcast();
  return getState();
}

/**
 * Whether the breaker lets a DJ attempt (LLM, TTS or themed resolve) through
 * right now. While open it refuses; once the open period has passed it lets
 * exactly one attempt through (half-open) until that attempt is recorded.
 * @returns {boolean}
 */
export function breakerAllows() {
  if (breaker.openUntil === null) return true;
  if (Date.now() < breaker.openUntil) return false;
  if (breaker.halfOpenAttempt) return false;
  breaker.halfOpenAttempt = true;
  return true;
}

function setHealth(next) {
  if (health === next) return;
  health = next;
  broadcast();
}

/**
 * Record a successful DJ attempt: closes the breaker.
 */
export function recordSuccess() {
  breaker.consecutiveFailures = 0;
  breaker.openUntil = null;
  breaker.halfOpenAttempt = false;
  setHealth('ok');
}

/**
 * Record a failed DJ attempt. Three in a row open the breaker for 5 minutes; a
 * failed half-open attempt re-opens it; a quota failure opens it for 30 minutes.
 * @param {string} kind - e.g. 'llm', 'tts', 'resolve', 'quota'
 * @param {unknown} [cause]
 */
export function recordFailure(kind, cause) {
  const reason = cause instanceof Error ? cause.message : (cause ?? 'unknown cause');
  logger.warn(`[DJ] ${kind} failure:`, reason);

  breaker.consecutiveFailures++;
  const wasHalfOpen = breaker.halfOpenAttempt;
  breaker.halfOpenAttempt = false;

  if (kind === 'quota') {
    breaker.openUntil = Date.now() + QUOTA_OPEN_MS;
  } else if (wasHalfOpen || breaker.consecutiveFailures >= BREAKER_THRESHOLD) {
    breaker.openUntil = Date.now() + BREAKER_OPEN_MS;
  }

  if (breaker.openUntil !== null) setHealth('degraded');
}

/**
 * Re-read today's usage, e.g. after db.incrementDjUsage(). Broadcasts once if a
 * `reached` flag flipped.
 */
export function refreshCaps() {
  if (!initialised) return;
  const before = caps;
  caps = computeCaps();
  if (
    before.lines.reached !== caps.lines.reached ||
    before.themedTracks.reached !== caps.themedTracks.reached
  ) {
    broadcast();
  }
}
