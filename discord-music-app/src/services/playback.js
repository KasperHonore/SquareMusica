import { MusicPlayer } from '../core/player.js';
import { Queue } from '../core/queue.js';
import { musicManager } from '../core/musicManager.js';
import { resolutionManager } from './resolutionManager.js';
import { tryPlayWithFallback } from './trackResolver.js';
import { getConnection } from '../transports/discord/voiceManager.js';
import { logger } from '../utils/logger.js';

// Singleton player + queue. Created lazily so the web UI can detect voice state
// before any command runs, and shared across every transport (Discord, HTTP,
// Socket.io) via the musicManager mediator.
let player = null;
let queue = null;

/**
 * Advance through the queue and start playback, falling back past unplayable
 * tracks. On success, kicks off background lookahead resolution; on failure
 * (queue exhausted) stops the player and clears the now-playing state. Always
 * emits a queue update at the end (on exhaustion the queue has already
 * self-cleared, so this reports an empty queue).
 *
 * This is the single source of truth for the play/fallback/lookahead sequence
 * that used to be copy-pasted in musicManager.skip(), the trackEnd auto-advance,
 * and the /skip command handler.
 *
 * @param {Object} params
 * @param {Object} params.player - MusicPlayer instance
 * @param {Object} params.queue - Queue instance
 * @param {Object} params.connection - Voice connection (may be null)
 * @param {boolean} [params.skipCurrent=true] - Advance past the current track first
 * @returns {Promise<{ played: boolean, track: Object|null }>}
 */
export async function advanceAndPlay({ player, queue, connection, skipCurrent = true }) {
  const { played, track } = await tryPlayWithFallback(player, queue, connection, skipCurrent);

  if (played) {
    resolutionManager.processLookahead(queue?.currentIndex || 0).catch((err) => {
      logger.error('Lookahead resolution error:', err);
    });
  } else {
    player.stop();
    musicManager.emit('track:change', null);
    musicManager.emitState();
  }

  musicManager.emitQueueUpdate();
  return { played, track };
}

/**
 * Get (or lazily create) the singleton MusicPlayer, wiring its lifecycle events
 * to the mediator the first time it is created.
 * @returns {MusicPlayer}
 */
export function getPlayer() {
  if (!player) {
    player = new MusicPlayer();
    musicManager.setPlayer(player);
    musicManager.setGetConnection(getConnection);

    // Auto-play the next track when one ends.
    player.on('trackEnd', () => {
      void (async () => {
        try {
          const connection = getConnection(musicManager.guildId);
          const { played } = await advanceAndPlay({
            player,
            queue,
            connection,
            skipCurrent: true
          });

          if (!played) {
            logger.info('[TrackEnd] No more playable tracks');
            resolutionManager.stop();
            resolutionManager.processingTracks.clear();
          }
        } catch (error) {
          logger.error('[TrackEnd] Failed to autoplay next track:', error);
        }
      })();
    });

    // A track that could not be resolved/streamed was skipped; refresh clients.
    player.on('trackFailed', (failedTrack) => {
      logger.warn('Track failed, skipping:', failedTrack.title);
      musicManager.emitQueueUpdate();
    });

    // Catch player errors so they don't become uncaught exceptions.
    player.on('error', (error) => {
      logger.error('[Player] MusicPlayer error:', error.message);
    });
  }
  return player;
}

/**
 * Get (or lazily create) the singleton Queue, registering it with the mediator.
 * @returns {Queue}
 */
export function getQueue() {
  if (!queue) {
    queue = new Queue();
    musicManager.setQueue(queue);
  }
  return queue;
}
