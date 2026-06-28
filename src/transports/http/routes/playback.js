import { Router } from 'express';
import { musicManager } from '../../../core/musicManager.js';
import { authMiddleware, optionalAuth } from '../middleware/auth.js';
import { isConnected } from '../../discord/voiceManager.js';

const router = Router();

// Known playback actions the controller can dispatch. Anything outside this set
// is rejected with a 400 before we touch the music manager.
const ALLOWED_ACTIONS = ['play', 'pause', 'skip', 'stop', 'loop'];

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

  switch (action) {
    case 'play':
      success = musicManager.play();
      break;

    case 'pause':
      success = musicManager.pause();
      break;

    case 'skip':
      success = musicManager.skip();
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
