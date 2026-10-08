/**
 * Themed DJ mode: builds the queue from a theme and keeps it topped up
 * (research R8, contracts §5b).
 *
 * One session at a time. Each top-up asks the LLM for `needed + 4` picks, mixing
 * history candidates with new songs, resolves new picks through the same
 * scored YouTube search member requests use, and adds every pick through the
 * musicManager mediator as soon as it is playable. Picks are tagged as the DJ's
 * (FR-027) and counted against the daily themed-track cap.
 *
 * Every dependency is injected so the engine can be tested with fakes and
 * never imports transports/ (Constitution II).
 */
import { chatJson as defaultChatJson } from '../../integrations/llm.js';
import { resolveSpotifyTrack } from '../../services/resolver.js';
import { logger as defaultLogger } from '../../utils/logger.js';
import {
  DjError,
  NO_TRACKS_FOR_THEME,
  SERVICE_UNAVAILABLE,
  CAP_REACHED,
  NOT_IN_VOICE
} from './errors.js';

export const DJ_REQUESTER = 'SquareMusica DJ';

const EXTRA_PICKS = 4;
const MAX_CANDIDATES = 60;
const MAX_AVOID = 100;
const DEBOUNCE_MS = 1000;
const STALL_RETRY_MS = 60 * 1000;
const LLM_TEMPERATURE = 0.7;
const LLM_TIMEOUT_MS = 20000;

export const NO_LISTENERS = 'NO_LISTENERS';
export const THEME_EXHAUSTED = 'THEME_EXHAUSTED';

export const SYSTEM_PROMPT = [
  'You are the SquareMusica radio DJ picking songs for a themed set.',
  'Pick exactly `count` real, well-known songs that fit `theme`.',
  'When enough of `candidates` (songs this server has played) fit the theme, take about half of the picks from them;',
  'when none fit, pick only new songs.',
  'Never pick a song listed in `avoid` unless `allowRepeats` is true.',
  'Return JSON {"picks": [{"candidateId": string} | {"artist": string, "title": string}]}.'
].join(' ');

