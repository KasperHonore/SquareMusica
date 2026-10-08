/**
 * Themed mode: keeps the queue topped up with theme-fitting DJ picks
 * (research R8, FR-021–FR-029).
 *
 * Owns the one Themed Session (data-model.md). Driven by the mediator's
 * `track:change` and `queue:update`, debounced 1 s with one top-up in flight.
 * Everything external is injected, which keeps this module free of transports
 * and testable with fake timers. MUST NOT import src/transports/.
 */
import { logger } from '../../utils/logger.js';

export const DJ_REQUESTER = 'SquareMusica DJ';

const DEBOUNCE_MS = 1000;
const STALL_RECHECK_MS = 30 * 1000;
const EXTRA_PICKS = 4;
const MAX_CANDIDATES = 60;
const MAX_AVOID = 200;
const LLM_TEMPERATURE = 0.7;
const LLM_TIMEOUT_MS = 20000;

export const PICKS_SYSTEM_PROMPT = [
  'You are the SquareMusica radio DJ, building a themed set.',
  'Pick exactly `count` real, well-known songs that fit `theme`.',
  'When enough of the history `candidates` fit the theme, take about half of the picks from them',
  '(as {"candidateId": "<id>"}) and the rest as new songs not in the candidates;',
  'when none of the candidates fit, pick only new songs.',
  'Never pick a song listed in `avoid` unless `allowRepeats` is true.',
  'Return JSON {"picks": [{"candidateId": string} | {"artist": string, "title": string}]}.'
].join(' ');

function normalise(text) {
  return String(text).toLowerCase().replace(/\s+/g, ' ').trim();
}

/** Normalised "artist - title", or null when the artist is unknown. */
export function artistTitleKey(artist, title) {
  if (!artist || !title) return null;
  return normalise(`${artist} - ${title}`);
}

function trackArtist(track) {
  return track?.spotifyData?.artists?.[0] ?? track?.artist ?? null;
}

/** Every dedupe key of a queue entry: its URL, plus artist - title when known. */
export function keysOfTrack(track) {
  if (!track) return [];
  const keys = [];
  if (track.url) keys.push(track.url);
  const at = artistTitleKey(trackArtist(track), track.title);
  if (at) keys.push(at);
  return keys;
}

function djTag(track) {
  return {
    ...track,
    addedByDj: true,
    requestedBy: DJ_REQUESTER,
    requestedById: null,
    requestedByAvatar: null
  };
}

/**
 * @param {Object} deps
 * @param {() => Object|null} deps.getQueue - Queue with countUpcoming() and getAll()
 * @param {(track: Object) => void} deps.addToQueue - musicManager.addToQueue
 * @param {() => number} deps.getLookahead
 * @param {(req: Object) => Promise<Object>} deps.chatJson
 * @param {(t: { title: string, artists: string[] }) => Promise<Object|null>} deps.resolveTrack
 * @param {(p: { userIds?: string[], limit: number }) => Object[]} deps.getTopTracks
 * @param {() => string[]} deps.getPresentMemberIds - Present, opted-in, human members
 * @param {() => boolean} deps.isConnected - Bot is in voice
 * @param {() => boolean} deps.hasListeners - A human is in the bot's channel
 * @param {() => boolean} deps.isCapReached - Themed-track cap reached
 * @param {() => boolean} deps.canAttempt - Breaker gate (half-open aware)
 * @param {() => void} deps.recordSuccess
 * @param {(kind: string, cause?: unknown) => void} deps.recordFailure
 * @param {() => void} deps.recordUsage - One themed track added
 * @param {() => void} [deps.ensurePlaying] - Start playback if the player is idle
 * @param {(session: Object) => void} [deps.onStatusChange]
 */
