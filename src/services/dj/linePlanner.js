import { buildContext, keyMatches, trackKey } from './context.js';
import { logger } from '../../utils/logger.js';

// When DJ lines are prepared and spoken (research R5). Lines are written during
// the previous track and overlaid at the next track's start. Nothing here is
// ever awaited by the playback path: track starts are reported to the planner
// after the fact, so a slow or failed line can only be dropped, never delay
// music (FR-008, SC-008).

const PREPARE_LEAD_MS = 30 * 1000;
const SPEAK_GRACE_MS = 2000;
const SPOKEN_MEMORY = 20;
// While the preparation window is open but the DJ must stay quiet (paused, no
// listeners, breaker open, cap), re-check this often: resuming, someone joining
// or the breaker closing emits no queue:update.
const PREPARE_RETRY_MS = 10 * 1000;

/**
 * @param {Object} deps
 * @param {() => { enabled: boolean, interval: number }} deps.getSettings
 * @param {() => Object|null} deps.getQueue - Queue with peekNext()
 * @param {() => Object|null} deps.getPlayer - MusicPlayer with overlay()/isPaused()
 * @param {() => Array<{ id: string, bot?: boolean }>} deps.getConnectedUsers
 * @param {() => Set<string>} [deps.getOptOuts]
 * @param {Object|null} [deps.store] - history and opt-out reads for member facts (db)
 * @param {() => boolean} deps.canAttempt - breaker gate; consumes a half-open slot
 * @param {() => boolean} deps.isLineCapReached
 * @param {(ctx: Object, recent: string[]) => Promise<Object>} deps.writeLine
 * @param {() => void} [deps.onLineSuccess] - TTS succeeded (usage + breaker)
 * @param {(kind: string, error: Error) => void} [deps.onLineFailure]
 * @param {() => string|null} [deps.getTheme] - the active theme, else null
 * @param {() => string|null} [deps.getIntroTheme] - the theme while its intro is
 *   pending (FR-028), else null
 * @param {() => void} [deps.clearIntro] - the intro was spoken, or commentary is off
 */
