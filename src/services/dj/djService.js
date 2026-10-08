import { musicManager } from '../../core/musicManager.js';
import { db } from '../../persistence/db.js';
import { getDjConfig } from '../../config/env.js';
import { logger } from '../../utils/logger.js';
import {
  DjError,
  DJ_UNAVAILABLE,
  INVALID_INTERVAL,
  INVALID_LOOKAHEAD,
  INVALID_THEME,
  NOT_IN_VOICE,
  NO_TRACKS_FOR_THEME,
  SERVICE_UNAVAILABLE,
  CAP_REACHED
} from './errors.js';
import { createLinePlanner } from './linePlanner.js';
import { writeLine } from './lineWriter.js';
import { createThemeEngine, normaliseTheme } from './themeEngine.js';
import { isClean } from './contentFilter.js';
import { describeDjError } from './messages.js';
import { chatJson } from '../../integrations/llm.js';
import { resolveSpotifyTrack } from '../resolver.js';
import { getPlayer, getQueue } from '../playback.js';

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
let planner = null;
let engine = null;
// The lookahead a theme start asked for, used by its first top-up and only
// persisted once the start succeeds (an error leaves state unchanged).
let pendingLookahead = null;
let starting = null; // in-flight ensurePlaying(), so concurrent picks start once

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
      planner?.logDailyStats();
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

function createPlanner() {
  return createLinePlanner({
    getSettings: () => settings,
    getQueue,
    getPlayer,
    getConnectedUsers: () => musicManager.getVoiceContext?.()?.connectedUsers ?? [],
    getOptOuts: () => db.getShoutoutOptOuts?.() ?? new Set(),
    store: db,
    canAttempt,
    isLineCapReached,
    writeLine,
    onLineSuccess: () => {
      // A line counts once TTS succeeded: that is when the cost is incurred (R9).
      recordSuccess();
      recordUsage('lines');
    },
    onLineFailure: (kind, error) => {
      // A rejected line is the model's fault, not an outage, but it still
      // counts toward the breaker (contracts §5a).
      recordFailure(kind, error);
    },
    getTheme: () => engine?.getSession()?.theme ?? null,
    getIntroTheme: () => {
      const session = engine?.getSession();
      return session?.introPending ? session.theme : null;
    },
    clearIntro: () => {
      const session = engine?.getSession();
      if (session) session.introPending = false;
    }
  });
}

/** Start playback if nothing is playing yet (a pick landed on an idle queue). */
function startPlaybackIfIdle() {
  if (starting) return;
  starting = Promise.resolve()
    .then(() => musicManager.ensurePlaying?.())
    .catch((error) => logger.warn('[DJ] Could not start themed playback:', error?.message ?? error))
    .finally(() => {
      starting = null;
    });
}

function createEngine() {
  return createThemeEngine({
    getQueue,
    getLookahead: () => pendingLookahead ?? settings.lookahead,
    getConnectedUsers: () => musicManager.getVoiceContext?.()?.connectedUsers ?? [],
    getOptOuts: () => db.getShoutoutOptOuts?.() ?? new Set(),
    isConnected: () => Boolean(musicManager.getPlayerState?.()?.connected),
    store: db,
    chatJson,
    resolveTrack: resolveSpotifyTrack,
    addToQueue: (track) => musicManager.addToQueue(track),
    canAttempt,
    isCapReached: isThemedCapReached,
    onPickAdded: () => {
      recordUsage('themed_tracks');
      startPlaybackIfIdle();
    },
    onSuccess: recordSuccess,
    onFailure: recordFailure,
    onChange: broadcast
  });
}

const onTrackChange = (track) => {
  planner?.onTrackChange(track);
  engine?.onTrackChange(track);
};
const onQueueUpdate = (payload) => {
  planner?.onQueueUpdate();
  engine?.onQueueUpdate(payload);
};
const onPlayerState = (state) => engine?.onPlayerState(state);
// Every clear or stop, on any surface, ends themed mode before the emptied queue
// goes out, so the engine never refills it (FR-024b).
const onQueueCleared = () => {
  if (engine?.getSession()) stopTheme(null, 'queue-cleared');
};
// Joins and leaves of the bot's channel (client.js, R7). Discards a prepared line
// naming someone who left, and lets the planner retry now that a listener may
// be back (NO_LISTENERS).
const onVoiceContext = (ctx) => {
  planner?.onVoiceContext(ctx);
  planner?.onQueueUpdate();
  engine?.onConditionsChanged();
};