export function createThemeEngine(deps) {
  let session = null;
  let nextSessionId = 1;

  let debounceTimer = null;
  let stallTimer = null;
  let inFlight = null;
  let rerun = false;

  function rememberKeys(keys) {
    if (!session) return;
    for (const key of keys) session.usedKeys.add(key);
  }

  function rememberTrack(track) {
    if (!session || !track) return;
    rememberKeys(keysOfTrack(track));
    const label = artistTitleKey(trackArtist(track), track.title) ?? normalise(track.title ?? '');
    if (label) rememberAvoid(label);
  }

  function rememberAvoid(label) {
    if (session.avoid.includes(label)) return;
    session.avoid.push(label);
    if (session.avoid.length > MAX_AVOID) session.avoid.shift();
  }

  function clearStallTimer() {
    clearTimeout(stallTimer);
    stallTimer = null;
  }

  function setStatus(status, reason = null) {
    if (!session) return;
    // Conditions that clear on their own (presence, voice, cap, breaker) are
    // re-checked on a timer as well as on every track change. An exhausted
    // theme is retried on track changes only, so it never polls the LLM.
    if (status === 'stalled' && reason !== 'THEME_EXHAUSTED') {
      clearStallTimer();
      stallTimer = setTimeout(() => {
        stallTimer = null;
        trigger();
      }, STALL_RECHECK_MS);
      stallTimer.unref?.();
    } else {
      clearStallTimer();
    }
    if (session.status === status && session.reason === reason) return;
    session.status = status;
    session.reason = reason;
    logger.info(`[DJ] Themed mode ${status}${reason ? ` (${reason})` : ''}`, {
      theme: session.theme
    });
    // Not announced until start() succeeds: a failed start reports its error
    // to the member instead (FR-029).
    if (session.started) deps.onStatusChange?.(session);
  }

  /** The first condition blocking a top-up, or null. Never claims the breaker. */
  function blockedReason({ requireListeners = true } = {}) {
    if (!deps.isConnected()) return 'NOT_IN_VOICE';
    if (requireListeners && !deps.hasListeners()) return 'NO_LISTENERS';
    if (deps.isCapReached()) return 'CAP_REACHED';
    return null;
  }

  function needed() {
    const queue = deps.getQueue();
    if (!queue) return 0;
    const upcoming = queue.countUpcoming((t) => t.addedByDj === true);
    return Math.max(0, deps.getLookahead() - upcoming);
  }

  function buildCandidates(allowRepeats) {
    const presentIds = deps.getPresentMemberIds();
    const rows = [
      ...(presentIds.length > 0
        ? deps.getTopTracks({ userIds: presentIds, limit: MAX_CANDIDATES })
        : []),
      ...deps.getTopTracks({ limit: MAX_CANDIDATES })
    ];
    const seen = new Set();
    const candidates = [];
    for (const row of rows) {
      if (!row?.url || seen.has(row.url)) continue;
      seen.add(row.url);
      const artist = row.artist ?? null;
      const keys = [row.url, artistTitleKey(artist, row.title)].filter(Boolean);
      if (!allowRepeats && keys.some((k) => session.usedKeys.has(k))) continue;
      candidates.push({ id: `c${candidates.length + 1}`, row, artist, keys });
      if (candidates.length >= MAX_CANDIDATES) break;
    }
    return candidates;
  }

  /**
   * One LLM request and its picks, added one by one as each resolves. Picks
   * that resolve after the session changed are dropped uncounted (FR-024b).
   */
  async function runBatch({ sessionId, count, allowRepeats, onAdded }) {
    const live = () => session?.id === sessionId;
    const candidates = buildCandidates(allowRepeats);
    const byId = new Map(candidates.map((c) => [c.id, c]));

    const response = await deps.chatJson({
      system: PICKS_SYSTEM_PROMPT,
      user: {
        theme: session.theme,
        count: count + EXTRA_PICKS,
        allowRepeats,
        candidates: candidates.map((c) => ({ id: c.id, title: c.row.title, artist: c.artist })),
        avoid: allowRepeats ? [] : session.avoid.slice()
      },
      temperature: LLM_TEMPERATURE,
      timeoutMs: LLM_TIMEOUT_MS
    });
    deps.recordSuccess();

    const picks = Array.isArray(response?.picks) ? response.picks : [];
    const result = { added: 0, deduped: 0, resolveAttempts: 0, resolveFailures: 0 };
    const isUsed = (keys) => !allowRepeats && live() && keys.some((k) => session.usedKeys.has(k));

    for (const pick of picks) {
      // Re-checked per pick: on an empty queue the first pick becomes the
      // current track and does not count as upcoming.
      if (!live() || needed() === 0) break;
      if (deps.isCapReached()) break;

      let track;
      if (pick && typeof pick.candidateId === 'string') {
        const candidate = byId.get(pick.candidateId);
        if (!candidate) continue;
        if (isUsed(candidate.keys)) {
          result.deduped++;
          continue;
        }
        byId.delete(pick.candidateId);
        const { row } = candidate;
        track = {
          title: row.title,
          url: row.url,
          duration: row.duration ?? 0,
          thumbnail: row.thumbnail ?? null,
          channel: null,
          artist: candidate.artist
        };
      } else if (pick && typeof pick.title === 'string' && typeof pick.artist === 'string') {
        const key = artistTitleKey(pick.artist, pick.title);
        if (!key || isUsed([key])) {
          if (key) result.deduped++;
          continue;
        }
        result.resolveAttempts++;
        let resolved = null;
        try {
          resolved = await deps.resolveTrack({ title: pick.title, artists: [pick.artist] });
        } catch (error) {
          logger.info('[DJ] Themed pick failed to resolve', { detail: error?.message });
        }
        if (!live()) break;
        if (!resolved?.url) {
          result.resolveFailures++;
          continue;
        }
        if (isUsed([resolved.url])) {
          result.deduped++;
          continue;
        }
        // Mark the pick's own artist - title as used even if it never plays.
        rememberKeys([key]);
        rememberAvoid(key);
        track = { ...resolved, artist: pick.artist };
      } else {
        continue;
      }

      if (!live()) break;
      rememberTrack(track);
      deps.addToQueue(djTag(track));
      deps.recordUsage();
      result.added++;
      onAdded?.();
    }
    return result;
  }

  /**
   * Fill the queue up to the lookahead. Returns a handle whose `firstAdded`
   * settles when the first pick is in the queue and `done` when the batch ends.
   */
  function topUp({ initial = false } = {}) {
    let signalFirst;
    const firstAdded = new Promise((resolve) => {
      signalFirst = resolve;
    });

    const done = (async () => {
      if (!session) return { added: 0 };
      const sessionId = session.id;

      const blocked = blockedReason({ requireListeners: !initial });
      if (blocked) {
        setStatus('stalled', blocked);
        return { added: 0, blocked };
      }
      const count = needed();
      if (count === 0) {
        // Already enough DJ picks upcoming, e.g. kept from an earlier session.
        setStatus('running');
        return { added: 0, satisfied: true };
      }
      if (!deps.canAttempt()) {
        setStatus('stalled', 'SERVICE_UNAVAILABLE');
        return { added: 0, blocked: 'SERVICE_UNAVAILABLE' };
      }

      let total = 0;
      const onAdded = () => {
        total++;
        // A refill after the queue ran dry (e.g. resuming from a stall) must
        // restart the player; the first top-up leaves that to the caller.
        if (total === 1 && !initial) deps.ensurePlaying?.();
        signalFirst();
      };

      try {
        let result = await runBatch({ sessionId, count, allowRepeats: false, onAdded });
        // FR-025 fallback: dedupe emptied the batch, so allow repeats once.
        if (result.added === 0 && result.deduped > 0 && session?.id === sessionId) {
          result = await runBatch({ sessionId, count, allowRepeats: true, onAdded });
        }
        if (session?.id !== sessionId) return { added: total };

        if (total > 0) {
          setStatus('running');
        } else if (deps.isCapReached()) {
          setStatus('stalled', 'CAP_REACHED');
        } else {
          if (result.resolveAttempts > 0 && result.resolveFailures === result.resolveAttempts) {
            deps.recordFailure('resolve', new Error('no themed pick could be resolved'));
          }
          setStatus('stalled', 'THEME_EXHAUSTED');
        }
        return { added: total };
      } catch (error) {
        deps.recordFailure(error?.kind ?? 'llm', error);
        if (session?.id === sessionId) setStatus('stalled', 'SERVICE_UNAVAILABLE');
        return { added: total, error };
      }
    })();

    return { firstAdded, done };
  }

  function runNow() {
    if (!session) return;
    if (inFlight) {
      rerun = true;
      return;
    }
    track(topUp().done);
  }

  // One top-up in flight. A top-up left over from an ended session must not
  // clear the marker of the one that replaced it.
  function track(done) {
    const mine = done.finally(() => {
      if (inFlight !== mine) return;
      inFlight = null;
      if (rerun) {
        rerun = false;
        trigger();
      }
    });
    inFlight = mine;
  }

  /** Debounced top-up request. No-op without a session. */
  function trigger() {
    if (!session) return;
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      runNow();
    }, DEBOUNCE_MS);
    debounceTimer.unref?.();
  }

  function clearTimers() {
    clearTimeout(debounceTimer);
    debounceTimer = null;
    clearStallTimer();
  }

  /**
   * Start a session and run its first top-up. Resolves once the first pick is
   * in the queue (SC-005); the rest of the batch keeps resolving.
   * @returns {Promise<Object>} The session; no longer current if a stop or
   *   clear ended it before the first pick landed
   * @throws {{ code: 'NO_TRACKS_FOR_THEME' | 'SERVICE_UNAVAILABLE' | 'NOT_IN_VOICE' | 'CAP_REACHED' }}
   *   and no session remains
   */
  async function start({ theme, startedBy = null, origin = null }) {
    clearTimers();
    session = {
      id: nextSessionId++,
      theme,
      startedBy,
      startedAt: new Date().toISOString(),
      origin,
      usedKeys: new Set(),
      avoid: [],
      status: 'running',
      reason: null,
      introPending: true,
      started: false
    };
    const mine = session;
    const queue = deps.getQueue();
    for (const track of queue?.getAll?.() ?? []) rememberTrack(track);

    const run = topUp({ initial: true });
    track(run.done);
    const firstId = mine.id;
    const outcome = await Promise.race([run.firstAdded.then(() => ({ added: 1 })), run.done]);

    // A clear or stop ended the session mid-start (FR-024b): not a failure of
    // the theme. The caller sees getSession() !== the returned session.
    if (session !== mine) return mine;
    // A lookahead already met by queued DJ picks is a successful start. So is
    // a theme change that arrived mid-start: it dropped this batch and
    // scheduled a top-up for the new theme (US4/AC7).
    if (outcome.added > 0 || outcome.satisfied || mine.id !== firstId) {
      mine.started = true;
      return mine;
    }
    session = null;
    clearTimers();
    // NO_TRACKS_FOR_THEME only when the theme itself yielded nothing (FR-029).
    const code = outcome.error ? 'SERVICE_UNAVAILABLE' : (outcome.blocked ?? 'NO_TRACKS_FOR_THEME');
    throw Object.assign(new Error(code), { code });
  }

  /** Change the theme; usedKeys are kept and the intro is due again (US4/AC7). */
  function changeTheme(theme) {
    if (!session) return null;
    // A new id drops picks still resolving for the old theme (US4/AC7).
    session.id = nextSessionId++;
    session.theme = theme;
    session.introPending = true;
    session.status = 'running';
    session.reason = null;
    clearStallTimer();
    trigger();
    return session;
  }

  /** End the session. Picks still resolving are dropped (session id check). */
  function stop() {
    const had = session !== null;
    session = null;
    rerun = false;
    clearTimers();
    return had;
  }

  function onQueueUpdate(payload) {
    if (!session) return;
    for (const track of payload?.tracks ?? []) {
      if (!track?.addedByDj) rememberTrack(track);
    }
    trigger();
  }

  function onTrackChange(track) {
    if (!session) return;
    rememberTrack(track);
    trigger();
  }

  /** Presence or connection changed: re-evaluate a stall without waiting for a track. */
  function recheck() {
    if (!session) return;
    const blocked = blockedReason();
    if (blocked) {
      setStatus('stalled', blocked);
      return;
    }
    if (session.status === 'stalled') trigger();
  }

  return {
    start,
    changeTheme,
    stop,
    trigger,
    recheck,
    onQueueUpdate,
    onTrackChange,
    getSession: () => session,
    shutdown: () => {
      stop();
    },
    /** For tests: the promise of the top-up in flight, if any. */
    getInFlight: () => inFlight
  };
}
