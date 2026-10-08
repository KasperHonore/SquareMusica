import { logger } from '../../utils/logger.js';
import { trackKey, matchesKey, buildContext } from './context.js';
import { REPEAT_WINDOW } from './lineWriter.js';

/**
 * Decides when the DJ speaks and has the line ready in time (research R5).
 *
 * A line for transition k→k+1 is prepared during track k, `PREPARE_LEAD_MS`
 * before it ends, and overlaid when k+1 starts. Track starts are never
 * delayed: onTrackChange() is synchronous and everything slow runs in
 * promises the playback path never awaits (FR-008, SC-008).
 *
 * Every dependency is a getter injected by djService, so this module touches
 * neither transports/ nor the database directly.
 */

export const PREPARE_LEAD_MS = 30 * 1000;
export const SPEAK_WINDOW_MS = 2000;
// While the new track is still buffering, player.overlay() returns false; we
// retry until it plays or the speak window closes.
const OVERLAY_RETRY_MS = 50;
// A preparation that came due while paused is retried at this pace.
const PAUSED_RETRY_MS = 5000;

function localDay(date = new Date()) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function durationMs(track) {
  if (Number.isFinite(track?.duration) && track.duration > 0) return track.duration * 1000;
  if (Number.isFinite(track?.spotifyData?.durationMs) && track.spotifyData.durationMs > 0) {
    return track.spotifyData.durationMs;
  }
  return null;
}

/**
 * @param {Object} deps
 * @param {() => { enabled: boolean, interval: number }} deps.getSettings
 * @param {() => Object|null} deps.getVoiceContext - musicManager.getVoiceContext
 * @param {() => Object|null} deps.getQueue - Queue with peekNext()
 * @param {() => Object|null} deps.getPlayer - MusicPlayer with overlay()/isPaused()
 * @param {(ctx: Object, recent: string[]) => Promise<Object>} deps.produceLine -
 *   writeLine wrapped with breaker and usage bookkeeping
 * @param {() => boolean} deps.canAttempt - Breaker gate (may claim the half-open slot)
 * @param {() => boolean} deps.isBreakerOpen - Breaker open, without claiming anything
 * @param {() => boolean} deps.isCapReached - Daily line cap
 * @param {() => Set<string>} [deps.getOptOuts] - Shout-out opt-outs
 * @param {() => string|null} [deps.getTheme]
 */
