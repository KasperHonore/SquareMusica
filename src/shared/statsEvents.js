/**
 * The one payload shape every recorded control action travels in.
 *
 * Recording sites are spread across all three transports because that is the only
 * layer where the actor exists: `core/` never sees a user, and the Discord
 * commands bypass `musicManager` entirely for pause/resume/skip. A missed or
 * malformed site is a *silent* gap — the action still works, nothing errors, and
 * an award is simply wrong forever. So every site builds its payload through the
 * factory here rather than assembling an object literal of its own, which makes
 * the recorded shape identical across surfaces by construction instead of by
 * discipline at nineteen call sites.
 *
 * Lives in shared/ because both services/ and all three transports import it, and
 * shared/ is the layer anything may depend on without creating a cycle.
 */

/** Bus event name. The recorder in services/ is the only subscriber that writes. */
export const STATS_EVENT = 'stats:event';

/**
 * The closed set of recorded action types.
 *
 * `stop` is deliberately absent, on every surface. Stopping *does* empty the
 * queue as a side effect, so emitting `clear_queue` from a stop handler looks
 * like closing a gap; it is not. Instrumenting one surface's stop and not the
 * others is exactly the divergence the parity matrix exists to prevent, and
 * instrumenting all three would record an action the spec does not define.
 */
export const STATS_EVENT_TYPES = Object.freeze({
  SKIP: 'skip',
  PAUSE: 'pause',
  RESUME: 'resume',
  REMOVE: 'remove',
  SHUFFLE: 'shuffle',
  CLEAR_QUEUE: 'clear_queue',
  TRACK_COMPLETE: 'track_complete'
});

const VALID_TYPES = new Set(Object.values(STATS_EVENT_TYPES));

/**
 * Action types that act on the queue as a whole rather than on one track, and so
 * legitimately carry a null `track`. Every other type must name its track.
 */
const TRACKLESS_TYPES = new Set([STATS_EVENT_TYPES.SHUFFLE, STATS_EVENT_TYPES.CLEAR_QUEUE]);

/**
 * Normalise a transport's user object into the recorded actor snapshot.
 *
 * The three surfaces name their fields differently — `req.user` and `socket.user`
 * carry `discord_id`/`username`, a discord.js `interaction.user` carries
 * `id`/`username` — so the mapping happens here, once, instead of at each site.
 *
 * @param {Object|null} user
 * @returns {{ id: string|null, name: string|null, avatar: string|null }|null}
 */
export function toActor(user) {
  if (!user) return null;
  return {
    id: user.discord_id ?? user.id ?? null,
    name: user.username ?? user.name ?? null,
    avatar: user.avatar ?? null
  };
}

/**
 * Normalise a track into the recorded track snapshot, keeping the original
 * requester so an action can be attributed to whoever queued the affected track.
 */
function toTrackSnapshot(track) {
  if (!track) return null;
  return {
    title: track.title ?? null,
    url: track.url ?? null,
    requestedById: track.requestedById ?? null,
    requestedBy: track.requestedBy ?? null
  };
}

/**
 * Build a stats event payload.
 *
 * @param {Object} params
 * @param {string} params.type - One of STATS_EVENT_TYPES.
 * @param {Object|null} [params.actor] - The transport's user object, or null for
 *   `track_complete`, which has no actor.
 * @param {Object|null} [params.track] - The affected track. For `skip` and
 *   `remove` this MUST be read before the mutation, or the wrong track (or none)
 *   is recorded.
 * @param {Object|null} [params.metadata] - Per-type extras. Required on
 *   `clear_queue` as `{ variant }`: the three surfaces clear different things, and
 *   without the variant one event type silently equates three outcomes.
 * @param {string|null} [params.guildId]
 * @returns {Object} payload
 */
export function createStatsEvent({
  type,
  actor = null,
  track = null,
  metadata = null,
  guildId = null
}) {
  if (!VALID_TYPES.has(type)) {
    throw new Error(`Unknown stats event type: ${type}`);
  }

  return {
    type,
    guildId,
    actor: toActor(actor),
    track: TRACKLESS_TYPES.has(type) ? null : toTrackSnapshot(track),
    metadata: metadata ?? null
  };
}

/** True when this type acts on the queue as a whole and records no track. */
export function isTracklessType(type) {
  return TRACKLESS_TYPES.has(type);
}

/**
 * Eagerly read the track an action is about to affect, swallowing any failure.
 *
 * Eager, not lazy: `skip` and `remove` must capture BEFORE the mutation, so the
 * read cannot be deferred into the emit. Guarded, because the read exists purely
 * for recording — if reaching into the queue throws, the action it was recording
 * must still succeed, and recording a null track is the correct degradation.
 *
 * @param {() => Object|null|undefined} read
 * @returns {Object|null}
 */
export function captureTrack(read) {
  try {
    return read() ?? null;
  } catch {
    return null;
  }
}