/** Lowercase, punctuation-free form for comparing artist and title strings. */
export function normalize(text) {
  return String(text ?? '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

/** The normalised `artist - title` key, or null when either part is unknown. */
export function songKey(artist, title) {
  const a = normalize(artist);
  const t = normalize(title);
  return a && t ? `${a} - ${t}` : null;
}

/**
 * The FR-025 keys of a queue entry: its URL, plus `artist - title` when the
 * artist is known.
 * @param {Object} track
 * @returns {string[]}
 */
export function trackKeys(track) {
  if (!track) return [];
  const keys = [];
  if (track.url) keys.push(track.url);
  const artist = track.artist ?? track.spotifyData?.artists?.[0] ?? track.channel ?? null;
  const key = songKey(artist, track.title);
  if (key) keys.push(key);
  return keys;
}

/**
 * @param {Object} deps
 * @param {() => Object|null} deps.getQueue - the Queue (countUpcoming)
 * @param {(track: Object) => void} deps.addToQueue - musicManager.addToQueue
 * @param {() => number} deps.getLookahead
 * @param {() => Object|null} deps.getVoiceContext
 * @param {() => boolean} deps.isConnected - bot is in a voice channel
 * @param {Object} deps.history - db: getTopTracks, getShoutoutOptOuts?
 * @param {() => boolean} [deps.isBreakerOpen]
 * @param {() => boolean} [deps.canAttempt]
 * @param {() => void} [deps.recordSuccess]
 * @param {(kind: string, cause?: unknown) => void} [deps.recordFailure]
 * @param {() => boolean} [deps.isCapReached] - themed-track cap
 * @param {() => void} [deps.recordUsage] - one themed track added
 * @param {() => void} [deps.onChange] - status or reason changed
 * @param {() => void} [deps.onPicksAdded] - start playback if idle
 * @param {Function} [deps.chatJson]
 * @param {Function} [deps.resolveTrack]
 * @param {Object} [deps.logger]
 */
export function createThemeEngine(deps) {
  const {
    getQueue,
    addToQueue,
    getLookahead,
    getVoiceContext,
    isConnected,
    history,
    isBreakerOpen = () => false,
    canAttempt = () => true,
    recordSuccess = () => {},
    recordFailure = () => {},
    isCapReached = () => false,
    recordUsage = () => {},
    onChange = () => {},
    onPicksAdded = () => {},
    chatJson = defaultChatJson,
    resolveTrack = resolveSpotifyTrack,
    logger = defaultLogger
  } = deps;

  let session = null;
  let nextId = 0;
  let inFlight = null; // id of the session whose top-up is running
  let pending = false;
  let timer = null;
  let retryTimer = null;

  // -------------------------------------------------------------------------
  // Session state
  // -------------------------------------------------------------------------

  function setStatus(status, reason = null) {
    if (!session) return;
    if (session.status === status && session.reason === reason) return;
    session.status = status;
    session.reason = reason;
    logger.info(`[DJ] Themed mode ${status}${reason ? ` (${reason})` : ''}`);
    clearRetry();
    // Events (track changes, joins, the breaker closing) usually clear a
    // stall; this retry covers a queue that has run dry and sends none.
    if (status === 'stalled') {
      retryTimer = setTimeout(() => {
        retryTimer = null;
        schedule();
      }, STALL_RETRY_MS);
      retryTimer.unref?.();
    }
    onChange();
  }

  function clearRetry() {
    if (retryTimer) {
      clearTimeout(retryTimer);
      retryTimer = null;
    }
  }

  function useKeys(keys) {
    for (const key of keys) session.usedKeys.add(key);
  }

  function rememberTrack(track) {
    if (!session || !track) return;
    useKeys(trackKeys(track));
    const artist = track.artist ?? track.spotifyData?.artists?.[0] ?? track.channel ?? null;
    if (track.title) {
      session.avoid.push(artist ? `${artist} - ${track.title}` : track.title);
      if (session.avoid.length > MAX_AVOID) session.avoid.shift();
    }
  }

  /** The reason a top-up cannot run now, or null. */
  function blockedReason({ starting }) {
    if (!isConnected()) return NOT_IN_VOICE;
    // A member who starts a theme is asking for it now; listeners matter for
    // keeping it going, not for starting it.
    if (!starting && (getVoiceContext()?.connectedUsers ?? []).length === 0) return NO_LISTENERS;
    if (isCapReached()) return CAP_REACHED;
    if (isBreakerOpen()) return SERVICE_UNAVAILABLE;
    return null;
  }

  // -------------------------------------------------------------------------
  // Picking
  // -------------------------------------------------------------------------

  /** Up to 60 history candidates, present opted-in members' tracks first. */
  function buildCandidates({ allowRepeats }) {
    const optOuts = new Set(history.getShoutoutOptOuts?.() ?? []);
    const present = (getVoiceContext()?.connectedUsers ?? [])
      .map((u) => u.id)
      .filter((id) => id && !optOuts.has(id));
    const rows = [
      ...(present.length ? history.getTopTracks({ userIds: present, limit: MAX_CANDIDATES }) : []),
      ...history.getTopTracks({ limit: MAX_CANDIDATES })
    ];
    const seen = new Set();
    const candidates = [];
    for (const row of rows) {
      if (!row?.url || seen.has(row.url)) continue;
      seen.add(row.url);
      if (!allowRepeats && trackKeys(row).some((k) => session.usedKeys.has(k))) continue;
      candidates.push({ ...row, id: `c${candidates.length + 1}` });
      if (candidates.length >= MAX_CANDIDATES) break;
    }
    return candidates;
  }

  /**
   * Turn the model's answer into pick plans. Unknown candidate ids are
   * ignored; used songs are dropped unless allowRepeats.
   * @returns {{ plans: Array, deduped: number }}
   */
  function planPicks(answer, candidates, { allowRepeats }) {
    const byId = new Map(candidates.map((c) => [c.id, c]));
    const picks = Array.isArray(answer?.picks) ? answer.picks : [];
    const batchKeys = new Set();
    const plans = [];
    let deduped = 0;

    for (const pick of picks) {
      let plan = null;
      if (pick && typeof pick.candidateId === 'string') {
        const c = byId.get(pick.candidateId);
        if (!c) continue;
        plan = { kind: 'history', candidate: c, keys: trackKeys(c) };
      } else if (
        pick &&
        typeof pick.title === 'string' &&
        pick.title.trim() &&
        typeof pick.artist === 'string' &&
        pick.artist.trim()
      ) {
        const key = songKey(pick.artist, pick.title);
        plan = { kind: 'new', artist: pick.artist.trim(), title: pick.title.trim(), keys: [key] };
      } else {
        continue;
      }
      if (plan.keys.some((k) => batchKeys.has(k))) continue;
      if (!allowRepeats && plan.keys.some((k) => session.usedKeys.has(k))) {
        deduped++;
        continue;
      }
      plan.keys.forEach((k) => batchKeys.add(k));
      plans.push(plan);
    }
    return { plans, deduped };
  }

  async function askModel(theme, count, candidates, allowRepeats) {
    return chatJson({
      system: SYSTEM_PROMPT,
      user: {
        theme,
        count,
        allowRepeats,
        candidates: candidates.map(({ id, title, artist }) => ({ id, title, artist })),
        avoid: session.avoid.slice(-MAX_AVOID)
      },
      temperature: LLM_TEMPERATURE,
      timeoutMs: LLM_TIMEOUT_MS
    });
  }

  function djTrack(fields) {
    return { ...fields, addedByDj: true, requestedBy: DJ_REQUESTER, requestedById: null };
  }

  /**
   * One top-up for the session `mine`. Adds picks as they resolve; resolves
   * `onFirst` when the first lands.
   * @returns {Promise<{ added: number, error: string|null }>}
   */
  async function runTopUp(mine, { starting = false, onFirst = () => {} } = {}) {
    const live = () =>
      session !== null && session.id === mine.id && session.version === mine.version;

    const reason = blockedReason({ starting });
    if (reason) {
      if (!starting) setStatus('stalled', reason);
      return { added: 0, error: reason };
    }

    const queue = getQueue();
    const needed = getLookahead() - (queue?.countUpcoming((t) => t.addedByDj) ?? 0);
    if (needed <= 0) {
      setStatus('running');
      return { added: 0, error: null };
    }
    if (!canAttempt()) {
      if (!starting) setStatus('stalled', SERVICE_UNAVAILABLE);
      return { added: 0, error: SERVICE_UNAVAILABLE };
    }

    let plans = [];
    let repeatsAllowed = false;
    for (const allowRepeats of [false, true]) {
      repeatsAllowed = allowRepeats;
      const candidates = buildCandidates({ allowRepeats });
      let answer;
      try {
        answer = await askModel(mine.theme, needed + EXTRA_PICKS, candidates, allowRepeats);
      } catch (error) {
        recordFailure('llm', error);
        if (live() && !starting) setStatus('stalled', SERVICE_UNAVAILABLE);
        return { added: 0, error: SERVICE_UNAVAILABLE };
      }
      recordSuccess();
      if (!live()) return { added: 0, error: null };
      const planned = planPicks(answer, candidates, { allowRepeats });
      plans = planned.plans;
      // FR-025 fallback: only when de-duplication emptied the batch.
      if (plans.length > 0 || planned.deduped === 0) break;
      logger.info('[DJ] Themed batch emptied by de-duplication; retrying with repeats allowed');
    }

    let added = 0;
    let capHit = false;
    const add = (track, keys) => {
      if (!live() || added >= needed || capHit) return false;
      if (isCapReached()) {
        capHit = true;
        return false;
      }
      useKeys(keys);
      addToQueue(track);
      added++;
      recordUsage();
      if (added === 1) onFirst();
      onPicksAdded();
      return true;
    };

    // History picks are already playable; add them straight away.
    for (const plan of plans.filter((p) => p.kind === 'history')) {
      const { url, title, artist, duration, thumbnail } = plan.candidate;
      add(djTrack({ url, title, artist, channel: artist, duration, thumbnail }), plan.keys);
    }

    // New picks are resolved first, so an unplayable one never enters the
    // queue (FR-026). Each is added as soon as it resolves (SC-005).
    const newPlans = plans.filter((p) => p.kind === 'new');
    let resolvedAny = false;
    await Promise.all(
      newPlans.map(async (plan) => {
        let resolved = null;
        try {
          resolved = await resolveTrack({ title: plan.title, artists: [plan.artist] });
        } catch (error) {
          logger.warn(`[DJ] Resolving themed pick failed: ${error?.message ?? error}`);
        }
        if (!resolved?.url) return;
        resolvedAny = true;
        // Two picks can resolve to one video, or to one already played.
        if (!repeatsAllowed && session?.usedKeys.has(resolved.url)) return;
        add(
          djTrack({
            url: resolved.url,
            title: resolved.title ?? plan.title,
            artist: plan.artist,
            channel: resolved.channel ?? plan.artist,
            duration: resolved.duration,
            thumbnail: resolved.thumbnail ?? null
          }),
          [...plan.keys, resolved.url]
        );
      })
    );
    if (newPlans.length > 0 && !resolvedAny) recordFailure('resolve', 'no themed pick resolved');

    if (!live()) return { added, error: null };
    if (capHit) {
      if (!starting) setStatus('stalled', CAP_REACHED);
      return { added, error: added ? null : CAP_REACHED };
    }
    if (added === 0) {
      if (!starting) setStatus('stalled', THEME_EXHAUSTED);
      return { added, error: THEME_EXHAUSTED };
    }
    logger.info(`[DJ] Themed top-up added ${added} of ${needed} needed`);
    setStatus('running');
    // Some picks failed to resolve: go again for the rest (FR-026).
    if (added < needed) pending = true;
    return { added, error: null };
  }

  /** Run a top-up now unless one is in flight; queue another if asked meanwhile. */
  function topUp(opts) {
    if (!session) return Promise.resolve({ added: 0, error: null });
    // One top-up in flight per session. A dead session's top-up still
    // running does not block a new session; its picks are dropped (FR-024b).
    if (inFlight === session.id) {
      pending = true;
      return Promise.resolve({ added: 0, error: null });
    }
    inFlight = session.id;
    const mine = { id: session.id, version: session.version, theme: session.theme };
    return runTopUp(mine, opts)
      .catch((error) => {
        logger.warn(`[DJ] Themed top-up failed: ${error?.message ?? error}`);
        return { added: 0, error: SERVICE_UNAVAILABLE };
      })
      .finally(() => {
        if (inFlight === mine.id) inFlight = null;
        if (pending && session) {
          pending = false;
          schedule();
        }
      });
  }

  /** Debounced trigger: one top-up 1 s after the last event. */
  function schedule() {
    if (!session) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      topUp();
    }, DEBOUNCE_MS);
    timer.unref?.();
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  /**
   * Start a session and run its first top-up. Resolves as soon as the first
   * pick is in the queue; the rest of the batch keeps resolving (SC-005).
   * @param {{ theme: string, startedBy: Object, origin: Object }} params
   * @returns {Promise<void>}
   * @throws {DjError} NO_TRACKS_FOR_THEME, SERVICE_UNAVAILABLE, CAP_REACHED or
   *   NOT_IN_VOICE; the session is then discarded.
   */
  function start({ theme, startedBy, origin }) {
    stop();
    session = {
      id: ++nextId,
      version: 0,
      theme,
      startedBy,
      startedAt: new Date().toISOString(),
      origin,
      usedKeys: new Set(),
      avoid: [],
      status: 'running',
      reason: null,
      introPending: true
    };
    const id = session.id;
    // Whatever is queued already counts as played for this session (FR-025).
    for (const t of getQueue()?.getAll?.() ?? []) rememberTrack(t);

    return new Promise((resolve, reject) => {
      let settled = false;
      const onFirst = () => {
        if (!settled) {
          settled = true;
          resolve();
        }
      };
      topUp({ starting: true, onFirst }).then(({ added, error }) => {
        if (settled) return;
        settled = true;
        if (added > 0) return resolve();
        if (session?.id === id) session = null;
        const code = [SERVICE_UNAVAILABLE, CAP_REACHED, NOT_IN_VOICE].includes(error)
          ? error
          : NO_TRACKS_FOR_THEME;
        reject(new DjError(code));
      });
    });
  }

  /** Change the running session's theme. Used keys are kept (US4/AC7). */
  function changeTheme(theme) {
    if (!session) return;
    session.theme = theme;
    session.version++;
    session.introPending = true;
    schedule();
  }

  /** End the session. In-flight picks are dropped when they resolve (FR-024b). */
  function stop() {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    clearRetry();
    pending = false;
    session = null;
  }

  /** Mediator `queue:update`: remember member tracks, top up if needed. */
  function onQueueUpdate(payload) {
    if (!session) return;
    for (const t of payload?.tracks ?? []) if (!t.addedByDj) useKeys(trackKeys(t));
    schedule();
  }

  /** Mediator `track:change`: a played track is never picked again (FR-025). */
  function onTrackChange(track) {
    if (!session) return;
    rememberTrack(track);
    schedule();
  }

  /**
   * Re-check conditions (listeners joined or left, bot left voice, breaker
   * closed, cap reset). A new block is reported at once; a top-up follows.
   */
  function poke() {
    if (!session) return;
    const reason = blockedReason({ starting: false });
    if (reason) setStatus('stalled', reason);
    schedule();
  }

  /** ThemeState for dj:state (contracts §1), or null. */
  function getState() {
    if (!session) return null;
    const { theme, startedBy, startedAt, status, reason } = session;
    return { theme, startedBy: { ...startedBy }, startedAt, status, reason };
  }

  return {
    start,
    changeTheme,
    stop,
    onQueueUpdate,
    onTrackChange,
    poke,
    getState,
    topUp,
    shutdown: stop,
    get session() {
      return session;
    }
  };
}
