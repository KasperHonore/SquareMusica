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
import { getPlayer, getQueue } from '../playback.js';
import { buildContext } from './context.js';
import { writeLine } from './lineWriter.js';
import { createLinePlanner } from './linePlanner.js';
import { createThemeEngine } from './themeEngine.js';
import { isClean } from './contentFilter.js';
import { chatJson } from '../../integrations/llm.js';
import { resolveSpotifyTrack } from '../resolver.js';
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

const MAX_THEME_CHARS = 200;

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

let planner = null;
let themeEngine = null;
let onTrackChange = null;
let onQueueUpdate = null;
let onPlayerState = null;

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
    planner?.rollDay();
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

  planner = createLinePlanner({
    getSettings: () => settings,
    getQueue,
    getPlayer,
    getVoiceContext: () => musicManager.getVoiceContext(),
    getOptOuts: () => db.getShoutoutOptOuts?.() ?? new Set(),
    isCapReached: () => capsState().lines.reached,
    isBreakerOpen,
    canAttempt,
    buildContext,
    writeLine: writeLineTracked,
    getTheme: () => themeEngine?.getSession()?.theme ?? null,
    isIntroPending: () => themeEngine?.getSession()?.introPending === true,
    clearIntroPending: () => {
      const session = themeEngine?.getSession();
      if (session) session.introPending = false;
    }
  });

  themeEngine = createThemeEngine({
    getQueue,
    addToQueue: (track) => musicManager.addToQueue(track),
    getLookahead: () => settings.lookahead,
    chatJson,
    resolveTrack: resolveSpotifyTrack,
    getTopTracks: (params) => db.getTopTracks?.(params) ?? [],
    getPresentMemberIds,
    isConnected: () => musicManager.getPlayerState().connected === true,
    hasListeners: () => humansPresent().length > 0,
    isCapReached: () => capsState().themedTracks.reached,
    canAttempt,
    recordSuccess,
    recordFailure,
    recordUsage: () => recordUsage('themed_tracks'),
    onStatusChange: () => broadcast()
  });

  // Every clear or stop, on any surface, ends themed mode before the emptied
  // queue is announced, so it is never refilled (FR-024b).
  musicManager.setOnQueueCleared(() => {
    if (themeEngine?.getSession()) stopTheme(null, 'queue-cleared');
  });

  // The theme engine listens first, so a member track it sees in queue:update
  // is in usedKeys before anything else reacts.
  onTrackChange = (track) => {
    themeEngine.onTrackChange(track);
    planner.onTrackChange(track);
  };
  onQueueUpdate = (payload) => {
    themeEngine.onQueueUpdate(payload);
    planner.onQueueUpdate();
  };
  // Bot leaving voice: the session stalls with NOT_IN_VOICE until it rejoins.
  // Presence changes re-check NO_LISTENERS the same way.
  onPlayerState = () => themeEngine.recheck();
  musicManager.on('track:change', onTrackChange);
  musicManager.on('queue:update', onQueueUpdate);
  musicManager.on('player:state', onPlayerState);
  musicManager.on('voice:context', onPlayerState);

  initialized = true;
  logger.info('[DJ] Service initialised');
}

/** Stop timers. Used on shutdown and by tests. */
export function shutdown() {
  clearTimeout(midnightTimer);
  midnightTimer = null;
  if (onTrackChange) musicManager.off('track:change', onTrackChange);
  if (onQueueUpdate) musicManager.off('queue:update', onQueueUpdate);
  if (onPlayerState) {
    musicManager.off('player:state', onPlayerState);
    musicManager.off('voice:context', onPlayerState);
  }
  onTrackChange = null;
  onQueueUpdate = null;
  onPlayerState = null;
  planner?.shutdown();
  planner = null;
  themeEngine?.shutdown();
  themeEngine = null;
}

function humansPresent() {
  return (musicManager.getVoiceContext()?.connectedUsers ?? []).filter((u) => !u.bot);
}

// Present members whose plays may seed themed picks: opted-out members are
// left out (FR-021b), and without US3's opt-out table everyone is opted in.
function getPresentMemberIds() {
  const optOuts = db.getShoutoutOptOuts?.() ?? new Set();
  return humansPresent()
    .map((u) => u.id)
    .filter((id) => id && !optOuts.has(id));
}

function themeState() {
  const session = themeEngine?.getSession();
  if (!session) return null;
  return {
    theme: session.theme,
    startedBy: session.startedBy,
    startedAt: session.startedAt,
    status: session.status,
    reason: session.reason
  };
}

/**
 * Where the running session was started, for transport stall notices
 * (FR-029). Not part of the broadcast DjState.
 * @returns {{ transport: string, channelId?: string } | null}
 */
export function getThemeOrigin() {
  return themeEngine?.getSession()?.origin ?? null;
}

