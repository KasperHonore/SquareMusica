import { musicManager } from '../../core/musicManager.js';
import { db } from '../../persistence/db.js';
import { getPlayer, getQueue } from '../playback.js';
import { getDjConfig, isDjConfigured } from '../../config/env.js';
import { logger } from '../../utils/logger.js';
import { DjError, DJ_UNAVAILABLE, INVALID_INTERVAL, INVALID_LOOKAHEAD } from './errors.js';
import { createLinePlanner } from './linePlanner.js';
import { writeLine } from './lineWriter.js';

/**
 * The AI DJ service: one API called by every transport (research R12). Only
 * constructed (init()) when the DJ env group is configured; until then every
 * read reports { available: false } and every mutation throws DJ_UNAVAILABLE.
 *
 * Never imports src/transports/ (Constitution II). State reaches clients via
 * musicManager: getFullState() reads getState() through the injected getter,
 * and every change is emitted as 'dj:state', which socketServer re-broadcasts.
 */

const BREAKER_THRESHOLD = 3;
const BREAKER_OPEN_MS = 5 * 60 * 1000;
const BREAKER_QUOTA_OPEN_MS = 30 * 60 * 1000;

let initialised = false;
let settings = null;

// Circuit breaker (R9). Health is 'degraded' from the moment it opens until a
// success closes it; after openUntil passes one half-open attempt is allowed.
const breaker = {
  consecutiveFailures: 0,
  openUntil: null,
  halfOpenInFlight: false
};

// Daily caps, backed by dj_usage.
let caps = null;
let midnightTimer = null;

// Line planner (R5) and the mediator listeners feeding it.
let planner = null;
let listeners = null;

/** YYYY-MM-DD for the local day of `date`. Process TZ is the same zone SQLite's
 * 'localtime' uses (db.checkTimezone() verifies they agree), so this equals
 * date('now','localtime') while staying usable under fake timers. */
function localDay(date = new Date()) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function nextLocalMidnight(now = new Date()) {
  return new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 0, 0, 0, 0);
}

/** ISO 8601 with the local UTC offset, e.g. 2026-10-09T00:00:00+02:00. */
function toLocalIso(date) {
  const pad = (n) => String(n).padStart(2, '0');
  const offset = -date.getTimezoneOffset();
  const sign = offset >= 0 ? '+' : '-';
  const abs = Math.abs(offset);
  return (
    `${localDay(date)}T${pad(date.getHours())}:${pad(date.getMinutes())}:` +
    `${pad(date.getSeconds())}${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`
  );
}

function computeCaps() {
  const limits = getDjConfig().caps;
  const usage = db.getDjUsage(localDay());
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

function health() {
  return breaker.openUntil !== null ? 'degraded' : 'ok';
}

/**
 * writeLine with the breaker and usage bookkeeping (R9). A line counts toward
 * the cap once TTS succeeds, whether or not it is spoken.
 */
async function produceLine(ctx, recentSpoken) {
  try {
    const line = await writeLine(ctx, recentSpoken);
    recordSuccess();
    recordUsage('lines');
    return line;
  } catch (error) {
    recordFailure(error?.kind ?? 'unknown', error);
    throw error;
  }
}

function startPlanner() {
  planner = createLinePlanner({
    getSettings: () => settings,
    getVoiceContext: () => musicManager.getVoiceContext(),
    getQueue: () => getQueue(),
    getPlayer: () => getPlayer(),
    produceLine,
    canAttempt,
    isBreakerOpen,
    isCapReached: () => isCapReached('lines'),
    // Shout-out opt-outs arrive with US3 (T048); until then nobody is named.
    getOptOuts: () => db.getShoutoutOptOuts?.() ?? new Set()
  });
  listeners = {
    'track:change': (track) => planner.onTrackChange(track),
    'queue:update': () => planner.onQueueUpdate()
  };
  for (const [event, fn] of Object.entries(listeners)) musicManager.on(event, fn);
}

function stopPlanner() {
  if (listeners) {
    for (const [event, fn] of Object.entries(listeners)) musicManager.off(event, fn);
  }
  listeners = null;
  planner?.shutdown();
  planner = null;
}

/** The running planner, or null. For tests. */
export function getPlanner() {
  return planner;
}

function broadcast() {
  musicManager.emit('dj:state', getState());
}

function scheduleMidnightReset() {
  if (midnightTimer) clearTimeout(midnightTimer);
  const delay = Math.max(0, nextLocalMidnight().getTime() - Date.now());
  midnightTimer = setTimeout(() => {
    midnightTimer = null;
    caps = computeCaps();
    broadcast();
    scheduleMidnightReset();
  }, delay);
  midnightTimer.unref?.();
}

/**
 * Construct the service: load persisted settings and caps, register the state
 * getter with the mediator, and arm the midnight cap reset. Called once from
 * src/index.js when isDjConfigured() is true.
 */
export function init() {
  if (initialised) return;
  settings = db.getDjSettings();
  caps = computeCaps();
  initialised = true;
  musicManager.setGetDjState(getState);
  scheduleMidnightReset();
  startPlanner();
  logger.info(
    `[DJ] Ready: enabled=${settings.enabled} interval=${settings.interval} lookahead=${settings.lookahead}`
  );
}

/** Stop timers and forget state. For shutdown and tests. */
export function shutdown() {
  stopPlanner();
  if (midnightTimer) clearTimeout(midnightTimer);
  midnightTimer = null;
  initialised = false;
  settings = null;
  caps = null;
  breaker.consecutiveFailures = 0;
  breaker.openUntil = null;
  breaker.halfOpenInFlight = false;
  if (musicManager.getDjState === getState) musicManager.setGetDjState(null);
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
    health: health(),
    caps: {
      lines: { ...caps.lines },
      themedTracks: { ...caps.themedTracks },
      resetsAt: caps.resetsAt
    },
    theme: null
  };
}

