import { buildContext, trackKey } from './context.js';
import { logger } from '../../utils/logger.js';

// When DJ lines are prepared and spoken (research R5). Lines are written during
// the previous track and overlaid at the next track's start. Nothing here is
// ever awaited by the playback path: track starts are reported to the planner
// after the fact, so a slow or failed line can only be dropped, never delay
// music (FR-008, SC-008).

const PREPARE_LEAD_MS = 30 * 1000;
const SPEAK_GRACE_MS = 2000;
const SPOKEN_MEMORY = 20;

/**
 * @param {Object} deps
 * @param {() => { enabled: boolean, interval: number }} deps.getSettings
 * @param {() => Object|null} deps.getQueue - Queue with peekNext()
 * @param {() => Object|null} deps.getPlayer - MusicPlayer with overlay()/isPaused()
 * @param {() => Array<{ id: string, bot?: boolean }>} deps.getConnectedUsers
 * @param {() => Set<string>} [deps.getOptOuts]
 * @param {() => boolean} deps.canAttempt - breaker gate; consumes a half-open slot
 * @param {() => boolean} deps.isLineCapReached
 * @param {(ctx: Object, recent: string[]) => Promise<Object>} deps.writeLine
 * @param {() => void} [deps.onLineSuccess] - TTS succeeded (usage + breaker)
 * @param {(kind: string, error: Error) => void} [deps.onLineFailure]
 */
