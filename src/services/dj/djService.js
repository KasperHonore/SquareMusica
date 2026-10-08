/**
 * AI DJ service: the one API every transport calls (research R12,
 * contracts/dj-api.md §3).
 *
 * Owns the persisted settings, the circuit breaker and the daily caps (R9), and
 * broadcasts `dj:state` through the musicManager mediator. Only constructed
 * (init() called) when the DJ env group is configured; otherwise every surface
 * reports `{ available: false }` via getStateOrUnavailable().
 *
 * Never imports src/transports/ (Constitution II).
 */
import { musicManager } from '../../core/musicManager.js';
import { db } from '../../persistence/db.js';
import { getDjConfig } from '../../config/env.js';
import { logger } from '../../utils/logger.js';
import { getPlayer, getQueue } from '../playback.js';
import {
  DjError,
  DJ_UNAVAILABLE,
  INVALID_INTERVAL,
  INVALID_LOOKAHEAD,
  INVALID_THEME,
  NOT_IN_VOICE,
  SERVICE_UNAVAILABLE,
  CAP_REACHED
} from './errors.js';
import { createLinePlanner } from './linePlanner.js';
import { createThemeEngine } from './themeEngine.js';
import { isClean } from './contentFilter.js';

const BREAKER_THRESHOLD = 3;
const BREAKER_OPEN_MS = 5 * 60 * 1000;
const BREAKER_QUOTA_OPEN_MS = 30 * 60 * 1000;

const USAGE_FIELDS = { lines: 'lines', themedTracks: 'themed_tracks' };
const MAX_THEME_CHARS = 200;

let initialized = false;
let settings = null; // { enabled, interval, lookahead }
const breaker = { consecutiveFailures: 0, openUntil: null, trialInFlight: false };
let caps = null; // { lines: {used,limit,reached}, themedTracks: {...}, resetsAt }
let midnightTimer = null;
let planner = null;
let mediatorListeners = null;
let themes = null;
let startingPlayback = false;

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

/** Load settings and usage, register the state getter, start the midnight timer. */
export function init() {
  if (initialized) return;
  settings = db.getDjSettings();
  try {
    db.pruneDjUsage();
  } catch (error) {
    logger.warn('[DJ] Failed to prune old usage rows:', error.message);
  }
  caps = readCaps();
  initialized = true;
  musicManager.setGetDjState(getState);
  scheduleMidnightReset();
  startThemeEngine();
  startPlanner();
  // Every clear or stop, on any surface, ends themed mode before the engine
  // could see the emptied queue and refill it (FR-024b).
  musicManager.setOnQueueCleared(() => {
    if (themes?.session) stopTheme(null, 'queue-cleared');
  });
  logger.info(
    `[DJ] Initialized (enabled=${settings.enabled}, interval=${settings.interval}, ` +
      `lookahead=${settings.lookahead})`
  );
}

/** Stop timers and forget state. Used on shutdown and by tests. */
export function shutdown() {
  stopPlanner();
  if (initialized) musicManager.setOnQueueCleared(null);
  stopThemeEngine();
  if (midnightTimer) {
    clearTimeout(midnightTimer);
    midnightTimer = null;
  }
  if (initialized) musicManager.setGetDjState(null);
  initialized = false;
  settings = null;
  caps = null;
  breaker.consecutiveFailures = 0;
  breaker.openUntil = null;
  breaker.trialInFlight = false;
}