/**
 * Load settings and usage, register the state getter with the mediator, and
 * start listening for transitions.
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
  planner = createPlanner();
  engine = createEngine();
  musicManager.setOnQueueCleared?.(onQueueCleared);
  musicManager.on('track:change', onTrackChange);
  musicManager.on('queue:update', onQueueUpdate);
  musicManager.on('voice:context', onVoiceContext);
  musicManager.on('player:state', onPlayerState);
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
    theme: engine?.getThemeState() ?? null
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

  const restartCount =
    (interval !== undefined && interval !== settings.interval) ||
    (enabled === true && !settings.enabled);

  settings = db.updateDjSettings(change);
  // FR-006: a new interval, or switching the DJ on, starts the count afresh.
  if (restartCount) planner?.resetCounter();
  // A line may be due now that wasn't before (e.g. enabled mid-track).
  planner?.onQueueUpdate();
  broadcast();
  return getState();
}

// --- Themed mode (FR-021–FR-029, research R8) --------------------------------

function themeError(code) {
  const described = describeDjError(code, { resetsAt: caps?.resetsAt });
  return new DjError(code, described?.text ?? code);
}

function validateLookahead(lookahead) {
  if (lookahead !== undefined && lookahead !== null && lookahead !== 5 && lookahead !== 10) {
    throw new DjError(INVALID_LOOKAHEAD, 'Lookahead must be 5 or 10.');
  }
  return lookahead ?? null;
}

function persistLookahead(lookahead) {
  if (lookahead !== null && lookahead !== settings.lookahead) {
    settings = db.updateDjSettings({ lookahead });
  }
}

function markIntroPending() {
  const session = engine.getSession();
  if (!session) return;
  session.introPending = true;
  planner?.onIntroPending();
}

/**
 * Start themed mode, or change the theme when a session exists (US4/AC7).
 * Resolves as soon as the first pick is queued and playback is asked to start
 * (SC-005); the rest of the batch keeps resolving in the background.
 * @param {{ theme: string, lookahead?: number }} params
 * @param {{ id: string|null, name: string|null }|null} actor
 * @param {{ transport: 'discord'|'http'|'socket', channelId?: string }} origin
 * @returns {Promise<Object>} The new DjState
 * @throws {DjError}
 */
export async function startTheme({ theme, lookahead } = {}, actor = null, origin = {}) {
  requireInitialised();
  const trimmed = normaliseTheme(theme);
  if (!trimmed || !isClean(trimmed)) throw themeError(INVALID_THEME);
  const size = validateLookahead(lookahead);
  if (!musicManager.getPlayerState?.()?.connected) throw themeError(NOT_IN_VOICE);
  if (breaker.openUntil !== null && Date.now() < breaker.openUntil) {
    throw themeError(SERVICE_UNAVAILABLE);
  }
  if (isThemedCapReached()) throw themeError(CAP_REACHED);

  const startedBy = actor ? { id: actor.id ?? null, name: actor.name ?? null } : null;

  if (engine.getSession()) {
    persistLookahead(size);
    engine.changeTheme(trimmed, startedBy);
    markIntroPending();
    logger.info(`[DJ] Theme changed by ${startedBy?.name ?? 'unknown'}`);
    broadcast();
    return getState();
  }

  const queue = getQueue();
  if (queue) queue.prioritizeMemberTracks = true;
  pendingLookahead = size;
  const { session, ready } = engine.start({
    theme: trimmed,
    startedBy,
    origin: {
      transport: origin?.transport ?? 'http',
      ...(origin?.channelId ? { channelId: origin.channelId } : {})
    }
  });
  // Pending before the first pick lands, so the intro is prepared for (and
  // spoken over) the first themed track on an empty queue (FR-006 exception).
  markIntroPending();
  let outcome;
  try {
    outcome = await ready;
  } finally {
    pendingLookahead = null;
  }

  // Stopped or replaced (a clear, or a stop) while the first batch resolved.
  if (engine.getSession() !== session) return getState();

  if (!outcome.added) {
    engine.stop();
    if (queue) queue.prioritizeMemberTracks = false;
    const code =
      {
        SERVICE_UNAVAILABLE,
        CAP_REACHED,
        NOT_IN_VOICE
      }[outcome.failure] ?? NO_TRACKS_FOR_THEME;
    logger.info(`[DJ] Theme start failed (${code})`);
    throw themeError(code);
  }

  persistLookahead(size);
  session.announced = true;
  logger.info(
    `[DJ] Theme started by ${startedBy?.name ?? 'unknown'} via ${session.origin.transport}`
  );
  broadcast();
  return getState();
}