export function createLinePlanner(deps) {
  const {
    getSettings,
    getQueue,
    getPlayer,
    getConnectedUsers,
    getOptOuts = () => new Set(),
    canAttempt,
    isLineCapReached,
    writeLine,
    onLineSuccess = () => {},
    onLineFailure = () => {}
  } = deps;

  let currentTrack = null;
  let transitionsSinceSpoken = 0;
  let prepared = null; // a finished DJ Line waiting for its track
  let inflight = null; // { forKey, cancelled }
  let pendingPrepare = false;
  let awaiting = null; // { key, timer }: a due transition waiting on `inflight`
  let prepTimer = null;
  let prepWindowOpen = false;
  let attemptedKey = null; // one attempt per predicted track per window
  const spoken = [];
  const daily = { due: 0, spoken: 0 };

  const settings = () => getSettings() ?? { enabled: false, interval: 3 };
  const hasListener = () => (getConnectedUsers() ?? []).some((u) => !u.bot);
  const isPaused = () => Boolean(getPlayer()?.isPaused?.());

  function drop(reason, key, extra = '') {
    logger.info(`[DJ] Line dropped (${reason}) key=${key ?? 'none'}${extra}`);
  }

  /** The reason the DJ must stay quiet right now, or null (R5 step 5). */
  function silenceReason({ forPreparation }) {
    if (!settings().enabled) return 'disabled';
    if (isPaused()) return 'paused';
    if (!hasListener()) return 'no-listeners';
    // The cap counts lines at TTS time, so a line already prepared is within it.
    if (forPreparation && isLineCapReached()) return 'cap';
    return null;
  }

  function nextIsDue() {
    return transitionsSinceSpoken + 1 >= settings().interval;
  }

  function speak(line, key) {
    const reason = silenceReason({ forPreparation: false });
    if (reason) return drop(reason, key);

    // FR-017/FR-020: an event can be missed, so re-read who is present and who
    // has opted out right before speaking. Dropping here keeps the counter.
    if (line.namedUserIds?.length > 0) {
      const present = new Set((getConnectedUsers() ?? []).map((u) => u.id));
      const optedOut = getOptOuts() ?? new Set();
      if (line.namedUserIds.some((id) => !present.has(id) || optedOut.has(id))) {
        return drop('stale-member', key);
      }
    }
    if (spoken.includes(line.text)) return drop('validation', key, ' (repeat)');

    if (!getPlayer()?.overlay?.(line.pcm)) return drop('late', key, ' (player not playing)');

    transitionsSinceSpoken = 0;
    spoken.push(line.text);
    if (spoken.length > SPOKEN_MEMORY) spoken.shift();
    daily.spoken++;
    logger.info(`[DJ] Line spoken key=${key} chars=${line.text.length}`);
  }

  function clearAwaiting() {
    if (awaiting) clearTimeout(awaiting.timer);
    awaiting = null;
  }

  function cancelInflight() {
    if (inflight) {
      inflight.cancelled = true;
      pendingPrepare = false;
    }
  }

  function prepare() {
    if (inflight) {
      pendingPrepare = true;
      return;
    }
    if (!prepWindowOpen) return;

    const queue = getQueue();
    const next = queue?.peekNext?.() ?? null;
    if (!next || !nextIsDue()) return;
    const key = trackKey(next);
    if (prepared?.forKey === key || attemptedKey === key) return;
    if (silenceReason({ forPreparation: true })) return;
    // Last gate: an open breaker refuses, and a half-open one lets this through.
    if (!canAttempt()) return;

    prepared = null;
    attemptedKey = key;
    const job = { forKey: key, cancelled: false };
    inflight = job;
    const startedAt = Date.now();
    const ctx = buildContext({
      previous: currentTrack,
      next,
      theme: null,
      present: getConnectedUsers() ?? [],
      recentLines: spoken
    });

    Promise.resolve()
      .then(() => writeLine(ctx, [...spoken]))
      .then(
        (line) => {
          onLineSuccess();
          const ms = Date.now() - startedAt;
          if (job.cancelled) return drop('stale', key);
          logger.info(`[DJ] Line prepared key=${key} chars=${line.text.length} ms=${ms}`);
          if (awaiting?.key === key) {
            clearAwaiting();
            speak(line, key);
          } else {
            prepared = line;
          }
        },
        (error) => {
          const kind = error?.kind ?? 'llm';
          onLineFailure(kind, error);
          const reason = kind === 'validation' ? 'validation' : 'service';
          if (awaiting?.key === key) clearAwaiting();
          if (!job.cancelled) drop(reason, key, ` (${error?.message ?? error})`);
        }
      )
      .finally(() => {
        if (inflight === job) inflight = null;
        if (pendingPrepare) {
          pendingPrepare = false;
          prepare();
        }
      })
      .catch((error) => logger.warn('[DJ] Line preparation error:', error?.message ?? error));
  }

  function schedulePreparation(track) {
    if (prepTimer) clearTimeout(prepTimer);
    prepTimer = null;
    prepWindowOpen = false;
    attemptedKey = null;
    const durationMs = Number(track.duration) > 0 ? Number(track.duration) * 1000 : 0;
    const delay = Math.max(0, durationMs - PREPARE_LEAD_MS);
    if (delay === 0) {
      prepWindowOpen = true;
      prepare();
      return;
    }
    prepTimer = setTimeout(() => {
      prepTimer = null;
      prepWindowOpen = true;
      prepare();
    }, delay);
    prepTimer.unref?.();
  }

  /**
   * Mediator `track:change`. A transition is a non-null start whose previous
   * `track:change` was also non-null; a stop or the first start after boot is
   * not one (FR-006).
   * @param {Object|null} track
   */
  function onTrackChange(track) {
    clearAwaiting();

    if (!track) {
      currentTrack = null;
      prepared = null;
      cancelInflight();
      if (prepTimer) clearTimeout(prepTimer);
      prepTimer = null;
      prepWindowOpen = false;
      return;
    }

    const isTransition = currentTrack !== null;
    currentTrack = track;
    const key = trackKey(track);
    const line = prepared;
    prepared = null;

    if (isTransition) {
      transitionsSinceSpoken++;
      if (transitionsSinceSpoken >= settings().interval) {
        const reason = silenceReason({ forPreparation: false });
        if (reason) {
          drop(reason, key);
        } else {
          daily.due++;
          if (line?.forKey === key) {
            speak(line, key);
          } else if (inflight && !inflight.cancelled && inflight.forKey === key) {
            // Never wait on the track: it is already playing. Speak if the line
            // lands within the FR-003 window, otherwise drop it.
            awaiting = {
              key,
              timer: setTimeout(() => {
                awaiting = null;
                if (inflight?.forKey === key) inflight.cancelled = true;
                drop('late', key);
              }, SPEAK_GRACE_MS)
            };
            awaiting.timer.unref?.();
          } else {
            drop(line ? 'stale' : 'late', key);
          }
        }
      }
    }

    // Anything prepared or in flight for another track is stale now.
    if (inflight && inflight.forKey !== key && !inflight.cancelled) cancelInflight();
    schedulePreparation(track);
  }

  /** Mediator `queue:update`: re-prepare when the predicted next track changed. */
  function onQueueUpdate() {
    if (!currentTrack) return;
    const predicted = trackKey(getQueue()?.peekNext?.() ?? null);
    if (prepared && prepared.forKey !== predicted) {
      drop('stale', prepared.forKey, ' (queue changed)');
      prepared = null;
    }
    if (inflight && !inflight.cancelled && inflight.forKey !== predicted && !awaiting) {
      cancelInflight();
    }
    if (prepWindowOpen && currentTrack && !prepared && predicted !== attemptedKey) prepare();
  }

  /** Restart the interval count (setting changes, FR-006). */
  function resetCounter() {
    transitionsSinceSpoken = 0;
  }

  /** Log and reset the SC-002 counters (local-day rollover and shutdown). */
  function logDailyStats() {
    const ratio = daily.due > 0 ? (daily.spoken / daily.due).toFixed(2) : 'n/a';
    logger.info(`[DJ] Daily lines: due=${daily.due} spoken=${daily.spoken} ratio=${ratio}`);
    daily.due = 0;
    daily.spoken = 0;
  }

  function stop() {
    clearAwaiting();
    if (prepTimer) clearTimeout(prepTimer);
    prepTimer = null;
    cancelInflight();
    prepared = null;
  }

  return {
    onTrackChange,
    onQueueUpdate,
    resetCounter,
    logDailyStats,
    stop,
    // Introspection for tests and diagnostics.
    getTransitionsSinceSpoken: () => transitionsSinceSpoken,
    getPrepared: () => prepared,
    getDailyStats: () => ({ ...daily }),
    getRecentSpoken: () => [...spoken]
  };
}
