import { trackKey } from './context.js';
import { logger } from '../../utils/logger.js';

// Themed DJ mode (research R8): keeps `lookahead` DJ picks queued behind any
// member requests, sourcing them from this server's history and from new songs
// the LLM suggests. Picks are added through the mediator one by one as they
// resolve. Nothing here imports src/transports/ (Constitution II); every
// dependency is injected by djService.

export const DJ_REQUESTER = 'SquareMusica DJ';
const MAX_THEME_CHARS = 200;
const EXTRA_PICKS = 4;
const MAX_CANDIDATES = 60;
const MEMBER_TOP_LIMIT = 20;
const SERVER_TOP_LIMIT = 60;
const MAX_AVOID = 100;
const MAX_ROUNDS = 3;
const RESOLVE_CONCURRENCY = 3;
const DEBOUNCE_MS = 1000;
// While stalled for a reason that clears without a queue or track event (the
// breaker closing, the cap resetting), check again this often.
const STALL_RETRY_MS = 30 * 1000;

export const PICKS_SYSTEM_PROMPT = [
  'You are the SquareMusica radio DJ choosing songs for a themed set.',
  'Every pick must fit the theme.',
  'A pick is either {"candidateId": id}, one of the provided history candidates, or',
  '{"artist": string, "title": string}, a real released song that is not a candidate.',
  'When enough candidates fit the theme, take about half of the picks from the',
  'candidates; when none fit, pick only new songs.',
  'Never pick a song listed in avoid unless allowRepeats is true. No duplicates.',
  'Return exactly `count` picks as JSON: {"picks": [...]}.'
].join(' ');

/** Lowercased `artist - title`, or null when the artist is unknown. */
export function songKey(artist, title) {
  if (!artist || !title) return null;
  return `${artist} - ${title}`.toLowerCase().replace(/\s+/g, ' ').trim();
}

function artistOf(track) {
  return track?.spotifyData?.artists?.[0] ?? track?.artist ?? null;
}

/** Every key that identifies `track` for FR-025 dedupe. */
function keysOf(track) {
  const keys = [];
  const key = trackKey(track);
  if (key) keys.push(key);
  if (track?.url && track.url !== key) keys.push(track.url);
  const song = songKey(artistOf(track), track?.title);
  if (song) keys.push(song);
  return keys;
}

/**
 * Trim and check a theme (FR-021).
 * @param {unknown} theme
 * @returns {string|null} the trimmed theme, or null when it is not 1–200 characters
 */
export function normaliseTheme(theme) {
  if (typeof theme !== 'string') return null;
  const trimmed = theme.trim();
  return trimmed.length >= 1 && trimmed.length <= MAX_THEME_CHARS ? trimmed : null;
}

/**
 * @param {Object} deps
 * @param {() => Object|null} deps.getQueue - Queue with countUpcoming()
 * @param {() => number} deps.getLookahead
 * @param {() => Array<{ id: string, bot?: boolean }>} deps.getConnectedUsers
 * @param {() => Set<string>} [deps.getOptOuts]
 * @param {() => boolean} deps.isConnected - bot is in a voice channel
 * @param {Object} deps.store - getTopTracks({ userIds?, limit })
 * @param {(params: Object) => Promise<Object>} deps.chatJson
 * @param {(track: Object) => Promise<Object|null>} deps.resolveTrack - resolveSpotifyTrack
 * @param {(track: Object) => void} deps.addToQueue - musicManager.addToQueue
 * @param {() => boolean} deps.canAttempt - breaker gate
 * @param {() => boolean} deps.isCapReached - themed-track cap
 * @param {() => void} [deps.onPickAdded] - usage + start playback if idle
 * @param {() => void} [deps.onSuccess]
 * @param {(kind: string, error: unknown) => void} [deps.onFailure]
 * @param {() => void} [deps.onChange] - status or reason changed
 */
