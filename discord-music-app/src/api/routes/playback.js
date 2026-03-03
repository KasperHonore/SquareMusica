import { Router } from 'express';
import { musicManager } from '../../state/musicManager.js';
import { authMiddleware, optionalAuth } from '../middleware/auth.js';
import { isConnected } from '../../bot/voiceManager.js';

const router = Router();

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
    return res.status(400).json({ error: 'Bot is not in a voice channel. Use /join in Discord first.' });
  }

  const { action } = req.params;
  const { value } = req.body;

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