/**
 * For transports when the service may never have been constructed (DJ env
 * unconfigured): never throws.
 */
export function getStateOrUnavailable() {
  try {
    return getState();
  } catch {
    return { available: false };
  }
}

function requireAvailable() {
  if (!initialised || !isDjConfigured()) {
    throw new DjError(DJ_UNAVAILABLE, "The DJ isn't set up on this server.");
  }
}

/**
 * Change any subset of { enabled, interval, lookahead }. The whole partial is
 * validated before anything is written, so it is all or nothing.
 *
 * @param {{ enabled?: boolean, interval?: number, lookahead?: number }} partial
 * @param {{ id: string, name: string }|null} actor
 * @returns {Object} The new DjState
 * @throws {DjError}
 */
export function setSettings(partial, actor) {
  requireAvailable();
  const input = partial ?? {};
  const update = {};

  if (input.interval !== undefined) {
    if (!Number.isInteger(input.interval) || input.interval < 1 || input.interval > 10) {
      throw new DjError(INVALID_INTERVAL, 'Interval must be a whole number from 1 to 10.');
    }
    update.interval = input.interval;
  }
  if (input.lookahead !== undefined) {
    if (input.lookahead !== 5 && input.lookahead !== 10) {
      throw new DjError(INVALID_LOOKAHEAD, 'Lookahead must be 5 or 10.');
    }
    update.lookahead = input.lookahead;
  }
  if (input.enabled !== undefined) {
    // contracts §2 defines no code for this; transports only ever send booleans.
    if (typeof input.enabled !== 'boolean') {
      throw new TypeError('enabled must be a boolean');
    }
    update.enabled = input.enabled;
  }

  // FR-006: a new interval, or turning the DJ on, restarts the count.
  const restartCount =
    (update.interval !== undefined && update.interval !== settings.interval) ||
    (update.enabled === true && settings.enabled === false);

  db.updateDjSettings(update);
  settings = { ...settings, ...update };
  if (restartCount) planner?.resetCounter();
  logger.info(`[DJ] Settings changed by ${actor?.name ?? 'system'}:`, update);
  broadcast();
  return getState();
}

/**
 * Whether an LLM/TTS attempt may run now. While open, no; once openUntil has
 * passed, exactly one half-open attempt is let through until it reports back.
 * @returns {boolean}
 */
export function canAttempt() {
  if (breaker.openUntil === null) return true;
  if (Date.now() < breaker.openUntil) return false;
  if (breaker.halfOpenInFlight) return false;
  breaker.halfOpenInFlight = true;
  return true;
}

/** @returns {boolean} True while the breaker is open (theme start refuses). */
export function isBreakerOpen() {
  return breaker.openUntil !== null && Date.now() < breaker.openUntil;
}

/**
 * Report a failed LLM, TTS or resolve attempt. Three in a row open the breaker
 * for 5 minutes; a quota failure opens it for 30. A failed half-open attempt
 * re-opens it.
 * @param {string} kind - Error kind ('quota', 'rate', 'invalid', 'llm', ...)
 * @param {unknown} [cause]
 */
export function recordFailure(kind, cause) {
  const before = health();
  const wasHalfOpen = breaker.halfOpenInFlight;
  breaker.halfOpenInFlight = false;
  breaker.consecutiveFailures++;

  const reason = cause instanceof Error ? cause.message : (cause ?? '');
  logger.warn(`[DJ] ${kind} failure (${breaker.consecutiveFailures} in a row): ${reason}`);

  if (kind === 'quota') {
    breaker.openUntil = Date.now() + BREAKER_QUOTA_OPEN_MS;
  } else if (wasHalfOpen || breaker.consecutiveFailures >= BREAKER_THRESHOLD) {
    breaker.openUntil = Date.now() + BREAKER_OPEN_MS;
  }

  if (health() !== before) {
    logger.warn(`[DJ] Circuit breaker open until ${new Date(breaker.openUntil).toISOString()}`);
    if (initialised) broadcast();
  }
}

/** Report a successful attempt: closes the breaker. */
export function recordSuccess() {
  const before = health();
  breaker.consecutiveFailures = 0;
  breaker.openUntil = null;
  breaker.halfOpenInFlight = false;
  if (health() !== before) {
    logger.info('[DJ] Circuit breaker closed');
    if (initialised) broadcast();
  }
}

/**
 * Re-read today's usage. Broadcasts once if a `reached` flag flipped.
 * @returns {boolean} Whether a flag flipped
 */
export function refreshCaps() {
  if (!initialised) return false;
  const before = caps;
  caps = computeCaps();
  const flipped =
    before.lines.reached !== caps.lines.reached ||
    before.themedTracks.reached !== caps.themedTracks.reached;
  if (flipped) broadcast();
  return flipped;
}

/**
 * Count one unit of usage for today and refresh the caps.
 * @param {'lines'|'themed_tracks'} field
 */
export function recordUsage(field) {
  db.incrementDjUsage(localDay(), field);
  refreshCaps();
}

/**
 * @param {'lines'|'themedTracks'} kind
 * @returns {boolean}
 */
export function isCapReached(kind) {
  return caps?.[kind]?.reached === true;
}
