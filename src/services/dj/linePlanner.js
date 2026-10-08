/**
 * Decides when the DJ speaks and has the line ready in time (research R5).
 *
 * Driven by the mediator's `track:change` and `queue:update` events (wired by
 * djService). A line for the transition into the predicted next track is
 * prepared during the current track, then overlaid when that track actually
 * starts. Nothing here is ever awaited on the playback path: a track start
 * only ever triggers synchronous checks and an overlay call (FR-008).
 *
 * Every dependency is injected so the planner can be tested with fakes and
 * never imports transports/ or playback code (Constitution II).
 */
import { trackKey, buildContext } from './context.js';
import { writeLine as defaultWriteLine } from './lineWriter.js';
import { logger as defaultLogger } from '../../utils/logger.js';

const PREPARE_LEAD_MS = 30 * 1000;
const SPEAK_GRACE_MS = 2000;
const OVERLAY_RETRY_MS = 50;
const SPOKEN_RING_SIZE = 20;

/** Drop reasons that come from a failed preparation rather than timing. */
function failureReason(error) {
  return error?.kind === 'validation' ? 'validation' : 'service';
}

function trackDurationMs(track) {
  if (Number.isFinite(track?.duration) && track.duration > 0) return track.duration * 1000;
  const ms = track?.spotifyData?.durationMs;
  return Number.isFinite(ms) && ms > 0 ? ms : null;
}

function localDay(ms) {
  const d = new Date(ms);
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
}

/**
 * @param {Object} deps
 * @param {() => {enabled: boolean, interval: number}|null} deps.getSettings
 * @param {() => Object|null} deps.getVoiceContext - musicManager.getVoiceContext
 * @param {() => Object|null} deps.getQueue - the Queue (needs peekNext())
 * @param {() => Object|null} deps.getPlayer - the MusicPlayer (overlay, isPaused)
 * @param {() => Set<string>|string[]} [deps.getOptOuts] - opted-out Discord user ids
 * @param {() => boolean} [deps.isBreakerOpen]
 * @param {() => boolean} [deps.canAttempt] - reserves a half-open trial
 * @param {() => boolean} [deps.isCapReached] - daily line cap
 * @param {(line: Object) => void} [deps.onLineReady] - TTS succeeded
 * @param {(error: Error) => void} [deps.onLineFailed] - LLM, validation or TTS failed
 * @param {Function} [deps.writeLine]
 * @param {Object} [deps.logger]
 */
