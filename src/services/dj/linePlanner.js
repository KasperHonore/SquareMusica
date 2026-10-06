import { buildContext, isSameTrack, trackKey } from './context.js';
import { logger } from '../../utils/logger.js';

// Decides when the DJ speaks and has the line ready in time (research R5).
//
// Lines are prepared during the track before the transition they belong to and
// overlaid when the next track starts. Nothing here is awaited from the playback
// path: track:change and queue:update handlers only read state, start timers and
// fire off promises, so the DJ can never delay a track (FR-008, SC-008).

const PREPARE_LEAD_MS = 30 * 1000;
const SPEAK_WINDOW_MS = 2000;
const RING_SIZE = 20;

function localDay(now = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

/**
 * @param {Object} deps
 * @param {() => { enabled: boolean, interval: number }} deps.getSettings
 * @param {() => Object|null} deps.getVoiceContext - musicManager.getVoiceContext
 * @param {() => Object|null} deps.getQueue - The shared Queue
 * @param {() => Object|null} deps.getPlayer - The shared MusicPlayer
 * @param {(ctx: Object, recentSpoken: string[]) => Promise<Object>} deps.writeLine
 * @param {() => boolean} deps.isBreakerOpen
 * @param {() => boolean} deps.isCapReached - Daily line cap
 * @param {() => Set<string>} [deps.getOptOuts] - Opted-out Discord user ids
 * @param {() => string} [deps.today] - Local day, YYYY-MM-DD
 */
export function createLinePlanner(deps) {
  const getOptOuts = deps.getOptOuts ?? (() => new Set());
  const today = deps.today ?? (() => localDay());

  let transitionsSinceSpoken = 0;
  // Whether the last track:change was a track. A start that follows a stop, an
  // emptied queue or boot is not a transition (FR-006).
  let previousTrack = null;
  let trackStartedAt = 0;
  let epoch = 0;

  let prepareTimer = null;
  let prepareTimeReached = false;
  let prepared = null; // { line, epoch }
  let inflight = null; // { key, epoch, promise }
  let reprepareAfterInflight = false;
  let failed = null; // { epoch, reason } of the last failed preparation
  let waiting = null; // { track, key, epoch, timer }

  const spoken = []; // last RING_SIZE spoken texts, oldest first
  let lastSpoken = null; // { forKey, text }

  // Daily SC-002 counters: a line is due when the interval selects a transition
  // while no silence condition holds.
  let stats = { day: today(), due: 0, spoken: 0 };

  function logStats(reason) {
    const ratio = stats.due === 0 ? 'n/a' : `${Math.round((stats.spoken / stats.due) * 100)}%`;
    logger.info(
      `[DJ] Lines ${reason} for ${stats.day}: due=${stats.due} spoken=${stats.spoken} ratio=${ratio}`
    );
  }

  function rolloverStats() {
    const day = today();
    if (day === stats.day) return;
    logStats('rollover');
    stats = { day, due: 0, spoken: 0 };
  }

  function humansPresent() {
    return (deps.getVoiceContext()?.connectedUsers ?? []).length > 0;
  }

  /**
   * The first silence condition from R5 step 5 that holds, or null.
   * `forPrepare` adds the conditions that only matter before money is spent.
   */
  function silenceReason({ forPrepare }) {
    if (!deps.getSettings().enabled) return 'disabled';
    if (deps.getPlayer()?.isPaused?.()) return 'paused';
    if (!humansPresent()) return 'no-listeners';
    if (deps.isBreakerOpen()) return 'service';
    // A prepared line was counted against the cap when its TTS succeeded, so the
    // cap only stops new preparations; it never wastes a line already paid for.
    if (forPrepare && deps.isCapReached()) return 'cap';
    return null;
  }

  function drop(reason, key) {
    logger.info(`[DJ] Line dropped (${reason})${key ? ` for ${key}` : ''}`);
  }

  function willBeDue() {
    return transitionsSinceSpoken + 1 >= deps.getSettings().interval;
  }

  function predictedNext() {
    return deps.getQueue()?.peekNext?.() ?? null;
  }

  function clearPrepareTimer() {
    if (prepareTimer) clearTimeout(prepareTimer);
    prepareTimer = null;
  }

  function clearWaiting() {
    if (waiting) clearTimeout(waiting.timer);
    waiting = null;
  }

  function prepare() {
    if (!previousTrack) return;
    if (inflight) {
      reprepareAfterInflight = true;
      return;
    }
    if (!willBeDue()) return;
    const next = predictedNext();
    if (!next) return;
    if (silenceReason({ forPrepare: true })) return;

    const key = trackKey(next);
    const ctx = buildContext({
      previous: previousTrack,
      next,
      theme: null,
      present: [],
      recentLines: spoken
    });
    const startedAt = Date.now();
    const myEpoch = epoch;
    const job = { key, epoch: myEpoch, promise: null };
    inflight = job;

    job.promise = Promise.resolve()
      .then(() => deps.writeLine(ctx, [...spoken]))
      .then(
        (line) => {
          logger.info(
            `[DJ] Line prepared for ${line.forKey}: ${line.text.length} chars in ${Date.now() - startedAt} ms`
          );
          return line;
        },
        (error) => {
          const reason = error?.kind === 'validation' ? 'validation' : 'service';
          logger.info(`[DJ] Line preparation failed (${reason}): ${error?.message ?? error}`);
          failed = { epoch: myEpoch, reason };
          return null;
        }
      )
      .then((line) => {
        if (inflight === job) inflight = null;
        onPrepared(job, line);
      });
  }

  function onPrepared(job, line) {
    // The track this line was for has started and is waiting for it (2 s window).
    if (waiting && waiting.epoch === epoch && job.epoch === epoch - 1) {
      const target = waiting;
      clearWaiting();
      if (line && isSameTrack(line.forKey, target.track)) speak(line, target.key);
      else drop(line ? 'stale' : (failed?.reason ?? 'service'), target.key);
    } else if (line && job.epoch === epoch) {
      if (line.forKey === trackKey(predictedNext())) prepared = { line, epoch };
      else drop('stale', line.forKey);
    }

    // The predicted next track changed while this job ran. A failed job is not
    // retried: the breaker decides when the service is worth another try.
    if (reprepareAfterInflight) {
      reprepareAfterInflight = false;
      if (prepareTimeReached && !prepared) prepare();
    }
  }

  function speak(line, key) {
    const reason = silenceReason({ forPrepare: false });
    if (reason) {
      drop(reason === 'disabled' || reason === 'paused' ? 'stale' : reason, key);
      return false;
    }

    // Membership can change without an event reaching us, so re-read it right
    // before speaking (R7, FR-017, FR-020).
    const present = new Set((deps.getVoiceContext()?.connectedUsers ?? []).map((u) => u.id));
    const optOuts = getOptOuts();
    if (line.namedUserIds.some((id) => !present.has(id) || optOuts.has(id))) {
      drop('stale-member', key);
      return false;
    }

    // FR-007; also keeps a looped track from hearing the same words twice.
    if (
      spoken.includes(line.text) ||
      (lastSpoken?.forKey === key && lastSpoken.text === line.text)
    ) {
      drop('validation', key);
      return false;
    }

    const player = deps.getPlayer();
    if (!player?.overlay?.(line.pcm)) {
      drop('late', key);
      return false;
    }

    transitionsSinceSpoken = 0;
    spoken.push(line.text);
    if (spoken.length > RING_SIZE) spoken.shift();
    lastSpoken = { forKey: key, text: line.text };
    rolloverStats();
    stats.spoken++;
    logger.info(`[DJ] Line spoken for ${key}: ${line.text.length} chars`);
    return true;
  }

  function schedulePreparation() {
    clearPrepareTimer();
    prepareTimeReached = false;
    if (!willBeDue()) return;

    const durationS = Number(previousTrack?.duration);
    const leadMs =
      Number.isFinite(durationS) && durationS * 1000 >= PREPARE_LEAD_MS
        ? durationS * 1000 - PREPARE_LEAD_MS
        : 0;
    const delay = Math.max(0, trackStartedAt + leadMs - Date.now());

    prepareTimer = setTimeout(() => {
      prepareTimer = null;
      prepareTimeReached = true;
      prepare();
    }, delay);
    prepareTimer.unref?.();
  }

  /**
   * Handler for the mediator's `track:change`.
   * @param {Object|null} track
   */
  function onTrackChange(track) {
    epoch++;
    clearPrepareTimer();
    clearWaiting();
    prepareTimeReached = false;
    reprepareAfterInflight = false;
    const candidate = prepared?.epoch === epoch - 1 ? prepared.line : null;
    prepared = null;

    if (!track) {
      previousTrack = null;
      return;
    }

    const isTransition = previousTrack !== null;
    previousTrack = track;
    trackStartedAt = Date.now();
    const key = trackKey(track);

    if (isTransition) {
      transitionsSinceSpoken++;
      if (transitionsSinceSpoken >= deps.getSettings().interval) {
        // Without a line in hand the cap also silences this transition.
        const reason = silenceReason({ forPrepare: !candidate });
        if (reason) {
          if (reason !== 'disabled' && reason !== 'paused') drop(reason, key);
        } else {
          rolloverStats();
          stats.due++;
          if (candidate && isSameTrack(candidate.forKey, track)) {
            speak(candidate, key);
          } else if (inflight && inflight.epoch === epoch - 1 && isSameTrack(inflight.key, track)) {
            const timer = setTimeout(() => {
              waiting = null;
              drop('late', key);
            }, SPEAK_WINDOW_MS);
            timer.unref?.();
            waiting = { track, key, epoch, timer };
          } else if (candidate) {
            drop('stale', key);
          } else {
            drop(failed?.epoch === epoch - 1 ? failed.reason : 'late', key);
          }
        }
      }
    }

    schedulePreparation();
  }

  /**
   * Handler for the mediator's `queue:update`: if the predicted next track
   * changed, the prepared line is discarded and a new one prepared.
   */
  function onQueueUpdate() {
    if (!previousTrack) return;
    // Mid-advance the queue index has moved but track:change has not fired yet;
    // the next track:change sorts that out.
    const current = deps.getQueue()?.getCurrent?.();
    if (trackKey(current) !== trackKey(previousTrack)) return;

    const nextKey = trackKey(predictedNext());
    if (prepared && prepared.line.forKey !== nextKey) {
      drop('stale', prepared.line.forKey);
      prepared = null;
    }
    if (inflight && inflight.epoch === epoch && inflight.key !== nextKey) {
      reprepareAfterInflight = true;
    }
    if (prepareTimeReached && !prepared && !inflight && nextKey) prepare();
  }

  /** Restart the interval count (FR-006: interval change or DJ turned on). */
  function resetCounter() {
    transitionsSinceSpoken = 0;
    if (previousTrack) schedulePreparation();
  }

  function shutdown() {
    clearPrepareTimer();
    clearWaiting();
    prepared = null;
    logStats('at shutdown');
  }

  return {
    onTrackChange,
    onQueueUpdate,
    resetCounter,
    rolloverStats,
    shutdown,
    getCounter: () => transitionsSinceSpoken,
    getStats: () => ({ ...stats }),
    getSpoken: () => [...spoken]
  };
}