export function createLinePlanner(deps) {
  const getOptOuts = deps.getOptOuts ?? (() => new Set());
  const getTheme = deps.getTheme ?? (() => null);

  let previousTrack = null;
  let transitionsSinceSpoken = 0;
  let prepared = null; // DJ Line ready to speak
  let inflight = null; // { key, promise, discarded }
  let prepareTimer = null;
  let prepareTriggered = false; // the timer for the current track has fired
  let attemptedKey = null; // last key a preparation was started for, this track
  let speakTimers = new Set();
  let speakAttempt = 0; // bumped on every track change; cancels stale speaks
  const spoken = []; // ring buffer of the last REPEAT_WINDOW texts, oldest first
  let stopped = false;

  // SC-002 bookkeeping: due = a transition selected by the interval while no
  // silence condition held; spoken = lines actually overlaid.
  let stats = { day: localDay(), due: 0, spoken: 0 };

  function logStats(day) {
    const ratio = stats.due > 0 ? (stats.spoken / stats.due).toFixed(3) : 'n/a';
    logger.info(
      `[DJ] Daily lines for ${day}: due=${stats.due} spoken=${stats.spoken} ratio=${ratio}`
    );
  }

  function rollDay() {
    const today = localDay();
    if (today === stats.day) return;
    logStats(stats.day);
    stats = { day: today, due: 0, spoken: 0 };
  }

  function drop(reason, key) {
    logger.info(`[DJ] Line dropped (${reason})${key ? ` for ${key}` : ''}`);
  }

  function hasListeners() {
    const users = deps.getVoiceContext()?.connectedUsers ?? [];
    return users.length > 0;
  }

  function isPaused() {
    return deps.getPlayer()?.isPaused?.() === true;
  }

  /** R5 step 5. Returns the reason the DJ must stay silent, or null. */
  function silenceReason({ needNext, costly = true }) {
    if (!deps.getSettings()?.enabled) return 'disabled';
    if (isPaused()) return 'paused';
    if (costly && deps.isCapReached()) return 'cap';
    if (costly && deps.isBreakerOpen()) return 'service';
    if (!hasListeners()) return 'no-listeners';
    if (needNext && !deps.getQueue()?.peekNext?.()) return 'no-next';
    return null;
  }

  function willBeDue() {
    const interval = deps.getSettings()?.interval ?? 1;
    return transitionsSinceSpoken + 1 >= interval;
  }

  function clearPrepareTimer() {
    if (prepareTimer) clearTimeout(prepareTimer);
    prepareTimer = null;
  }

  function discardPreparation() {
    prepared = null;
    if (inflight) inflight.discarded = true;
  }

  function clearSpeakTimers() {
    for (const timer of speakTimers) clearTimeout(timer);
    speakTimers = new Set();
  }

  function later(fn, ms) {
    const timer = setTimeout(() => {
      speakTimers.delete(timer);
      fn();
    }, ms);
    timer.unref?.();
    speakTimers.add(timer);
    return timer;
  }

  /** Start a preparation for the predicted next track if every gate allows. */
  function prepare() {
    if (stopped || inflight || !previousTrack) return;
    if (!willBeDue()) return;

    const reason = silenceReason({ needNext: true });
    if (reason === 'paused') {
      clearPrepareTimer();
      prepareTimer = setTimeout(() => {
        prepareTimer = null;
        prepare();
      }, PAUSED_RETRY_MS);
      prepareTimer.unref?.();
      return;
    }
    if (reason) return;

    const next = deps.getQueue().peekNext();
    const key = trackKey(next);
    if (matchesKey(prepared?.forKey, next)) return;
    if (matchesKey(attemptedKey, next)) return; // already tried (and failed) for this target
    if (!deps.canAttempt()) return;

    attemptedKey = key;
    prepared = null;
    const started = Date.now();
    const ctx = buildContext({
      previous: previousTrack,
      next,
      theme: getTheme(),
      present: deps.getVoiceContext()?.connectedUsers ?? [],
      recentLines: spoken
    });

    // `result` resolves to the line, or null when it could not be produced. A
    // discarded entry is never stored; a waiter that claimed it speaks it.
    const entry = { key, discarded: false, claimed: false, result: null };
    // Skip TTS for a line that was discarded and that no waiter claimed.
    const isCancelled = () => entry.discarded && !entry.claimed;
    entry.result = Promise.resolve()
      .then(() => deps.produceLine(ctx, [...spoken], { isCancelled }))
      .then(
        (line) => line,
        (error) => {
          if (error?.kind === 'cancelled') return null; // already dropped as stale
          drop(error?.kind === 'validation' ? 'validation' : 'service', key);
          logger.debug(`[DJ] Preparation failed: ${error?.message}`);
          return null;
        }
      );
    entry.result.then((line) => {
      if (inflight === entry) inflight = null;
      if (stopped) return;
      if (line) {
        logger.info(
          `[DJ] Line prepared for ${key} (${line.text.length} chars, ${Date.now() - started} ms)`
        );
      }
      if (entry.discarded) {
        if (line && !entry.claimed) drop('stale', key);
        prepareAgainIfNeeded();
        return;
      }
      if (line) prepared = line;
    });
    inflight = entry;
  }

  /** After a discarded preparation settles, prepare for the new target. */
  function prepareAgainIfNeeded() {
    if (!prepareTriggered || stopped) return;
    const predicted = deps.getQueue()?.peekNext?.() ?? null;
    if (predicted && !matchesKey(attemptedKey, predicted)) prepare();
  }

  function schedulePreparation(track) {
    clearPrepareTimer();
    prepareTriggered = false;
    const duration = durationMs(track);
    const delay = duration === null ? 0 : Math.max(0, duration - PREPARE_LEAD_MS);
    prepareTimer = setTimeout(() => {
      prepareTimer = null;
      prepareTriggered = true;
      prepare();
    }, delay);
    prepareTimer.unref?.();
  }

  /** Overlay `line` over the track that just started, retrying while it buffers. */
  function speak(line, deadline, attempt) {
    if (attempt !== speakAttempt || stopped) return;

    // Conditions that can change between preparation and now. The cap and
    // breaker are not re-checked: this line's cost is already paid and counted.
    const reason = silenceReason({ needNext: false, costly: false });
    if (reason === 'disabled' || reason === 'paused') return drop(reason, line.forKey);
    if (reason === 'no-listeners') return drop('no-listeners', line.forKey);

    // FR-017/FR-020: the voice-context event may have been missed, so re-read.
    if (line.namedUserIds.length > 0) {
      const present = new Set(
        (deps.getVoiceContext()?.connectedUsers ?? []).map((user) => user.id)
      );
      const optOuts = getOptOuts();
      if (line.namedUserIds.some((id) => !present.has(id) || optOuts.has(id))) {
        return drop('stale-member', line.forKey);
      }
    }

    if (spoken.length > 0 && spoken[spoken.length - 1] === line.text) {
      return drop('validation', line.forKey);
    }

    if (!deps.getPlayer()?.overlay(line.pcm)) {
      if (Date.now() + OVERLAY_RETRY_MS <= deadline) {
        later(() => speak(line, deadline, attempt), OVERLAY_RETRY_MS);
        return;
      }
      return drop('late', line.forKey);
    }

    transitionsSinceSpoken = 0;
    spoken.push(line.text);
    if (spoken.length > REPEAT_WINDOW) spoken.shift();
    stats.spoken++;
    logger.info(`[DJ] Line spoken for ${line.forKey} (${line.text.length} chars)`);
  }

  /**
   * Mediator 'track:change'. Must stay synchronous (FR-008).
   * @param {Object|null} track
   */
  function onTrackChange(track) {
    if (stopped) return;
    rollDay();
    speakAttempt++;
    clearSpeakTimers();
    clearPrepareTimer();
    attemptedKey = null;

    if (!track) {
      // Stop or empty queue: the next start is not a transition (FR-006).
      previousTrack = null;
      prepareTriggered = false;
      discardPreparation();
      return;
    }

    const isTransition = previousTrack !== null;
    previousTrack = track;
    const key = trackKey(track);

    // Take the line meant for this start (if any) and clear the slot for the next one.
    const ready = prepared;
    prepared = null;
    // An in-flight preparation stays the one in flight until it settles, but
    // is never stored: only a waiter below may speak it.
    const pending = inflight;
    if (pending) pending.discarded = true;

    if (isTransition) {
      transitionsSinceSpoken++;
      const interval = deps.getSettings()?.interval ?? 1;
      if (transitionsSinceSpoken >= interval) {
        // The cap and breaker only stop new preparations: a line already
        // paid for is still spoken, even if its own TTS reached the cap.
        const hasLine = Boolean(ready || pending);
        const reason = silenceReason({ needNext: false, costly: !hasLine });
        if (reason) {
          if (hasLine) drop(reason, key);
        } else {
          stats.due++;
          const deadline = Date.now() + SPEAK_WINDOW_MS;
          const attempt = speakAttempt;
          if (ready && matchesKey(ready.forKey, track)) {
            speak(ready, deadline, attempt);
          } else if (ready) {
            drop('stale', ready.forKey);
          } else if (pending && matchesKey(pending.key, track)) {
            waitFor(pending, deadline, attempt, key);
          } else {
            drop('late', key);
          }
        }
      }
    }

    schedulePreparation(track);
  }

  /** Wait up to the speak window for an in-flight preparation, then drop it. */
  function waitFor(pending, deadline, attempt, key) {
    // Still the one preparation in flight until it settles.
    inflight = pending;
    pending.claimed = true;
    let settled = false;
    const timer = later(
      () => {
        settled = true;
        drop('late', key);
      },
      Math.max(0, deadline - Date.now())
    );
    pending.result.then((line) => {
      if (settled || attempt !== speakAttempt) return;
      settled = true;
      clearTimeout(timer);
      speakTimers.delete(timer);
      if (line) speak(line, deadline, attempt);
    });
  }

  /** Mediator 'queue:update': re-prepare when the predicted next track changed. */
  function onQueueUpdate() {
    if (stopped || !previousTrack) return;
    const predicted = deps.getQueue()?.peekNext?.() ?? null;
    const target = prepared?.forKey ?? (inflight?.discarded ? null : inflight?.key) ?? null;
    if (target && !matchesKey(target, predicted)) {
      discardPreparation();
      if (!inflight) prepareAgainIfNeeded();
      return;
    }
    if (prepareTriggered && !prepared && !inflight && predicted) {
      if (!matchesKey(attemptedKey, predicted)) prepare();
    }
  }

  /** FR-006: the next line comes at the Nth transition after this call. */
  function resetCounter() {
    transitionsSinceSpoken = 0;
    // A line prepared for a transition that is no longer due would never be
    // spoken; drop it now so an in-flight one skips its TTS.
    if ((prepared || (inflight && !inflight.discarded)) && !willBeDue()) {
      drop('stale', prepared?.forKey ?? inflight.key);
      discardPreparation();
      attemptedKey = null; // not a failure: the target may be prepared again later
    }
  }

  function shutdown() {
    if (stopped) return;
    logStats(stats.day);
    stopped = true;
    clearPrepareTimer();
    clearSpeakTimers();
    discardPreparation();
  }

  return {
    onTrackChange,
    onQueueUpdate,
    resetCounter,
    shutdown,
    // Introspection for tests and logs.
    getTransitionsSinceSpoken: () => transitionsSinceSpoken,
    getSpokenLines: () => [...spoken],
    getStats: () => ({ ...stats })
  };
}
