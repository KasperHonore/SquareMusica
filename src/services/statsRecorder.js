import { botEvents } from '../events/bus.js';
import { db } from '../persistence/db.js';
import { musicManager } from '../core/musicManager.js';
import { STATS_EVENT } from '../shared/statsEvents.js';
import { logger } from '../utils/logger.js';

/**
 * The only module that writes `events` rows.
 *
 * Transports emit on the shared bus at their action sites; this subscriber is what
 * turns those emissions into rows. Routing through the bus is what keeps `core/`
 * free of any transport import while still letting a service react to transport
 * activity.
 */

let registered = false;

/**
 * Subscribe to the stats bus. Idempotent, so a second call (a re-import, a test)
 * cannot double-record every action.
 */
export function registerStatsRecorder() {
  if (registered) {
    logger.debug('[StatsRecorder] Already registered, ignoring duplicate registration');
    return;
  }

  botEvents.on(STATS_EVENT, handleStatsEvent);
  registered = true;
  logger.info('[StatsRecorder] Recording control actions for DJ stats');
}

/**
 * Persist one emitted event.
 *
 * This listener MUST swallow everything. EventEmitter invokes listeners
 * synchronously, in the emitting transport's own call stack, so an uncaught throw
 * here would propagate into the HTTP handler, socket handler or Discord command
 * that performed the action and break the action itself. Recording is best-effort:
 * losing a stat is acceptable, breaking playback is not.
 */
function handleStatsEvent(payload) {
  try {
    db.logEvent({
      ...payload,
      // Resolved at the write site rather than at each of the nineteen emit
      // sites. Mirrors history.guild_id for consistency; it never keys state.
      guildId: payload?.guildId ?? musicManager.guildId ?? process.env.GUILD_ID ?? null
    });
  } catch (error) {
    // db.logEvent already wraps its own failures, so reaching here means
    // something outside the insert went wrong. Logged and dropped either way.
    logger.error('[StatsRecorder] Failed to record event:', error?.message ?? error);
  }
}

/** Test seam: drop the subscription so a suite can re-register cleanly. */
export function unregisterStatsRecorder() {
  botEvents.off(STATS_EVENT, handleStatsEvent);
  registered = false;
}