// writeLine with its outcome fed to the breaker, and a successful TTS counted
// against the daily line cap (R9: the cost is incurred whether or not it plays).
async function writeLineTracked(ctx, recentSpoken) {
  try {
    const line = await writeLine(ctx, recentSpoken);
    recordSuccess();
    recordUsage('lines');
    return line;
  } catch (error) {
    recordFailure(error?.kind ?? 'llm', error);
    throw error;
  }
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
    theme: themeState()
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

  const restartCount =
    (changes.interval !== undefined && changes.interval !== settings.interval) ||
    (changes.enabled === true && settings.enabled === false);

  db.updateDjSettings(changes);
  settings = { ...settings, ...changes };
  if (restartCount) planner?.resetCounter();
  else planner?.refresh();
  broadcast();
  return getState();
}

function requireInitialized() {
  if (!initialized) {
    throw new DjError(DJ_UNAVAILABLE, "The DJ isn't set up on this server.");
  }
}

/**
 * Start themed mode, or change the theme when it is already running
 * (contracts §3). A first start resolves once the first pick is in the queue
 * and playback has been asked to start (SC-005); the rest of the batch keeps
 * resolving in the background.
 * @param {{ theme: string, lookahead?: number }} params
 * @param {{ id: string, name: string }|null} actor
 * @param {{ transport: 'discord'|'http'|'socket', channelId?: string }} origin
 * @returns {Promise<Object>} The new DjState
 * @throws {DjError}
 */
export async function startTheme({ theme, lookahead } = {}, actor = null, origin = null) {
  requireInitialized();

  const trimmed = typeof theme === 'string' ? theme.trim() : '';
  if (trimmed.length < 1 || trimmed.length > MAX_THEME_CHARS || !isClean(trimmed)) {
    throw new DjError(INVALID_THEME, 'Theme must be 1–200 characters.');
  }
  if (lookahead !== undefined && lookahead !== null && lookahead !== 5 && lookahead !== 10) {
    throw new DjError(INVALID_LOOKAHEAD, 'Lookahead must be 5 or 10.');
  }
  if (!musicManager.getPlayerState().connected) {
    throw new DjError(NOT_IN_VOICE);
  }

  const existing = themeEngine.getSession();
  if (!existing) {
    if (isBreakerOpen()) throw new DjError(SERVICE_UNAVAILABLE);
    if (capsState().themedTracks.reached) throw new DjError(CAP_REACHED);
  }

  if (lookahead !== undefined && lookahead !== null && lookahead !== settings.lookahead) {
    db.updateDjSettings({ lookahead });
    settings = { ...settings, lookahead };
  }

  if (existing) {
    themeEngine.changeTheme(trimmed);
    planner?.prepareIntro();
    logger.info('[DJ] Theme changed', { theme: trimmed, by: actor?.id ?? null });
    broadcast();
    return getState();
  }

  const queue = getQueue();
  if (queue) queue.prioritizeMemberTracks = true;
  // The intro is written while the first picks resolve, ready for the first track.
  const intro = setTimeout(() => planner?.prepareIntro(), 0);
  intro.unref?.();

  try {
    await themeEngine.start({ theme: trimmed, startedBy: actor, origin });
  } catch (error) {
    clearTimeout(intro);
    if (queue) queue.prioritizeMemberTracks = false;
    if (error?.code === SERVICE_UNAVAILABLE) throw new DjError(SERVICE_UNAVAILABLE);
    throw new DjError(NO_TRACKS_FOR_THEME, "I couldn't find any tracks for that theme.");
  }

  logger.info('[DJ] Themed mode started', { theme: trimmed, by: actor?.id ?? null });
  // Not awaited past the start: playback is the player's business (FR-008).
  musicManager.ensurePlaying().catch((error) => {
    logger.warn('[DJ] Could not start playback for themed mode', { detail: error?.message });
  });
  broadcast();
  return getState();
}

/**
 * Stop themed mode. Queued picks stay; new member songs append normally
 * again (US4/AC4). A no-op returning the state when no session exists.
 * @param {{ id: string, name: string }|null} actor
 * @param {string} [reason] - For the log, e.g. 'queue-cleared'
 * @returns {Object} The new DjState
 */
export function stopTheme(actor = null, reason = 'member') {
  requireInitialized();
  if (!themeEngine.getSession()) return getState();

  themeEngine.stop();
  const queue = getQueue();
  if (queue) queue.prioritizeMemberTracks = false;
  logger.info(`[DJ] Themed mode stopped (${reason})`, { by: actor?.id ?? null });
  broadcast();
  return getState();
}

/**
 * Whether the breaker currently blocks external calls. Unlike canAttempt(),
 * never claims the half-open slot.
 * @returns {boolean}
 */
export function isBreakerOpen() {
  if (breaker.openUntil === null) return false;
  return Date.now() < breaker.openUntil || breaker.halfOpenInFlight;
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