export function createLinePlanner(deps) {
  const {
    getSettings,
    getVoiceContext,
    getQueue,
    getPlayer,
    getOptOuts = () => new Set(),
    isBreakerOpen = () => false,
    canAttempt = () => true,
    isCapReached = () => false,
    onLineReady = () => {},
    onLineFailed = () => {},
    writeLine = defaultWriteLine,
    logger = defaultLogger
  } = deps;

  let previous = null; // last started track; null after a stop or at boot
  let transitionsSinceSpoken = 0;
  let prepared = null; // a ready DJ Line
  let inFlight = null; // { forKey, token, startedAt }
  let token = 0; // bumped to orphan an in-flight preparation
  let prepTimer = null;
  let prepWindowOpen = false; // the current track's preparation time has come
  let prepWanted = false; // re-run preparation once the in-flight one settles
  let waiting = null; // { key, track, timer } for a line still in flight at track start
  let retry = null; // { key, timer } for a line the player could not take yet
  let trackStartedAt = 0;
  let lastSpoken = null; // { key, text }
  const spoken = [];
  const stats = { day: localDay(Date.now()), due: 0, spoken: 0 };

  // -------------------------------------------------------------------------
  // Conditions
  // -------------------------------------------------------------------------

  function humansPresent() {
    return (getVoiceContext()?.connectedUsers ?? []).length > 0;
  }

  /** The R5 step 5 reason the DJ must stay quiet, or null. */
  function silenceReason({ forPreparation }) {
    const settings = getSettings();
    if (!settings?.enabled) return 'disabled';
    if (getPlayer()?.isPaused?.()) return 'paused';
    if (!humansPresent()) return 'no-listeners';
    if (forPreparation) {
      if (isBreakerOpen()) return 'service';
      if (isCapReached()) return 'cap';
      if (!getQueue()?.peekNext?.()) return 'no-next-track';
    }
    return null;
  }

  function interval() {
    return getSettings()?.interval ?? 1;
  }

  /** Whether the transition after the current track will be selected by the interval. */
  function nextTransitionDue() {
    return transitionsSinceSpoken + 1 >= interval();
  }

  // -------------------------------------------------------------------------
  // Logging and daily counters (SC-002)
  // -------------------------------------------------------------------------

  function rollDayIfNeeded() {
    const today = localDay(Date.now());
    if (today !== stats.day) logDailyStats('rollover', today);
  }

  function logDailyStats(why = 'shutdown', nextDay = stats.day) {
    const ratio = stats.due ? (stats.spoken / stats.due).toFixed(2) : 'n/a';
    logger.info(
      `[DJ] Daily lines (${why}, ${stats.day}): due=${stats.due} spoken=${stats.spoken} ratio=${ratio}`
    );
    stats.day = nextDay;
    stats.due = 0;
    stats.spoken = 0;
  }

  function drop(reason, key, detail = '') {
    logger.info(`[DJ] Line dropped (reason=${reason}, key=${key})${detail ? `: ${detail}` : ''}`);
  }

  // -------------------------------------------------------------------------
  // Preparation
  // -------------------------------------------------------------------------

  function discardPrepared(reason) {
    if (prepared) {
      drop(reason, prepared.forKey);
      prepared = null;
    }
  }

  function orphanInFlight() {
    if (inFlight) {
      token++;
      inFlight = null;
    }
  }

  function clearPrepTimer() {
    if (prepTimer) {
      clearTimeout(prepTimer);
      prepTimer = null;
    }
  }

  function schedulePreparation(track) {
    clearPrepTimer();
    prepWindowOpen = false;
    const durationMs = trackDurationMs(track);
    const delay = durationMs === null ? 0 : Math.max(0, durationMs - PREPARE_LEAD_MS);
    prepTimer = setTimeout(() => {
      prepTimer = null;
      prepWindowOpen = true;
      maybePrepare();
    }, delay);
    prepTimer.unref?.();
  }

  function maybePrepare() {
    if (!previous || !prepWindowOpen) return;
    if (!nextTransitionDue()) return;
    if (silenceReason({ forPreparation: true })) return;

    const target = getQueue().peekNext();
    const key = trackKey(target);
    if (prepared?.forKey === key) return;
    if (inFlight) {
      // One preparation at a time; try again when this one settles.
      if (inFlight.forKey !== key) prepWanted = true;
      return;
    }
    if (!canAttempt()) return;

    const ctx = buildContext({ previous, next: target, recentLines: spoken.slice(-5) });
    const myToken = ++token;
    const startedAt = Date.now();
    inFlight = { forKey: key, token: myToken, startedAt };

    Promise.resolve()
      .then(() => writeLine(ctx, spoken.slice()))
      .then(
        (line) => {
          // TTS succeeded, so the cost is incurred even if the line goes unused.
          onLineReady(line);
          logger.info(
            `[DJ] Line prepared (key=${line.forKey}, chars=${line.text.length}, ` +
              `ms=${Date.now() - startedAt})`
          );
          if (myToken !== token) {
            drop('stale', line.forKey, 'predicted next track changed during preparation');
            return;
          }
          prepared = line;
          if (waiting?.key === line.forKey) speakWaiting();
        },
        (error) => {
          onLineFailed(error);
          drop(failureReason(error), key, error?.message ?? String(error));
          if (myToken === token && waiting?.key === key) endWait();
        }
      )
      .finally(() => {
        if (inFlight?.token === myToken) inFlight = null;
        if (prepWanted) {
          prepWanted = false;
          maybePrepare();
        }
      });
  }

  // -------------------------------------------------------------------------
  // Speaking
  // -------------------------------------------------------------------------

  function endWait() {
    if (waiting) {
      clearTimeout(waiting.timer);
      waiting = null;
    }
  }

  function cancelRetry(reason) {
    if (retry) {
      clearTimeout(retry.timer);
      if (reason) drop(reason, retry.key);
      retry = null;
    }
  }

  function speakWaiting() {
    const { track } = waiting;
    endWait();
    const line = prepared;
    prepared = null;
    speak(line, track);
  }

  /** Overlay a ready line, after the speak-time checks (R5 step 5, R7). */
  function speak(line, track) {
    const key = trackKey(track);
    const reason = silenceReason({ forPreparation: false });
    if (reason) {
      drop(reason, key);
      return;
    }

    // Speak-time re-check (FR-017, FR-020): the voice:context event is only an
    // optimisation; this read is the guarantee.
    const present = new Set((getVoiceContext()?.connectedUsers ?? []).map((u) => u.id));
    const optOuts = new Set(getOptOuts() ?? []);
    const stale = (line.namedUserIds ?? []).filter((id) => !present.has(id) || optOuts.has(id));
    if (stale.length) {
      drop('stale-member', key);
      return;
    }

    if (lastSpoken && lastSpoken.key === key && lastSpoken.text === line.text) {
      drop('repeat', key);
      return;
    }

    if (!getPlayer()?.overlay?.(line.pcm)) {
      // The new track may not be audible yet (track:change fires as soon as
      // play() hands the resource over). Retry within the grace window rather
      // than lose the line; the track itself is never held back.
      if (previous === track && Date.now() - trackStartedAt < SPEAK_GRACE_MS) {
        retry = {
          key,
          timer: setTimeout(() => {
            retry = null;
            speak(line, track);
          }, OVERLAY_RETRY_MS)
        };
        retry.timer.unref?.();
        return;
      }
      drop('not-playing', key);
      return;
    }

    transitionsSinceSpoken = 0;
    lastSpoken = { key, text: line.text };
    spoken.push(line.text);
    if (spoken.length > SPOKEN_RING_SIZE) spoken.shift();
    stats.spoken++;
    logger.info(`[DJ] Line spoken (key=${key}, chars=${line.text.length})`);
  }

  // -------------------------------------------------------------------------
  // Events
  // -------------------------------------------------------------------------

  /** Mediator `track:change`. Synchronous; never delays the track. */
  function onTrackChange(track) {
    rollDayIfNeeded();
    clearPrepTimer();
    prepWindowOpen = false;
    endWait();
    cancelRetry('stale');
    trackStartedAt = Date.now();

    if (!track) {
      // Stop or empty queue: the next start is not a transition (FR-006).
      previous = null;
      discardPrepared('stale');
      orphanInFlight();
      prepWanted = false;
      return;
    }

    const isTransition = previous !== null;
    previous = track;

    if (isTransition) {
      transitionsSinceSpoken++;
      const due = transitionsSinceSpoken >= interval() && !silenceReason({ forPreparation: false });
      if (due) {
        const key = trackKey(track);
        const lineExists = prepared?.forKey === key || inFlight?.forKey === key;
        if (lineExists || (!isBreakerOpen() && !isCapReached())) stats.due++;
        if (prepared?.forKey === key) {
          const line = prepared;
          prepared = null;
          speak(line, track);
        } else if (inFlight?.forKey === key) {
          discardPrepared('stale');
          waiting = {
            key,
            track,
            timer: setTimeout(() => {
              waiting = null;
              orphanInFlight();
              drop('late', key, `not ready ${SPEAK_GRACE_MS} ms after track start`);
            }, SPEAK_GRACE_MS)
          };
          waiting.timer.unref?.();
        } else {
          discardPrepared('stale');
          orphanInFlight();
          drop('late', key, 'no line prepared');
        }
      } else {
        discardPrepared('stale');
      }
    }

    // A prepared line belongs to exactly one transition.
    if (!waiting) {
      discardPrepared('stale');
      if (inFlight && inFlight.forKey !== trackKey(getQueue()?.peekNext?.())) orphanInFlight();
    }

    schedulePreparation(track);
  }

  /** Mediator `queue:update`: re-prepare when the predicted next track changed. */
  function onQueueUpdate() {
    if (!previous) return;
    const key = trackKey(getQueue()?.peekNext?.() ?? null);
    if (prepared && prepared.forKey !== key) discardPrepared('stale');
    if (inFlight && inFlight.forKey !== key && waiting?.key !== inFlight.forKey) {
      orphanInFlight();
    }
    maybePrepare();
  }

  /**
   * Retry a preparation that a silence condition blocked earlier (resume,
   * someone joined the channel, breaker closed). Cheap and idempotent.
   */
  function poke() {
    maybePrepare();
  }

  /** Restart the interval count (FR-006: interval change or DJ switched on). */
  function resetCounter() {
    transitionsSinceSpoken = 0;
  }

  /** Stop timers and log the day's counters. */
  function shutdown() {
    clearPrepTimer();
    endWait();
    cancelRetry();
    orphanInFlight();
    prepared = null;
    logDailyStats('shutdown');
  }

  return {
    onTrackChange,
    onQueueUpdate,
    poke,
    resetCounter,
    shutdown,
    logDailyStats: () => logDailyStats('rollover', localDay(Date.now())),
    // Read-only views for tests and diagnostics.
    get transitionsSinceSpoken() {
      return transitionsSinceSpoken;
    },
    get prepared() {
      return prepared;
    },
    get spoken() {
      return spoken.slice();
    },
    get stats() {
      return { ...stats };
    }
  };
}
