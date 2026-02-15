import { Router } from 'express';
import { musicManager } from '../../state/musicManager.js';
import { db } from '../../database/db.js';
import { authMiddleware, optionalAuth } from '../middleware/auth.js';

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

    case 'volume':
      if (typeof value !== 'number' || value < 0 || value > 100) {
        return res.status(400).json({ error: 'Volume must be 0-100' });
      }
      success = musicManager.setVolume(value);
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

/**
 * GET /api/player/history - Get play history
 */
router.get('/history', optionalAuth, (req, res) => {
  const { limit = 50, offset = 0 } = req.query;
  const history = db.getHistory(parseInt(limit), parseInt(offset));
  res.json({ history });
});

export default router;