export function createLinePlanner(deps) {
  const {
    getSettings,
    getQueue,
    getPlayer,
    getConnectedUsers,
    getOptOuts = () => new Set(),
    store = null,
    canAttempt,
    isLineCapReached,
    writeLine,
    onLineSuccess = () => {},
    onLineFailure = () => {},
    getTheme = () => null,
    getIntroTheme = () => null,
    clearIntro = () => {}
  } = deps;

  let currentTrack = null;
  let transitionsSinceSpoken = 0;
  let prepared = null; // a finished DJ Line waiting for its track
  let inflight = null; // { forKey, cancelled }
  let pendingPrepare = false;
  let awaiting = null; // { key, track, timer }: a due transition waiting on `inflight`
  let prepTimer = null;
  let retryTimer = null;
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

  /**
   * The theme whose intro is still to be spoken (FR-028). With commentary off
   * the intro is never spoken, so it is cleared and themed mode stays silent.
   */
  function pendingIntro() {
    const theme = getIntroTheme() ?? null;
    if (theme && !settings().enabled) {
      clearIntro();
      return null;
    }
    return theme;
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
    // An intro for a theme that has since stopped or already been introduced.
    if (line.intro && !getIntroTheme()) return drop('stale', key, ' (intro)');

    if (!getPlayer()?.overlay?.(line.pcm)) return drop('late', key, ' (player not playing)');

    spoken.push(line.text);
    if (spoken.length > SPOKEN_MEMORY) spoken.shift();
    if (line.intro) {
      // The intro is the FR-006 exception: it leaves the interval count alone.
      clearIntro();
      logger.info(`[DJ] Theme intro spoken key=${key} chars=${line.text.length}`);
      return;
    }
    transitionsSinceSpoken = 0;
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

  function clearRetry() {
    if (retryTimer) clearTimeout(retryTimer);
    retryTimer = null;
  }

  function scheduleRetry() {
    if (retryTimer) return;
    retryTimer = setTimeout(() => {
      retryTimer = null;
      prepare();
    }, PREPARE_RETRY_MS);
    retryTimer.unref?.();
  }

  /**
   * True while the queue has advanced but the player has not reported the new
   * track yet (tryPlayWithFallback calls queue.next() and then awaits
   * play()). In that window peekNext() already looks one track too far ahead.
   */
  function isSwitching() {
    const current = getQueue()?.getCurrent?.() ?? null;
    if (!current || !currentTrack || current === currentTrack) return false;
    return !keyMatches(trackKey(currentTrack), current);
  }

  /** The track the themed intro will be spoken over: the next one to start. */
  function introTarget() {
    const queue = getQueue();
    // Idle (e.g. themed mode on an empty queue): the track about to start.
    if (!currentTrack || isSwitching()) return queue?.getCurrent?.() ?? null;
    return queue?.peekNext?.() ?? null;
  }

  /**
   * Prepare the intro for the next track to start, straight away rather than in
   * the last 30 s of the current track (FR-028).
   */
  function prepareIntro(theme) {
    // An intro is already waiting on the track that just started.
    if (awaiting) return;
    const target = introTarget();
    if (!target) return;
    if (prepared?.intro && keyMatches(prepared.forKey, target)) return;
    if (inflight && !inflight.cancelled) {
      if (inflight.intro && keyMatches(inflight.forKey, target)) return;
      cancelInflight();
    }
    startJob(target, { intro: theme, previous: currentTrack });
  }

  function prepare() {
    const theme = pendingIntro();
    if (theme) return prepareIntro(theme);
    if (inflight) {
      pendingPrepare = true;
      return;
    }
    if (!prepWindowOpen || !currentTrack || isSwitching()) return;

    const queue = getQueue();
    const next = queue?.peekNext?.() ?? null;
    if (!next || !nextIsDue()) return;
    if (keyMatches(prepared?.forKey, next) || keyMatches(attemptedKey, next)) return;
    startJob(next, { intro: null, previous: currentTrack });
  }

  /**
   * Write one line for `next`. `intro` is the theme when this is the themed
   * intro, else null.
   * @returns {boolean} whether a job started
   */
  function startJob(next, { intro, previous }) {
    const key = trackKey(next);
    // Last gate: an open breaker refuses, and a half-open one lets this through.
    if (silenceReason({ forPreparation: true }) || !canAttempt()) {
      scheduleRetry();
      return false;
    }
    clearRetry();

    prepared = null;
    if (!intro) attemptedKey = key;
    const job = { forKey: key, cancelled: false, intro: Boolean(intro) };
    inflight = job;
    const startedAt = Date.now();
    const ctx = buildContext({
      previous,
      next,
      theme: intro ?? getTheme() ?? null,
      intro: Boolean(intro),
      present: getConnectedUsers() ?? [],
      recentLines: spoken,
      store
    });

    Promise.resolve()
      .then(() => writeLine(ctx, [...spoken]))
      .then(
        (line) => {
          onLineSuccess();
          const ms = Date.now() - startedAt;
          if (job.cancelled) return drop('stale', key);
          if (job.intro) line = { ...line, intro: true };
          logger.info(`[DJ] Line prepared key=${key} chars=${line.text.length} ms=${ms}`);
          if (awaiting && keyMatches(key, awaiting.track)) {
            const spokenKey = awaiting.key;
            clearAwaiting();
            speak(line, spokenKey);
            // The ordinary line for this track was held back behind the intro.
            if (line.intro) pendingPrepare = true;
          } else {
            prepared = line;
          }
        },
        (error) => {
          const kind = error?.kind ?? 'llm';
          onLineFailure(kind, error);
          const reason = kind === 'validation' ? 'validation' : 'service';
          if (awaiting && keyMatches(key, awaiting.track)) clearAwaiting();
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
    return true;
  }

  function schedulePreparation(track) {
    if (prepTimer) clearTimeout(prepTimer);
    prepTimer = null;
    clearRetry();
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
      clearRetry();
      prepWindowOpen = false;
      return;
    }

    const isTransition = currentTrack !== null;
    currentTrack = track;
    const key = trackKey(track);
    const line = prepared;
    prepared = null;
    if (isTransition) transitionsSinceSpoken++;

    if (pendingIntro()) {
      // FR-006 exception: the intro is due at the next start, transition or not.
      speakIntroAt(track, key, line);
    } else if (isTransition) {
      if (transitionsSinceSpoken >= settings().interval) {
        const reason = silenceReason({ forPreparation: false });
        if (reason) {
          drop(reason, key);
        } else {
          daily.due++;
          if (line && keyMatches(line.forKey, track)) {
            speak(line, key);
          } else if (inflight && !inflight.cancelled && keyMatches(inflight.forKey, track)) {
            // Never wait on the track: it is already playing. Speak if the line
            // lands within the FR-003 window, otherwise drop it.
            awaiting = {
              key,
              track,
              timer: setTimeout(() => {
                awaiting = null;
                if (inflight && keyMatches(inflight.forKey, track)) inflight.cancelled = true;
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
    if (inflight && !inflight.cancelled && !keyMatches(inflight.forKey, track)) cancelInflight();
    schedulePreparation(track);
    // An intro still pending (missed the last start) targets the next track now.
    if (pendingIntro()) prepare();
  }

  /**
   * Speak the themed intro over `track` if it is ready or lands within the
   * FR-003 window. A missed intro stays pending for the next track to start.
   */
  function speakIntroAt(track, key, line) {
    if (line?.intro && keyMatches(line.forKey, track)) {
      speak(line, key);
      return;
    }
    if (inflight && !inflight.cancelled && inflight.intro && keyMatches(inflight.forKey, track)) {
      awaiting = {
        key,
        track,
        timer: setTimeout(() => {
          awaiting = null;
          if (inflight && keyMatches(inflight.forKey, track)) inflight.cancelled = true;
          drop('late', key, ' (intro)');
          prepare();
        }, SPEAK_GRACE_MS)
      };
      awaiting.timer.unref?.();
      return;
    }
    drop('late', key, ' (intro)');
  }

  /** Mediator `queue:update`: re-prepare when the predicted next track changed. */
  function onQueueUpdate() {
    // A pending intro follows whatever track will start next, even while idle.
    const theme = pendingIntro();
    if (theme) return prepareIntro(theme);
    // Mid-switch the track about to start is not peekNext(); trackStart settles
    // whether the prepared line still fits.
    if (!currentTrack || isSwitching()) return;
    const next = getQueue()?.peekNext?.() ?? null;
    if (prepared && !keyMatches(prepared.forKey, next)) {
      drop('stale', prepared.forKey, ' (queue changed)');
      prepared = null;
    }
    if (inflight && !inflight.cancelled && !keyMatches(inflight.forKey, next) && !awaiting) {
      cancelInflight();
    }
    if (prepWindowOpen && !prepared && !keyMatches(attemptedKey, next)) prepare();
  }

  /**
   * Discard the prepared line if it names a member who left or opted out
   * (FR-017, FR-020). The speak-time re-check is the guarantee; this only makes
   * the discard happen sooner, so a fresh line can be prepared.
   * @returns {boolean} whether a line was discarded
   */
  function discardIfNaming(isGone) {
    if (!prepared?.namedUserIds?.some(isGone)) return false;
    drop('stale-member', prepared.forKey);
    prepared = null;
    attemptedKey = null;
    if (prepWindowOpen) prepare();
    return true;
  }

  /** Mediator `voice:context`: someone joined or left the bot's channel. */
  function onVoiceContext(ctx) {
    const present = new Set((ctx?.connectedUsers ?? []).map((u) => u.id));
    discardIfNaming((id) => !present.has(id));
  }

  /** A member opted out of shout-outs: drop a prepared line naming them. */
  function onOptOut(userId) {
    discardIfNaming((id) => id === userId);
  }

  /** A theme started or changed: prepare its intro now (FR-028). */
  function onIntroPending() {
    prepare();
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
    clearRetry();
    if (prepTimer) clearTimeout(prepTimer);
    prepTimer = null;
    cancelInflight();
    prepared = null;
  }

  return {
    onTrackChange,
    onQueueUpdate,
    onVoiceContext,
    onOptOut,
    onIntroPending,
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
