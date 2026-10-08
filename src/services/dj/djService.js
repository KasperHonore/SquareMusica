import { musicManager } from '../../core/musicManager.js';
import { db } from '../../persistence/db.js';
import { getDjConfig } from '../../config/env.js';
import { logger } from '../../utils/logger.js';
import { DjError, DJ_UNAVAILABLE, INVALID_INTERVAL, INVALID_LOOKAHEAD } from './errors.js';

// The AI DJ service (research R12). One API for all three transports; it never
// imports src/transports/ (Constitution II). Constructed only when the DJ env
// group is configured (src/index.js calls init()); otherwise every surface sees
// { available: false }.

const FAILURE_THRESHOLD = 3;
const BREAKER_OPEN_MS = 5 * 60 * 1000;
const QUOTA_OPEN_MS = 30 * 60 * 1000;

let initialised = false;
let settings = null;
let breaker = null;
let caps = null;
let midnightTimer = null;

function freshBreaker() {
  return { consecutiveFailures: 0, openUntil: null, halfOpen: false, health: 'ok' };
}

/** Today's date in the configured TZ, as SQLite's date('now','localtime'). */
function localDay(now = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

/** The next local midnight as an ISO string with the local offset. */
function nextLocalMidnight(now = new Date()) {
  const midnight = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 0, 0, 0, 0);
  const pad = (n) => String(Math.abs(n)).padStart(2, '0');
  const offset = -midnight.getTimezoneOffset();
  const sign = offset >= 0 ? '+' : '-';
  const date = localDay(midnight);
  return {
    at: midnight,
    iso: `${date}T00:00:00${sign}${pad(Math.trunc(offset / 60))}:${pad(offset % 60)}`
  };
}

function readCaps() {
  const limits = getDjConfig().caps;
  const usage = db.getDjUsage(localDay());
  const { iso } = nextLocalMidnight();
  return {
    lines: { used: usage.lines, limit: limits.lines, reached: usage.lines >= limits.lines },
    themedTracks: {
      used: usage.themed_tracks,
      limit: limits.themedTracks,
      reached: usage.themed_tracks >= limits.themedTracks
    },
    resetsAt: iso
  };
}

function scheduleMidnightReset() {
  if (midnightTimer) clearTimeout(midnightTimer);
  const { at } = nextLocalMidnight();
  midnightTimer = setTimeout(
    () => {
      midnightTimer = null;
      caps = readCaps();
      broadcast();
      scheduleMidnightReset();
    },
    Math.max(0, at.getTime() - Date.now())
  );
  midnightTimer.unref?.();
}

function broadcast() {
  musicManager.emit('dj:state', getState());
}

/**
 * Load settings and usage, and register the state getter with the mediator.
 */
export function init() {
  settings = db.getDjSettings();
  breaker = freshBreaker();
  try {
    db.pruneDjUsage();
  } catch (error) {
    logger.warn('[DJ] Failed to prune old usage rows:', error.message);
  }
  caps = readCaps();
  initialised = true;
  musicManager.setGetDjState(getState);
  scheduleMidnightReset();
  logger.info('[DJ] Service initialised');
}

/**
 * The DjState broadcast shape (contracts §1).
 * @returns {Object}
 */
export function getState() {
  if (!initialised) return { available: false };
  return {
    available: true,
    enabled: settings.enabled,
    interval: settings.interval,
    lookahead: settings.lookahead,
    health: breaker.health,
    caps: {
      lines: { ...caps.lines },
      themedTracks: { ...caps.themedTracks },
      resetsAt: caps.resetsAt
    },
    theme: null
  };
}

/**
 * Non-throwing state read for transports, safe when the service was never
 * constructed.
 */
export function getStateOrUnavailable() {
  return initialised ? getState() : { available: false };
}

/**
 * Change DJ settings. The whole partial is validated before anything is
 * written, so it is all or nothing.
 * @param {{ enabled?: boolean, interval?: number, lookahead?: number }} partial
 * @param {Object|null} [_actor]
 * @returns {Object} The new DjState
 * @throws {DjError}
 */
export function setSettings(partial = {}, _actor = null) {
  if (!initialised) {
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

  const change = {};
  if (enabled !== undefined) change.enabled = enabled;
  if (interval !== undefined) change.interval = interval;
  if (lookahead !== undefined) change.lookahead = lookahead;

  settings = db.updateDjSettings(change);
  broadcast();
  return getState();
}

/** Current settings (in memory). */
export function getSettings() {
  return settings ? { ...settings } : null;
}

// --- Circuit breaker (R9) ---------------------------------------------------

/**
 * Whether an external call (LLM, TTS, resolve) may be attempted now. After the
 * open period one half-open attempt is let through; its outcome closes or
 * re-opens the breaker.
 * @returns {boolean}
 */
export function canAttempt() {
  if (!initialised) return false;
  if (breaker.openUntil === null) return true;
  if (Date.now() < breaker.openUntil) return false;
  if (breaker.halfOpen) return false;
  breaker.halfOpen = true;
  return true;
}

/** True while the breaker is open (including an unresolved half-open probe). */
export function isBreakerOpen() {
  return Boolean(breaker && breaker.openUntil !== null);
}

function setHealth(health) {
  if (breaker.health === health) return;
  breaker.health = health;
  broadcast();
}

/**
 * Record a failed external call.
 * @param {string} kind - e.g. 'llm', 'tts', 'resolve', 'quota'
 * @param {unknown} [cause]
 */
export function recordFailure(kind, cause) {
  if (!initialised) return;
  const reason = cause instanceof Error ? cause.message : cause;
  logger.warn(`[DJ] ${kind} failure${reason ? `: ${reason}` : ''}`);

  breaker.consecutiveFailures++;
  const wasHalfOpen = breaker.halfOpen;
  breaker.halfOpen = false;

  if (kind === 'quota') {
    breaker.openUntil = Date.now() + QUOTA_OPEN_MS;
  } else if (wasHalfOpen || breaker.consecutiveFailures >= FAILURE_THRESHOLD) {
    breaker.openUntil = Date.now() + BREAKER_OPEN_MS;
  }

  if (breaker.openUntil !== null) setHealth('degraded');
}

/** Record a successful external call; closes the breaker. */
export function recordSuccess() {
  if (!initialised) return;
  breaker.consecutiveFailures = 0;
  breaker.openUntil = null;
  breaker.halfOpen = false;
  setHealth('ok');
}

// --- Daily caps (R9, FR-033/FR-034) -------------------------------------------

/**
 * Count one unit of usage for today ('lines' on successful TTS, 'themed_tracks'
 * per pick added). Broadcasts when a `reached` flag flips.
 * @param {'lines'|'themed_tracks'} field
 */
export function recordUsage(field) {
  if (!initialised) return;
  db.incrementDjUsage(localDay(), field);
  const before = { lines: caps.lines.reached, themedTracks: caps.themedTracks.reached };
  caps = readCaps();
  if (before.lines !== caps.lines.reached || before.themedTracks !== caps.themedTracks.reached) {
    broadcast();
  }
}

/** @returns {boolean} */
export function isLineCapReached() {
  return Boolean(caps?.lines.reached);
}

/** @returns {boolean} */
export function isThemedCapReached() {
  return Boolean(caps?.themedTracks.reached);
}

/** Test hook: tear down module state and timers. */
export function _resetForTests() {
  if (midnightTimer) clearTimeout(midnightTimer);
  midnightTimer = null;
  initialised = false;
  settings = null;
  breaker = null;
  caps = null;
}