/**
 * Stop themed mode. Queued picks stay; no more are added (US4/AC4).
 * @param {Object|null} [_actor]
 * @param {'member'|'queue-cleared'} [reason]
 * @returns {Object} The new DjState
 */
export function stopTheme(_actor = null, reason = 'member') {
  requireInitialised();
  if (!engine.getSession()) return getState();
  engine.stop();
  const queue = getQueue();
  if (queue) queue.prioritizeMemberTracks = false;
  logger.info(`[DJ] Theme stopped (${reason})`);
  broadcast();
  return getState();
}

/**
 * Where the running theme was started (for the Discord stall notice, FR-029).
 * @returns {{ transport: string, channelId?: string }|null}
 */
export function getThemeOrigin() {
  const origin = engine?.getSession()?.origin;
  return origin ? { ...origin } : null;
}

/** Current settings (in memory). */
export function getSettings() {
  return settings ? { ...settings } : null;
}

// --- Personal shout-outs (FR-019) ---------------------------------------------

function requireInitialised() {
  if (!initialised) {
    throw new DjError(DJ_UNAVAILABLE, "The DJ isn't set up on this server.");
  }
}

function requireUserId(userId) {
  if (typeof userId !== 'string' || userId.length === 0) {
    throw new TypeError('userId must be a Discord user id');
  }
}

/**
 * A member's own shout-out preference. On by default.
 * @param {string} userId - Discord user id
 * @returns {{ enabled: boolean }}
 */
export function getShoutouts(userId) {
  requireInitialised();
  requireUserId(userId);
  return { enabled: !db.isShoutoutOptedOut(userId) };
}

/**
 * Turn a member's own shout-outs on or off. Emits `dj:shoutouts` exactly once
 * whichever transport made the change, so every open surface of that member
 * converges (FR-015). No `dj:state` broadcast: the preference is per member.
 * @param {string} userId - Discord user id
 * @param {boolean} enabled
 * @returns {{ enabled: boolean }}
 */
export function setShoutouts(userId, enabled) {
  requireInitialised();
  requireUserId(userId);
  if (typeof enabled !== 'boolean') throw new TypeError('enabled must be a boolean');

  db.setShoutoutOptOut(userId, !enabled);
  if (!enabled) planner?.onOptOut(userId);
  musicManager.emit('dj:shoutouts', { userId, enabled });
  return { enabled };
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

/** Log the day's line counters and stop pending work (process shutdown). */
export function shutdown() {
  if (!initialised) return;
  planner?.logDailyStats();
  planner?.stop();
  engine?.stop();
}

/** Test hook: the theme engine wired by init(). */
export function _getEngineForTests() {
  return engine;
}

/** Test hook: the planner wired by init(). */
export function _getPlannerForTests() {
  return planner;
}

/** Test hook: tear down module state and timers. */
export function _resetForTests() {
  if (midnightTimer) clearTimeout(midnightTimer);
  midnightTimer = null;
  planner?.stop();
  planner = null;
  engine?.stop();
  engine = null;
  pendingLookahead = null;
  starting = null;
  musicManager.setOnQueueCleared?.(null);
  musicManager.off?.('player:state', onPlayerState);
  musicManager.off?.('track:change', onTrackChange);
  musicManager.off?.('queue:update', onQueueUpdate);
  musicManager.off?.('voice:context', onVoiceContext);
  initialised = false;
  settings = null;
  breaker = null;
  caps = null;
}
