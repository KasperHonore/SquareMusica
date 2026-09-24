import { Router } from 'express';
import { musicManager } from '../../../core/musicManager.js';
import { authMiddleware, optionalAuth } from '../middleware/auth.js';
import { isConnected } from '../../discord/voiceManager.js';
import { botEvents } from '../../../events/bus.js';
import {
  STATS_EVENT,
  STATS_EVENT_TYPES,
  createStatsEvent,
  captureTrack
} from '../../../shared/statsEvents.js';

const router = Router();

// Known playback actions the controller can dispatch. Anything outside this set
// is rejected with a 400 before we touch the music manager.
const ALLOWED_ACTIONS = ['play', 'pause', 'skip', 'stop', 'loop'];

/**
 * Emit one recorded action on the shared bus.
 *
 * Best-effort by contract: a recording failure must never turn a working playback
 * request into a 500, so the emit is wrapped here rather than trusted to the
 * recorder alone (bus listeners run synchronously, inside this handler).
 */
function emitAction(type, user, track, metadata = null) {
  try {
    botEvents.emit(STATS_EVENT, createStatsEvent({ type, actor: user, track, metadata }));
  } catch {
    // Deliberately silent: the recorder logs its own failures, and this path
    // exists only so a malformed payload cannot break playback.
  }
}

/**
 * GET /api/player - Get player state
 */
router.get('/', optionalAuth, (req, res) => {
  res.json(musicManager.getPlayerState());
});

/**
 * POST /api/player/:action - Control playback
 */
router.post('/:action', authMiddleware, (req, res) => {
  const guildId = musicManager.guildId || process.env.GUILD_ID;
  if (!isConnected(guildId)) {
    return res
      .status(400)
      .json({ error: 'Bot is not in a voice channel. Use /join in Discord first.' });
  }

  const { action } = req.params;
  const { value } = req.body;

  if (!action || !ALLOWED_ACTIONS.includes(action)) {
    return res.status(400).json({ error: 'Unknown action' });
  }

  let success = false;

  // Captured BEFORE any mutation: skip advances the queue, so reading the current
  // track afterwards records the track that came next, not the one skipped.
  // pause/resume target whatever is playing and so carry it too.
  const affectedTrack = captureTrack(() => musicManager.getCurrentTrack());

  switch (action) {
    case 'play':
      success = musicManager.play();
      // Recorded as `resume`, which is what this action does: musicManager.play()
      // calls player.resume(). This surface has no separate resume action, and
      // adding one to widen the public API is not this feature's business.
      emitAction(STATS_EVENT_TYPES.RESUME, req.user, affectedTrack);
      break;

    case 'pause':
      success = musicManager.pause();
      emitAction(STATS_EVENT_TYPES.PAUSE, req.user, affectedTrack);
      break;

    case 'skip':
      success = musicManager.skip();
      emitAction(STATS_EVENT_TYPES.SKIP, req.user, affectedTrack);
      break;

    case 'stop':
      success = musicManager.stop();
      break;

    case 'loop':
      if (!['off', 'track', 'queue'].includes(value)) {
        return res.status(400).json({ error: 'Invalid loop mode' });
      }
      success = musicManager.setLoop(value);
      break;

    default:
      return res.status(400).json({ error: 'Unknown action' });
  }

  res.json({ success, state: musicManager.getPlayerState() });
});

export default router;
