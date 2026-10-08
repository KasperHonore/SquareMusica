/**
 * The AI DJ service: one API that all three transports call (research R12).
 *
 * Only constructed when the DJ env group is configured (src/index.js calls
 * init()). Before init(), getState() reports { available: false } and every
 * mutation throws DJ_UNAVAILABLE. MUST NOT import src/transports/.
 */
import { musicManager } from '../../core/musicManager.js';
import { db } from '../../persistence/db.js';
import { getDjConfig } from '../../config/env.js';
import { logger } from '../../utils/logger.js';
import { DjError, DJ_UNAVAILABLE, INVALID_INTERVAL, INVALID_LOOKAHEAD } from './errors.js';

const BREAKER_THRESHOLD = 3;
const BREAKER_OPEN_MS = 5 * 60 * 1000;
const BREAKER_QUOTA_OPEN_MS = 30 * 60 * 1000;

let initialized = false;
let settings = null;
let limits = null;

// Circuit breaker (R9). openUntil stays set after it elapses: the breaker is
// then half-open and health stays 'degraded' until an attempt succeeds.
const breaker = { failures: 0, openUntil: null, halfOpenInFlight: false };

// Today's usage, cached so getState() needn't hit the database.
let usageDay = null;
let usage = { lines: 0, themed_tracks: 0 };
let midnightTimer = null;