export function isInitialized() {
  return initialized;
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

/**
 * The broadcast DjState (contracts §1).
 * @returns {Object}
 */
export function getState() {
  if (!initialized) return { available: false };
  return {
    available: true,
    enabled: settings.enabled,
    interval: settings.interval,
    lookahead: settings.lookahead,
    health: getHealth(),
    caps: {
      lines: { ...caps.lines },
      themedTracks: { ...caps.themedTracks },
      resetsAt: caps.resetsAt
    },
    theme: themes?.getState() ?? null
  };
}

/** Non-throwing state read for transports, whether or not init() ran. */
export function getStateOrUnavailable() {
  return getState();
}

/** Current persisted settings, or null when not initialised. */
export function getSettings() {
  return settings ? { ...settings } : null;
}

function broadcast() {
  musicManager.emit('dj:state', getState());
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

/**
 * Change any subset of { enabled, interval, lookahead }. The whole partial is
 * validated before anything is written, so it is all or nothing.
 *
 * @param {{ enabled?: boolean, interval?: number, lookahead?: number }} partial
 * @param {Object|null} [_actor] - Who made the change (for later stories)
 * @returns {Object} The new DjState
 * @throws {DjError}
 */
export function setSettings(partial, _actor = null) {
  if (!initialized) {
    throw new DjError(DJ_UNAVAILABLE, "The DJ isn't set up on this server.");
  }
  const input = partial ?? {};
  const changes = {};

  if (input.interval !== undefined) {
    if (!Number.isInteger(input.interval) || input.interval < 1 || input.interval > 10) {
      throw new DjError(INVALID_INTERVAL, 'Interval must be a whole number from 1 to 10.');
    }
    changes.interval = input.interval;
  }
  if (input.lookahead !== undefined) {
    if (input.lookahead !== 5 && input.lookahead !== 10) {
      throw new DjError(INVALID_LOOKAHEAD, 'Lookahead must be 5 or 10.');
    }
    changes.lookahead = input.lookahead;
  }
  if (input.enabled !== undefined) {
    // contracts §2 has no code for this: transports parse `enabled` into a
    // boolean before calling, so a non-boolean here is a programming error.
    if (typeof input.enabled !== 'boolean') {
      throw new TypeError('setSettings: enabled must be a boolean');
    }
    changes.enabled = input.enabled;
  }

  const before = settings;
  db.updateDjSettings(changes);
  settings = { ...settings, ...changes };
  // FR-006: a new interval, or switching the DJ on, restarts the count.
  const intervalChanged = changes.interval !== undefined && changes.interval !== before.interval;
  const switchedOn = changes.enabled === true && !before.enabled;
  if (intervalChanged || switchedOn) planner?.resetCounter();
  broadcast();
  if (settings.enabled) planner?.poke();
  // A larger lookahead is filled straight away (FR-022).
  if (changes.lookahead !== undefined) themes?.poke();
  return getState();
}

// ---------------------------------------------------------------------------
// Themed mode (R8, FR-021–FR-029)
// ---------------------------------------------------------------------------

function startThemeEngine() {
  themes = createThemeEngine({
    getQueue: () => getQueue(),
    addToQueue: (track) => musicManager.addToQueue(track),
    getLookahead: () => settings.lookahead,
    getVoiceContext: () => musicManager.getVoiceContext(),
    isConnected: () => musicManager.getPlayerState().connected,
    history: db,
    isBreakerOpen,
    canAttempt,
    recordSuccess,
    recordFailure,
    isCapReached: () => isCapReached('themedTracks'),
    recordUsage: () => recordUsage('themedTracks'),
    onChange: broadcast,
    onPicksAdded: startPlaybackIfIdle
  });
}

function stopThemeEngine() {
  themes?.stop();
  themes = null;
  const queue = getQueue();
  if (queue) queue.prioritizeMemberTracks = false;
}

/** Start playback when a pick lands in an idle queue (SC-005). Never awaited. */
function startPlaybackIfIdle() {
  const player = getPlayer();
  if (startingPlayback || !player || player.isPlaying?.() || player.isPaused?.()) return;
  startingPlayback = true;
  Promise.resolve()
    .then(() => musicManager.ensurePlaying())
    .catch((error) => logger.warn('[DJ] Could not start themed playback:', error?.message))
    .finally(() => {
      startingPlayback = false;
    });
}

/**
 * Start themed mode, or change the theme when it is already on (US4/AC7).
 * Resolves once the first pick is in the queue and playback has been asked to
 * start; the rest of the first batch keeps resolving in the background.
 *
 * @param {{ theme: string, lookahead?: number }} input
 * @param {{ id: string|null, name: string|null }|null} actor
 * @param {{ transport: 'discord'|'http'|'socket', channelId?: string }} origin
 * @returns {Promise<Object>} The new DjState
 * @throws {DjError} DJ_UNAVAILABLE, INVALID_THEME, INVALID_LOOKAHEAD,
 *   NOT_IN_VOICE, SERVICE_UNAVAILABLE, CAP_REACHED, NO_TRACKS_FOR_THEME
 */
export async function startTheme(input, actor = null, origin = { transport: 'http' }) {
  requireInitialized();
  const { theme: rawTheme, lookahead } = input ?? {};
  const theme = typeof rawTheme === 'string' ? rawTheme.trim() : '';
  if (!theme || theme.length > MAX_THEME_CHARS || !isClean(theme)) {
    throw new DjError(INVALID_THEME, 'Theme must be 1–200 characters.');
  }
  if (lookahead !== undefined && lookahead !== 5 && lookahead !== 10) {
    throw new DjError(INVALID_LOOKAHEAD, 'Lookahead must be 5 or 10.');
  }
  if (!musicManager.getPlayerState().connected) throw new DjError(NOT_IN_VOICE);
  if (isBreakerOpen()) throw new DjError(SERVICE_UNAVAILABLE);
  if (isCapReached('themedTracks')) throw new DjError(CAP_REACHED);

  const writeLookahead = () => {
    if (lookahead !== undefined && lookahead !== settings.lookahead) {
      db.updateDjSettings({ lookahead });
      settings = { ...settings, lookahead };
    }
  };

  if (themes.session) {
    writeLookahead();
    themes.changeTheme(theme);
    logger.info(`[DJ] Theme changed by ${actor?.name ?? 'unknown'}: "${theme}"`);
    if (!settings.enabled) themes.session.introPending = false;
    broadcast();
    planner?.poke();
    return getState();
  }

  // Used by the first top-up, but only written once the start succeeds, so a
  // failed start leaves the previous state unchanged.
  const before = settings;
  if (lookahead !== undefined) settings = { ...settings, lookahead };
  const queue = getQueue();
  if (queue) queue.prioritizeMemberTracks = true;
  try {
    const started = themes.start({
      theme,
      startedBy: { id: actor?.id ?? null, name: actor?.name ?? null },
      origin: origin ?? { transport: 'http' }
    });
    // The session (with introPending) exists now: start writing the intro so
    // it is ready when the first pick starts playing (FR-028).
    if (!settings.enabled) themes.session.introPending = false;
    planner?.poke();
    await started;
  } catch (error) {
    settings = before;
    if (queue && !themes?.session) queue.prioritizeMemberTracks = false;
    logger.info(`[DJ] Themed mode did not start (${error?.code ?? error?.message})`);
    throw error;
  }
  settings = before;
  writeLookahead();
  logger.info(`[DJ] Themed mode started by ${actor?.name ?? 'unknown'}: "${theme}"`);
  startPlaybackIfIdle();
  broadcast();
  planner?.poke();
  return getState();
}

/**
 * Stop themed mode. Queued picks stay; member songs append normally again
 * (US4/AC4). Also the target of the queue-cleared hook (FR-024b).
 * @param {Object|null} [actor]
 * @param {string} [reason] - 'member' or 'queue-cleared'
 * @returns {Object} The new DjState
 */
export function stopTheme(actor = null, reason = 'member') {
  requireInitialized();
  const queue = getQueue();
  if (queue) queue.prioritizeMemberTracks = false;
  if (!themes?.session) return getState();
  themes.stop();
  logger.info(`[DJ] Themed mode stopped (${reason}${actor?.name ? ` by ${actor.name}` : ''})`);
  broadcast();
  return getState();
}

/**
 * Where the running theme was started (`{ transport, channelId? }`), or null.
 * Not part of the broadcast state; the Discord transport uses it to post its
 * stall notices to the right channel (FR-029).
 */
export function getThemeOrigin() {
  return themes?.session ? { ...themes.session.origin } : null;
}

function requireInitialized() {
  if (!initialized) {
    throw new DjError(DJ_UNAVAILABLE, "The DJ isn't set up on this server.");
  }
}

// ---------------------------------------------------------------------------
// Line planner (R5)
// ---------------------------------------------------------------------------

function startPlanner() {
  planner = createLinePlanner({
    getSettings: () => settings,
    getVoiceContext: () => musicManager.getVoiceContext(),
    getQueue: () => getQueue(),
    getPlayer: () => getPlayer(),
    getOptOuts: () => db.getShoutoutOptOuts?.() ?? new Set(),
    getTheme: () =>
      themes?.session
        ? { theme: themes.session.theme, introPending: themes.session.introPending }
        : null,
    clearIntroPending: () => {
      if (themes?.session) themes.session.introPending = false;
    },
    isBreakerOpen,
    canAttempt,
    isCapReached: () => isCapReached('lines'),
    onLineReady: () => {
      recordSuccess();
      recordUsage('lines');
    },
    onLineFailed: (error) => {
      // A rejected model answer is not an outage, but R9 counts every failed
      // attempt, so it still feeds the breaker.
      recordFailure(error?.kind ?? 'unknown', error);
    }
  });
  mediatorListeners = {
    'track:change': (track) => {
      planner.onTrackChange(track);
      themes?.onTrackChange(track);
    },
    'queue:update': (payload) => {
      planner.onQueueUpdate();
      themes?.onQueueUpdate(payload);
    },
    'player:state': () => planner.poke(),
    'voice:context': () => {
      planner.poke();
      // Listeners joining or leaving, or the bot leaving voice (NOT_IN_VOICE).
      themes?.poke();
    }
  };
  for (const [event, fn] of Object.entries(mediatorListeners)) musicManager.on(event, fn);
}

function stopPlanner() {
  if (mediatorListeners) {
    for (const [event, fn] of Object.entries(mediatorListeners)) musicManager.off(event, fn);
    mediatorListeners = null;
  }
  planner?.shutdown();
  planner = null;
}

/** The running line planner, or null. Tests and diagnostics only. */
export function getPlanner() {
  return planner;
}

// ---------------------------------------------------------------------------
// Circuit breaker (R9)
// ---------------------------------------------------------------------------

function getHealth() {
  return breaker.openUntil === null ? 'ok' : 'degraded';
}

/**
 * Whether an external call (LLM, TTS, resolve) may be attempted now. While
 * open, returns false until openUntil passes; then lets exactly one trial
 * through (half-open) until it is recorded as a success or failure.
 * @returns {boolean}
 */
export function canAttempt() {
  if (breaker.openUntil === null) return true;
  if (Date.now() < breaker.openUntil) return false;
  if (breaker.trialInFlight) return false;
  breaker.trialInFlight = true;
  return true;
}

/** Whether the breaker currently blocks attempts (open and not yet expired). */
export function isBreakerOpen() {
  return breaker.openUntil !== null && Date.now() < breaker.openUntil;
}

/**
 * Record a failed external call. Three in a row open the breaker for 5 min; a
 * failed half-open trial re-opens it; `quota` opens it for 30 min at once.
 * @param {string} kind - e.g. 'quota', 'rate', 'timeout', 'llm', 'resolve'
 * @param {unknown} [cause]
 */
export function recordFailure(kind, cause) {
  const before = getHealth();
  const reason = cause instanceof Error ? cause.message : (cause ?? '');
  logger.warn(`[DJ] External call failed (${kind})${reason ? `: ${reason}` : ''}`);

  const now = Date.now();
  if (kind === 'quota') {
    breaker.openUntil = now + BREAKER_QUOTA_OPEN_MS;
  } else if (breaker.trialInFlight) {
    breaker.openUntil = now + BREAKER_OPEN_MS;
  } else {
    breaker.consecutiveFailures++;
    if (breaker.consecutiveFailures >= BREAKER_THRESHOLD) {
      breaker.openUntil = now + BREAKER_OPEN_MS;
    }
  }
  breaker.trialInFlight = false;

  if (getHealth() !== before) broadcast();
}

/** Record a successful external call: closes the breaker and resets the count. */
export function recordSuccess() {
  const before = getHealth();
  breaker.consecutiveFailures = 0;
  breaker.openUntil = null;
  breaker.trialInFlight = false;
  if (getHealth() !== before) {
    broadcast();
    if (themes?.session?.status === 'stalled') themes.poke();
  }
}

// ---------------------------------------------------------------------------
// Daily caps (R9, FR-034)
// ---------------------------------------------------------------------------

/**
 * The next local midnight (in TZ) as an ISO string with offset, e.g.
 * 2026-10-09T00:00:00+02:00.
 * @param {Date} [now]
 * @returns {string}
 */
export function nextLocalMidnight(now = new Date()) {
  const midnight = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 0, 0, 0, 0);
  const pad = (n) => String(Math.abs(n)).padStart(2, '0');
  const offset = -midnight.getTimezoneOffset();
  const sign = offset >= 0 ? '+' : '-';
  return (
    `${midnight.getFullYear()}-${pad(midnight.getMonth() + 1)}-${pad(midnight.getDate())}` +
    `T00:00:00${sign}${pad(Math.trunc(offset / 60))}:${pad(offset % 60)}`
  );
}

function readCaps() {
  const limits = getDjConfig().caps;
  const usage = db.getDjUsage(db.getLocalDay());
  return {
    lines: {
      used: usage.lines,
      limit: limits.lines,
      reached: usage.lines >= limits.lines
    },
    themedTracks: {
      used: usage.themed_tracks,
      limit: limits.themedTracks,
      reached: usage.themed_tracks >= limits.themedTracks
    },
    resetsAt: nextLocalMidnight()
  };
}

function reachedFlags() {
  return `${caps.lines.reached}/${caps.themedTracks.reached}`;
}

/**
 * Whether today's cap for a counter is reached.
 * @param {'lines'|'themedTracks'} which
 * @returns {boolean}
 */
export function isCapReached(which) {
  if (!initialized) return true;
  return caps[which].reached;
}

/**
 * Count one unit of usage for today. A line counts when TTS succeeds (R9); a
 * themed track when it is added to the queue. Broadcasts if a cap flips.
 * @param {'lines'|'themedTracks'} which
 */
export function recordUsage(which) {
  if (!initialized) return;
  const before = reachedFlags();
  db.incrementDjUsage(db.getLocalDay(), USAGE_FIELDS[which]);
  caps = readCaps();
  if (reachedFlags() !== before) broadcast();
}

function scheduleMidnightReset() {
  if (midnightTimer) clearTimeout(midnightTimer);
  const delay = Math.max(1000, new Date(caps.resetsAt).getTime() - Date.now());
  midnightTimer = setTimeout(() => {
    midnightTimer = null;
    if (!initialized) return;
    caps = readCaps();
    planner?.logDailyStats();
    broadcast();
    if (themes?.session?.status === 'stalled') themes.poke();
    scheduleMidnightReset();
  }, delay);
  midnightTimer.unref?.();
}