export function createThemeEngine(deps) {
  const {
    getQueue,
    getLookahead,
    getConnectedUsers,
    getOptOuts = () => new Set(),
    isConnected,
    store,
    chatJson,
    resolveTrack,
    addToQueue,
    canAttempt,
    isCapReached,
    onPickAdded = () => {},
    onSuccess = () => {},
    onFailure = () => {},
    onChange = () => {}
  } = deps;

  let session = null;
  let seq = 0;
  let inflight = null; // Promise of the running top-up
  let pending = false; // a trigger arrived while a top-up was running
  let debounceTimer = null;
  let retryTimer = null;

  const hasListener = () => (getConnectedUsers() ?? []).some((u) => u && !u.bot);
  const alive = (id) => session !== null && session.id === id;

  function setStatus(status, reason = null) {
    if (!session) return;
    if (session.status === status && session.reason === reason) return;
    session.status = status;
    session.reason = reason;
    logger.info(`[DJ] Theme ${status}${reason ? ` (${reason})` : ''}`);
    if (status === 'stalled' && reason !== 'THEME_EXHAUSTED') scheduleRetry();
    else clearRetry();
    // A session that has not started yet is not in any state anyone has seen;
    // a failed start must leave the broadcast state unchanged.
    if (session.announced) onChange();
  }

  function clearRetry() {
    if (retryTimer) clearTimeout(retryTimer);
    retryTimer = null;
  }

  function scheduleRetry() {
    if (retryTimer) return;
    retryTimer = setTimeout(() => {
      retryTimer = null;
      trigger();
    }, STALL_RETRY_MS);
    retryTimer.unref?.();
  }

  /** Why a top-up can't run now, or null. NO_LISTENERS is waived on start. */
  function blockReason({ initial = false } = {}) {
    if (!isConnected()) return 'NOT_IN_VOICE';
    if (!initial && !hasListener()) return 'NO_LISTENERS';
    if (isCapReached()) return 'CAP_REACHED';
    return null;
  }

  function remember(track) {
    if (!session || !track) return;
    for (const key of keysOf(track)) session.usedKeys.add(key);
    const song = songKey(artistOf(track), track.title);
    if (song && !session.avoid.includes(song)) {
      session.avoid.push(song);
      if (session.avoid.length > MAX_AVOID) session.avoid.shift();
    }
  }

  /** ≤ 60 deduped history candidates: present opted-in members first, then the server. */
  function buildCandidates() {
    const optOuts = getOptOuts() ?? new Set();
    const userIds = (getConnectedUsers() ?? [])
      .filter((u) => u && !u.bot && u.id && !optOuts.has(u.id))
      .map((u) => u.id);
    const rows = [
      ...(userIds.length > 0 ? store.getTopTracks({ userIds, limit: MEMBER_TOP_LIMIT }) : []),
      ...store.getTopTracks({ limit: SERVER_TOP_LIMIT })
    ];
    const seen = new Set();
    const candidates = [];
    for (const row of rows) {
      if (!row?.url || seen.has(row.url)) continue;
      seen.add(row.url);
      candidates.push({ id: `c${candidates.length + 1}`, ...row, artist: row.artist ?? null });
      if (candidates.length >= MAX_CANDIDATES) break;
    }
    return candidates;
  }

  function isUsed(keys) {
    return keys.some((key) => key && session.usedKeys.has(key));
  }

  /**
   * Turn the model's picks into ordered work items, dropping unknown candidates,
   * malformed entries, duplicates within the batch and (unless allowRepeats)
   * anything already used this session (FR-025).
   */
  function filterPicks(picks, candidatesById, allowRepeats) {
    const out = [];
    const batch = new Set();
    for (const pick of Array.isArray(picks) ? picks : []) {
      if (!pick || typeof pick !== 'object') continue;
      let item;
      if (typeof pick.candidateId === 'string') {
        const candidate = candidatesById.get(pick.candidateId);
        if (!candidate) continue;
        item = { kind: 'history', candidate, keys: [candidate.url] };
        const song = songKey(candidate.artist, candidate.title);
        if (song) item.keys.push(song);
      } else if (typeof pick.artist === 'string' && typeof pick.title === 'string') {
        const artist = pick.artist.trim();
        const title = pick.title.trim();
        if (!artist || !title) continue;
        item = { kind: 'new', artist, title, keys: [songKey(artist, title)] };
      } else {
        continue;
      }
      if (item.keys.some((key) => batch.has(key))) continue;
      if (!allowRepeats && isUsed(item.keys)) continue;
      for (const key of item.keys) batch.add(key);
      out.push(item);
    }
    return out;
  }

  const djFields = { addedByDj: true, requestedBy: DJ_REQUESTER, requestedById: null };

  /** Resolve one work item to a playable queue entry, or null (FR-026). */
  async function toTrack(item) {
    if (item.kind === 'history') {
      const c = item.candidate;
      return {
        title: c.title,
        url: c.url,
        duration: c.duration ?? 0,
        thumbnail: c.thumbnail ?? null,
        channel: null,
        artist: c.artist ?? null,
        ...djFields
      };
    }
    let resolved;
    try {
      resolved = await resolveTrack({ title: item.title, artists: [item.artist] });
    } catch (error) {
      logger.warn(`[DJ] Theme pick lookup failed: ${error?.message ?? error}`);
      return null;
    }
    if (!resolved?.url) return null;
    return {
      title: item.title,
      url: resolved.url,
      duration: resolved.duration ?? 0,
      thumbnail: resolved.thumbnail ?? null,
      channel: resolved.channel ?? null,
      artist: item.artist,
      ...djFields
    };
  }

  /**
   * Resolve items a few at a time and add each one as soon as it is ready,
   * until `limit` are added. Picks that land after the session ended or the
   * theme changed are dropped uncounted (FR-024b).
   * @returns {Promise<{ added: number, newTried: number, newResolved: number, capped: boolean }>}
   */
  async function addPicks(items, limit, id, allowRepeats, onFirst) {
    const result = { added: 0, newTried: 0, newResolved: 0, capped: false };
    let next = 0;
    const worker = async () => {
      while (next < items.length) {
        if (!alive(id) || result.added >= limit || result.capped) return;
        const item = items[next++];
        if (item.kind === 'new') result.newTried++;
        const track = await toTrack(item);
        if (track && item.kind === 'new') result.newResolved++;
        if (!track || !alive(id) || result.added >= limit) continue;
        if (!allowRepeats && isUsed(keysOf(track))) continue;
        if (isCapReached()) {
          result.capped = true;
          return;
        }
        remember(track);
        addToQueue(track);
        result.added++;
        onPickAdded();
        if (result.added === 1) onFirst();
      }
    };
    await Promise.all(Array.from({ length: RESOLVE_CONCURRENCY }, worker));
    return result;
  }

  /**
   * One top-up: fill the queue back to the lookahead, counting only upcoming DJ
   * picks (FR-022, FR-021a).
   * @returns {Promise<{ added: number, failure: string|null, satisfied?: boolean }>}
   *   failure is a stall reason; satisfied means the lookahead was already met
   */
  async function runTopUp({ initial = false, onFirst = () => {} } = {}) {
    if (!session) return { added: 0, failure: null };
    const id = session.id;
    const blocked = blockReason({ initial });
    if (blocked) {
      setStatus('stalled', blocked);
      return { added: 0, failure: blocked };
    }
    const queue = getQueue();
    const needed = getLookahead() - (queue?.countUpcoming?.((t) => t.addedByDj) ?? 0);
    if (needed <= 0) {
      setStatus('running');
      return { added: 0, failure: null, satisfied: true };
    }

    let added = 0;
    let allowRepeats = false;
    for (let round = 0; round < MAX_ROUNDS && added < needed; round++) {
      if (!alive(id)) return { added, failure: null };
      if (!canAttempt()) {
        setStatus('stalled', 'SERVICE_UNAVAILABLE');
        return { added, failure: 'SERVICE_UNAVAILABLE' };
      }
      const remaining = needed - added;
      const candidates = buildCandidates();
      const candidatesById = new Map(candidates.map((c) => [c.id, c]));
      let response;
      try {
        response = await chatJson({
          system: PICKS_SYSTEM_PROMPT,
          user: JSON.stringify({
            theme: session.theme,
            count: remaining + EXTRA_PICKS,
            allowRepeats,
            candidates: candidates.map((c) => ({ id: c.id, title: c.title, artist: c.artist })),
            avoid: [...session.avoid]
          }),
          temperature: 0.7,
          timeoutMs: 20000
        });
      } catch (error) {
        onFailure(error?.kind === 'quota' ? 'quota' : 'llm', error);
        if (!alive(id)) return { added, failure: null };
        setStatus('stalled', 'SERVICE_UNAVAILABLE');
        return { added, failure: 'SERVICE_UNAVAILABLE' };
      }
      onSuccess();
      if (!alive(id)) return { added, failure: null };

      const items = filterPicks(response?.picks, candidatesById, allowRepeats);
      if (items.length === 0) {
        // Dedupe (or the model) left nothing: one retry allowing repeats (FR-025).
        if (allowRepeats) break;
        allowRepeats = true;
        continue;
      }

      const batch = await addPicks(items, remaining, id, allowRepeats, onFirst);
      added += batch.added;
      if (!alive(id)) return { added, failure: null };
      if (batch.capped) {
        setStatus('stalled', 'CAP_REACHED');
        return { added, failure: 'CAP_REACHED' };
      }
      if (batch.newTried > 0 && batch.newResolved === 0 && batch.added === 0) {
        onFailure('resolve', 'no new pick could be resolved');
      }
      if (batch.added === 0 && allowRepeats) break;
    }

    // Nothing fit, or nothing could be resolved, in any round.
    if (added === 0) {
      setStatus('stalled', 'THEME_EXHAUSTED');
      return { added, failure: 'THEME_EXHAUSTED' };
    }
    setStatus('running');
    return { added, failure: null };
  }

  function launch(options) {
    const run = runTopUp(options)
      .catch((error) => {
        logger.warn('[DJ] Theme top-up error:', error?.message ?? error);
        return { added: 0, failure: 'SERVICE_UNAVAILABLE' };
      })
      .finally(() => {
        if (inflight === run) inflight = null;
        if (pending && session) {
          pending = false;
          trigger();
        }
      });
    inflight = run;
    return run;
  }

  /** Run a top-up now, or once the running one finishes (one in flight). */
  function trigger() {
    if (!session) return;
    if (inflight) {
      pending = true;
      return;
    }
    launch();
  }

  /** Debounced trigger for queue and track events (1 s). */
  function schedule() {
    if (!session) return;
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      trigger();
    }, DEBOUNCE_MS);
    debounceTimer.unref?.();
  }

  function clearTimers() {
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = null;
    clearRetry();
  }

  /**
   * Start a session and its first top-up. `ready` settles as soon as the first
   * pick is in the queue (SC-005), or when the top-up ends with none added.
   * @param {{ theme: string, startedBy: Object|null, origin: Object }} params
   * @returns {{ session: Object, ready: Promise<{ added: boolean, failure: string|null }> }}
   */
  function start({ theme, startedBy = null, origin = { transport: 'http' } }) {
    clearTimers();
    session = {
      id: ++seq,
      theme,
      startedBy,
      startedAt: new Date().toISOString(),
      origin,
      usedKeys: new Set(),
      avoid: [],
      status: 'running',
      reason: null,
      introPending: false,
      announced: false
    };
    // Member tracks already queued are part of the session's history (FR-025).
    const queue = getQueue();
    for (const track of queue?.getAll?.() ?? []) remember(track);

    let settle;
    const ready = new Promise((resolve) => (settle = resolve));
    pending = false;
    // A top-up of a previous session may still be resolving; its picks are
    // dropped by the id check, and this one starts without waiting for it.
    launch({ initial: true, onFirst: () => settle({ added: true, failure: null }) }).then(
      (outcome) =>
        settle({ added: outcome.added > 0 || outcome.satisfied === true, failure: outcome.failure })
    );
    return { session, ready };
  }

  /** Change the theme of the running session; usedKeys are kept (US4/AC7). */
  function changeTheme(theme, startedBy = null) {
    if (!session) return null;
    // A new id drops picks for the old theme that are still resolving.
    session.id = ++seq;
    session.theme = theme;
    if (startedBy) session.startedBy = startedBy;
    session.startedAt = new Date().toISOString();
    // The caller broadcasts the change once; a later top-up reports its own status.
    session.status = 'running';
    session.reason = null;
    clearRetry();
    trigger();
    return session;
  }

  /** End the session. Picks still resolving are dropped (FR-024b). */
  function stop() {
    clearTimers();
    session = null;
    pending = false;
  }

  /** Mediator `queue:update`: remember member tracks, then top up (debounced). */
  function onQueueUpdate(payload) {
    if (!session) return;
    for (const track of payload?.tracks ?? []) if (!track?.addedByDj) remember(track);
    schedule();
  }

  /** Mediator `track:change`: every track that plays is used (FR-025). */
  function onTrackChange(track) {
    if (!session) return;
    if (track) remember(track);
    schedule();
  }

  /** A listener joined or left, or the bot's connection changed. */
  function onConditionsChanged() {
    if (!session) return;
    if (session.status === 'stalled') schedule();
  }

  /** Mediator `player:state`: the bot left voice → stalled NOT_IN_VOICE. */
  function onPlayerState(state) {
    if (!session) return;
    if (state && state.connected === false) {
      setStatus('stalled', 'NOT_IN_VOICE');
    } else if (session.status === 'stalled' && session.reason === 'NOT_IN_VOICE') {
      schedule();
    }
  }

  /** The ThemeState broadcast shape (contracts §1), or null. */
  function getThemeState() {
    if (!session) return null;
    return {
      theme: session.theme,
      startedBy: session.startedBy ? { ...session.startedBy } : null,
      startedAt: session.startedAt,
      status: session.status,
      reason: session.reason
    };
  }

  return {
    start,
    changeTheme,
    stop,
    trigger,
    onQueueUpdate,
    onTrackChange,
    onConditionsChanged,
    onPlayerState,
    getSession: () => session,
    getThemeState,
    /** Resolves once the running top-up (if any) has finished. For tests. */
    idle: () => inflight ?? Promise.resolve()
  };
}