// Local calendar day as YYYY-MM-DD. Same value as SQLite's
// date('now','localtime'): DatabaseManager.checkTimezone() refuses to start if
// the two clocks disagree. Computed in JS so it follows the process clock.
function localDay(now = new Date()) {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function nextLocalMidnight(now = new Date()) {
  return new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
}

// ISO 8601 in local time with the zone offset, e.g. 2026-10-09T00:00:00+02:00.
function toLocalIso(date) {
  const pad = (n) => String(Math.abs(n)).padStart(2, '0');
  const offset = -date.getTimezoneOffset();
  const sign = offset >= 0 ? '+' : '-';
  return (
    `${localDay(date)}T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}` +
    `${sign}${pad(Math.trunc(offset / 60))}:${pad(offset % 60)}`
  );
}

function health() {
  return breaker.openUntil === null ? 'ok' : 'degraded';
}

function capsState() {
  return {
    lines: { used: usage.lines, limit: limits.lines, reached: usage.lines >= limits.lines },
    themedTracks: {
      used: usage.themed_tracks,
      limit: limits.themedTracks,
      reached: usage.themed_tracks >= limits.themedTracks
    },
    resetsAt: toLocalIso(nextLocalMidnight())
  };
}

// The parts of state whose change must reach clients outside a settings write.
function signature() {
  const caps = capsState();
  return `${health()}|${caps.lines.reached}|${caps.themedTracks.reached}`;
}

function broadcast() {
  musicManager.emit('dj:state', getState());
}

function loadUsage() {
  usageDay = localDay();
  usage = db.getDjUsage(usageDay);
}

function scheduleMidnightReset() {
  clearTimeout(midnightTimer);
  const delay = Math.max(0, nextLocalMidnight().getTime() - Date.now());
  midnightTimer = setTimeout(() => {
    loadUsage();
    broadcast();
    scheduleMidnightReset();
  }, delay);
  midnightTimer.unref?.();
}

/**
 * Load settings and usage, register the state getter on the mediator, and
 * start the midnight cap reset. Idempotent.
 */
export function init() {
  if (initialized) return;
  limits = getDjConfig().caps;
  settings = db.getDjSettings();
  loadUsage();
  musicManager.setGetDjState(getState);
  scheduleMidnightReset();
  initialized = true;
  logger.info('[DJ] Service initialised');
}

/** Stop timers. Used on shutdown and by tests. */
export function shutdown() {
  clearTimeout(midnightTimer);
  midnightTimer = null;
}

/**
 * The DjState object of contracts §1.
 * @returns {Object}
 */
export function getState() {
  if (!initialized) return { available: false };
  return {
    available: true,
    enabled: settings.enabled,
    interval: settings.interval,
    lookahead: settings.lookahead,
    health: health(),
    caps: capsState(),
    theme: null
  };
}

/**
 * Non-throwing state read for transports, valid even if init() never ran.
 */
export function getStateOrUnavailable() {
  return getState();
}

/**
 * Change any subset of { enabled, interval, lookahead }. The whole partial is
 * validated before anything is written, so it is all or nothing.
 * @param {{ enabled?: boolean, interval?: number, lookahead?: number }} partial
 * @param {Object|null} _actor - Who made the change (used by later stories)
 * @returns {Object} The new DjState
 * @throws {DjError}
 */
export function setSettings(partial, _actor = null) {
  if (!initialized) {
    throw new DjError(DJ_UNAVAILABLE, "The DJ isn't set up on this server.");
  }

  const { enabled, interval, lookahead } = partial ?? {};
  if (interval !== undefined && !(Number.isInteger(interval) && interval >= 1 && interval <= 10)) {
    throw new DjError(INVALID_INTERVAL, 'Interval must be a whole number from 1 to 10.');
  }
  if (lookahead !== undefined && lookahead !== 5 && lookahead !== 10) {
    throw new DjError(INVALID_LOOKAHEAD, 'Lookahead must be 5 or 10.');
  }
  if (enabled !== undefined && typeof enabled !== 'boolean') {
    throw new TypeError('enabled must be a boolean');
  }

  const changes = {};
  if (enabled !== undefined) changes.enabled = enabled;
  if (interval !== undefined) changes.interval = interval;
  if (lookahead !== undefined) changes.lookahead = lookahead;

  db.updateDjSettings(changes);
  settings = { ...settings, ...changes };
  broadcast();
  return getState();
}

/**
 * Whether an external call (LLM, TTS) may be attempted now. Once the open
 * period has elapsed, exactly one attempt is let through (half-open) until its
 * outcome is recorded.
 * @returns {boolean}
 */
export function canAttempt() {
  if (breaker.openUntil === null) return true;
  if (Date.now() < breaker.openUntil) return false;
  if (breaker.halfOpenInFlight) return false;
  breaker.halfOpenInFlight = true;
  return true;
}

/**
 * Record a failed LLM, TTS or resolve-all call (R9).
 * @param {string} kind - e.g. 'quota', 'rate', 'invalid', 'network', 'llm'
 * @param {unknown} [cause]
 */
export function recordFailure(kind, cause) {
  const before = signature();
  logger.warn(`[DJ] ${kind} failure:`, cause instanceof Error ? cause.message : (cause ?? ''));

  const wasHalfOpen = breaker.halfOpenInFlight;
  breaker.halfOpenInFlight = false;
  breaker.failures++;

  if (kind === 'quota') {
    breaker.openUntil = Date.now() + BREAKER_QUOTA_OPEN_MS;
  } else if (wasHalfOpen || breaker.failures >= BREAKER_THRESHOLD) {
    breaker.openUntil = Date.now() + BREAKER_OPEN_MS;
  }

  if (signature() !== before) broadcast();
}

/** Record a successful external call; closes the breaker. */
export function recordSuccess() {
  const before = signature();
  breaker.failures = 0;
  breaker.openUntil = null;
  breaker.halfOpenInFlight = false;
  if (signature() !== before) broadcast();
}

/**
 * Count one unit of daily usage ('lines' after a successful TTS,
 * 'themed_tracks' per queued pick).
 * @param {'lines' | 'themed_tracks'} field
 */
export function recordUsage(field) {
  if (!initialized) return;
  const before = signature();
  if (usageDay !== localDay()) loadUsage();
  db.incrementDjUsage(usageDay, field);
  usage = { ...usage, [field]: usage[field] + 1 };
  if (signature() !== before) broadcast();
}
