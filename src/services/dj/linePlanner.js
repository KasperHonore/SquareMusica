/**
 * Decides when a DJ line is prepared and spoken (research R5).
 *
 * Driven by the mediator's `track:change` and `queue:update` events. Every
 * handler is synchronous and never awaits: preparation runs in the background
 * and a line is either overlaid the moment it is ready or dropped, so the DJ
 * can never delay a track (FR-008). Everything external is injected, which
 * keeps this module free of transports and testable with fake timers.
 * MUST NOT import src/transports/.
 */
import { trackKey } from './context.js';
import { logger } from '../../utils/logger.js';

const PREPARE_LEAD_MS = 30 * 1000;
const SPEAK_WAIT_MS = 2000;
const SPOKEN_HISTORY = 20;

function localDay(now = new Date()) {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/**
 * @param {Object} deps
 * @param {() => { enabled: boolean, interval: number }} deps.getSettings
 * @param {() => Object|null} deps.getQueue - Queue with getCurrent() and peekNext()
 * @param {() => Object|null} deps.getPlayer - MusicPlayer with overlay() and isPaused()
 * @param {() => Object|null} deps.getVoiceContext - { connectedUsers } or null
 * @param {() => Set<string>} deps.getOptOuts - Opted-out Discord user ids
 * @param {() => boolean} deps.isCapReached - Daily line cap reached
 * @param {() => boolean} deps.isBreakerOpen - Breaker open (non-mutating)
 * @param {() => boolean} deps.canAttempt - Breaker gate (half-open aware); called only right before a write
 * @param {(params: Object) => Object} deps.buildContext
 * @param {(ctx: Object, recentSpoken: string[]) => Promise<Object>} deps.writeLine
 * @param {() => string|null} [deps.getTheme]
 * @param {() => boolean} [deps.isIntroPending] - Themed intro is due (FR-028)
 * @param {() => void} [deps.clearIntroPending]
 */
export function createLinePlanner(deps) {
  let previousTrack = null;
  let currentTrack = null;
  let currentStartedAt = 0;
  let transitionsSinceSpoken = 0;

  // The one preparation that may exist at a time:
  // { forKey, status: 'pending'|'ready'|'failed', line, reason, promise, startedAt, discarded }
  let prepared = null;
  let prepareTimer = null;
  let prepareWindowOpen = false;
  let inFlight = null;
  let retryWhenSettled = false;
  // A due transition waiting (≤ 2 s) for an in-flight preparation.
  let waiting = null;

  const spoken = [];
  let lastSpoken = null;

  // The themed-mode intro (FR-028): one theme-only line, prepared as soon as
  // the intro is pending and spoken over the next track to start, transition
  // or not (the FR-006 exception). { status, line, promise, discarded }
  let intro = null;

  let statsDay = localDay();
  let dueCount = 0;
  let spokenCount = 0;

  function logDailyStats(day) {
    const ratio = dueCount === 0 ? 1 : spokenCount / dueCount;
    logger.info(
      `[DJ] Daily lines for ${day}: due=${dueCount} spoken=${spokenCount} ratio=${ratio.toFixed(2)}`
    );
  }

  function rollDay() {
    const today = localDay();
    if (today === statsDay) return;
    logDailyStats(statsDay);
    statsDay = today;
    dueCount = 0;
    spokenCount = 0;
  }

  function drop(reason, key, detail) {
    logger.info(`[DJ] Line dropped (${reason})`, { key, ...(detail ? { detail } : {}) });
  }

  function hasListeners() {
    const users = deps.getVoiceContext()?.connectedUsers ?? [];
    return users.some((u) => !u.bot);
  }

  function isPaused() {
    return deps.getPlayer()?.isPaused?.() === true;
  }

  /**
   * The first silence condition that holds, or null (R5 step 5). The daily
   * cap gates preparation only: a prepared line was already counted when its
   * TTS succeeded, so speaking it never exceeds the cap.
   */
  function silenceReason({ forPrepare }) {
    const settings = deps.getSettings();
    if (!settings?.enabled) return 'disabled';
    if (isPaused()) return 'paused';
    if (!hasListeners()) return 'no-listeners';
    if (deps.isBreakerOpen()) return 'service';
    if (forPrepare && deps.isCapReached()) return 'cap';
    return null;
  }

  function nextTransitionIsDue() {
    const settings = deps.getSettings();
    return Boolean(settings?.enabled) && transitionsSinceSpoken + 1 >= settings.interval;
  }

  function discardPrepared() {
    if (prepared) prepared.discarded = true;
    prepared = null;
  }

  function clearPrepareTimer() {
    clearTimeout(prepareTimer);
    prepareTimer = null;
  }

  function cancelWaiting() {
    if (!waiting) return;
    clearTimeout(waiting.timer);
    waiting.cancelled = true;
    waiting = null;
  }

  function prepare() {
    if (!currentTrack || !nextTransitionIsDue()) return;
    const queue = deps.getQueue();
    const next = queue?.peekNext?.() ?? null;
    if (!next) return;

    const forKey = trackKey(next);
    if (prepared && prepared.forKey === forKey && prepared.status !== 'failed') return;

    // One preparation at a time, even if the running one was discarded:
    // try again once it settles.
    if (inFlight) {
      retryWhenSettled = true;
      return;
    }

    const silent = silenceReason({ forPrepare: true });
    if (silent) {
      prepared = { forKey, status: 'failed', reason: silent, discarded: false };
      return;
    }
    if (!deps.canAttempt()) {
      prepared = { forKey, status: 'failed', reason: 'service', discarded: false };
      return;
    }

    const ctx = deps.buildContext({
      previous: currentTrack,
      next,
      theme: deps.getTheme?.() ?? null,
      present: (deps.getVoiceContext()?.connectedUsers ?? []).map((u) => ({
        userId: u.id,
        speakableName: null,
        optedOut: deps.getOptOuts().has(u.id)
      })),
      recentLines: spoken.slice(-5)
    });

    const entry = { forKey, status: 'pending', line: null, reason: null, discarded: false };
    entry.startedAt = Date.now();
    entry.promise = Promise.resolve()
      .then(() => deps.writeLine(ctx, spoken.slice()))
      .then(
        (line) => {
          entry.status = 'ready';
          entry.line = line;
          logger.info('[DJ] Line prepared', {
            key: forKey,
            chars: line.text.length,
            ms: Date.now() - entry.startedAt
          });
        },
        (error) => {
          entry.status = 'failed';
          entry.reason = error?.kind === 'validation' ? 'validation' : 'service';
          logger.info(`[DJ] Line preparation failed (${entry.reason})`, {
            key: forKey,
            detail: error?.message
          });
        }
      )
      .finally(() => {
        inFlight = null;
        if (retryWhenSettled) {
          retryWhenSettled = false;
          if (prepareWindowOpen && !prepared) prepare();
        }
      });
    inFlight = entry.promise;
    prepared = entry;
  }

  function schedulePrepare() {
    clearPrepareTimer();
    prepareWindowOpen = false;
    if (!currentTrack || !nextTransitionIsDue()) return;

    const durationMs = (Number(currentTrack.duration) || 0) * 1000;
    const elapsed = Date.now() - currentStartedAt;
    const delay =
      durationMs < PREPARE_LEAD_MS ? 0 : Math.max(0, durationMs - PREPARE_LEAD_MS - elapsed);

    const open = () => {
      prepareTimer = null;
      prepareWindowOpen = true;
      prepare();
    };
    if (delay === 0) {
      open();
    } else {
      prepareTimer = setTimeout(open, delay);
      prepareTimer.unref?.();
    }
  }

  // Overlay a ready line on the track identified by key, after the speak-time checks.
  function speak(line, key) {
    const silent = silenceReason({ forPrepare: false });
    if (silent) return drop(silent, key);

    // R7 / FR-017: re-read presence and opt-outs; an event may have been missed.
    if (line.namedUserIds.length > 0) {
      const present = new Set((deps.getVoiceContext()?.connectedUsers ?? []).map((u) => u.id));
      const optOuts = deps.getOptOuts();
      const gone = line.namedUserIds.find((id) => !present.has(id) || optOuts.has(id));
      if (gone) return drop('stale-member', key, { userId: gone });
    }

    if (lastSpoken && lastSpoken.key === key && lastSpoken.text === line.text) {
      return drop('repeat', key);
    }

    if (!deps.getPlayer()?.overlay(line.pcm)) return drop('not-playing', key);

    spokenCount++;
    transitionsSinceSpoken = 0;
    lastSpoken = { key, text: line.text };
    spoken.push(line.text);
    if (spoken.length > SPOKEN_HISTORY) spoken.shift();
    logger.info('[DJ] Line spoken', { key, chars: line.text.length });

    // The counter just reset, so whether the next transition is due changed.
    schedulePrepare();
  }

  function introPending() {
    return deps.isIntroPending?.() === true;
  }

  function finishIntro() {
    if (intro) intro.discarded = true;
    intro = null;
    deps.clearIntroPending?.();
  }

  /** Start writing the themed intro now, so it is ready when the next track starts. */
  function prepareIntro() {
    if (!introPending()) return;
    if (!deps.getSettings()?.enabled) {
      // Commentary off: themed mode builds the queue silently (FR-028).
      finishIntro();
      return;
    }
    if (intro && !intro.discarded && intro.status !== 'failed') return;
    if (deps.isCapReached() || !deps.canAttempt()) {
      intro = { status: 'failed', reason: deps.isCapReached() ? 'cap' : 'service' };
      return;
    }

    const theme = deps.getTheme?.() ?? null;
    const ctx = {
      intro: true,
      previous: null,
      next: null,
      theme,
      present: [],
      allowedNames: [],
      facts: [{ id: 'f1', kind: 'theme', text: `Tonight's theme: ${theme}.` }],
      recentLines: spoken.slice(-5)
    };
    const entry = { status: 'pending', line: null, reason: null, discarded: false };
    entry.startedAt = Date.now();
    entry.promise = Promise.resolve()
      .then(() => deps.writeLine(ctx, spoken.slice()))
      .then(
        (line) => {
          entry.status = 'ready';
          entry.line = line;
          logger.info('[DJ] Intro prepared', {
            chars: line.text.length,
            ms: Date.now() - entry.startedAt
          });
        },
        (error) => {
          entry.status = 'failed';
          entry.reason = error?.kind === 'validation' ? 'validation' : 'service';
          logger.info(`[DJ] Intro preparation failed (${entry.reason})`, {
            detail: error?.message
          });
        }
      );
    intro = entry;
  }

  // Overlay the intro. Unlike speak(), never touches transitionsSinceSpoken.
  function speakIntro(line, key) {
    const silent = silenceReason({ forPrepare: false });
    if (silent) {
      finishIntro();
      return drop(silent, key, { intro: true });
    }
    if (!deps.getPlayer()?.overlay(line.pcm)) {
      // Nothing to speak over; keep the line for the next track to start.
      return drop('not-playing', key, { intro: true });
    }
    spokenCount++;
    spoken.push(line.text);
    if (spoken.length > SPOKEN_HISTORY) spoken.shift();
    logger.info('[DJ] Intro spoken', { key, chars: line.text.length });
    finishIntro();
  }

  /** The intro is due on this start, transition or not (FR-006 exception). */
  function handleIntro(key) {
    if (!deps.getSettings()?.enabled) return finishIntro();
    if (!intro) prepareIntro();
    const entry = intro;
    if (!entry) return;
    if (entry.status === 'failed') {
      finishIntro();
      return drop(entry.reason ?? 'service', key, { intro: true });
    }
    if (entry.status === 'ready') return speakIntro(entry.line, key);

    // Still being written: speak it if it lands within 2 s of this start,
    // otherwise keep it for the next track to start.
    const startedFor = key;
    entry.promise.then(() => {
      if (entry.discarded || intro !== entry) return;
      if (entry.status === 'failed') {
        finishIntro();
        return drop(entry.reason ?? 'service', startedFor, { intro: true });
      }
      if (trackKey(currentTrack) !== startedFor) return;
      if (Date.now() - currentStartedAt > SPEAK_WAIT_MS) return;
      speakIntro(entry.line, startedFor);
    });
  }

  function handleDueTransition(key) {
    const silent = silenceReason({ forPrepare: false });
    if (silent) {
      discardPrepared();
      return drop(silent, key);
    }
    dueCount++;

    const entry = prepared;
    prepared = null;
    if (!entry || entry.discarded) return drop('no-line', key);
    if (entry.forKey !== key) {
      entry.discarded = true;
      return drop('stale', key, { preparedFor: entry.forKey });
    }
    if (entry.status === 'failed') return drop(entry.reason ?? 'service', key);
    if (entry.status === 'ready') return speak(entry.line, key);

    // Still in flight: give it until 2 s after track start, then drop.
    const wait = { cancelled: false, timer: null };
    wait.timer = setTimeout(() => {
      if (wait.cancelled) return;
      wait.cancelled = true;
      waiting = null;
      entry.discarded = true;
      drop('late', key);
    }, SPEAK_WAIT_MS);
    wait.timer.unref?.();
    waiting = wait;

    entry.promise.then(() => {
      if (wait.cancelled) return;
      clearTimeout(wait.timer);
      wait.cancelled = true;
      waiting = null;
      if (trackKey(currentTrack) !== key) return drop('stale', key);
      if (entry.status === 'ready') speak(entry.line, key);
      else drop(entry.reason ?? 'service', key);
    });
  }

  function onTrackChange(track) {
    rollDay();
    cancelWaiting();
    clearPrepareTimer();
    prepareWindowOpen = false;

    if (!track) {
      // Stop or an empty queue: the next start is not a transition (FR-006).
      previousTrack = null;
      currentTrack = null;
      discardPrepared();
      return;
    }

    const isTransition = currentTrack !== null;
    previousTrack = currentTrack;
    currentTrack = track;
    currentStartedAt = Date.now();
    const key = trackKey(track);

    if (isTransition) transitionsSinceSpoken++;

    if (introPending()) {
      // The intro takes this start; a regular line for it is not spoken, and
      // the interval count carries on as it was.
      discardPrepared();
      handleIntro(key);
    } else if (isTransition) {
      const settings = deps.getSettings();
      if (settings?.enabled && transitionsSinceSpoken >= settings.interval) {
        handleDueTransition(key);
      } else {
        discardPrepared();
      }
    } else {
      discardPrepared();
    }

    schedulePrepare();
  }

  function onQueueUpdate() {
    if (!currentTrack) return;
    const next = deps.getQueue()?.peekNext?.() ?? null;
    const nextKey = trackKey(next);

    if (prepared && prepared.forKey !== nextKey) {
      logger.info('[DJ] Predicted next track changed; discarding prepared line', {
        preparedFor: prepared.forKey,
        next: nextKey
      });
      discardPrepared();
    }
    if (prepareWindowOpen && next && (!prepared || prepared.status === 'failed')) prepare();
  }

  /** Start the interval count again (FR-006), and re-plan for the current track. */
  function resetCounter() {
    transitionsSinceSpoken = 0;
    refresh();
  }

  /** Re-plan after a settings change: drop work that is no longer due, schedule what now is. */
  function refresh() {
    if (introPending() && !deps.getSettings()?.enabled) finishIntro();
    if (!nextTransitionIsDue()) {
      clearPrepareTimer();
      prepareWindowOpen = false;
      discardPrepared();
      return;
    }
    if (!prepareTimer && !prepareWindowOpen) schedulePrepare();
  }

  function shutdown() {
    if (intro) intro.discarded = true;
    intro = null;
    cancelWaiting();
    clearPrepareTimer();
    discardPrepared();
    logDailyStats(statsDay);
  }

  return {
    onTrackChange,
    onQueueUpdate,
    resetCounter,
    refresh,
    prepareIntro,
    rollDay,
    shutdown,
    /** For tests and diagnostics. */
    getDebugState: () => ({
      transitionsSinceSpoken,
      previousKey: trackKey(previousTrack),
      currentKey: trackKey(currentTrack),
      prepared: prepared && { forKey: prepared.forKey, status: prepared.status },
      intro: intro && { status: intro.status },
      due: dueCount,
      spoken: spokenCount,
      recentSpoken: spoken.slice()
    })
  };
}
