import { Router } from 'express';
import { musicManager } from '../../state/musicManager.js';
import { authMiddleware, optionalAuth } from '../middleware/auth.js';
import { search } from '../../music/youtube.js';
import { isConnected } from '../../bot/voiceManager.js';
import { resolveQuery } from '../../music/trackResolver.js';
import { resolutionManager } from '../../music/resolutionManager.js';
import { db } from '../../database/db.js';
import { addTracksToQueue, ensureVoiceConnected, resolveQueryErrorToMessage } from '../../shared/queueHelpers.js';

const router = Router();

// Middleware to check voice connection for mutating operations
function requireVoiceConnection(req, res, next) {
  const guildId = musicManager.guildId || process.env.GUILD_ID;
  const ok = ensureVoiceConnected({
    guildId,
    isConnected,
    onNotConnected: () => res.status(400).json({ error: 'Bot is not in a voice channel. Use /join in Discord first.' })
  });
  if (!ok) return;
  next();
}

/**
 * GET /api/queue - Get current queue
 */
router.get('/', optionalAuth, (req, res) => {
  res.json({
    tracks: musicManager.getQueue(),
    currentIndex: musicManager.getCurrentIndex(),
    currentTrack: musicManager.getCurrentTrack()
  });
});

/**
 * POST /api/queue - Add track to queue
 */
router.post('/', authMiddleware, requireVoiceConnection, async (req, res) => {
  const { query } = req.body;

  if (!query) {
    return res.status(400).json({ error: 'Query is required' });
  }

  try {
    const userInfo = {
      username: req.user.username,
      id: req.user.discord_id,
      avatar: req.user.avatar
    };

    // Resolve query to tracks
    const { tracks: rawTracks, error } = await resolveQuery(query, userInfo);

    if (error) {
      return res.status(404).json({ error: resolveQueryErrorToMessage(error) });
    }

    const { tracks, lazyResolution } = addTracksToQueue({
      musicManager,
      resolutionManager,
      queue: musicManager.queue,
      currentIndex: musicManager.getCurrentIndex(),
      rawTracks,
      userInfo
    });

    res.json({
      success: true,
      added: tracks.length,
      tracks,
      lazyResolution
    });
  } catch (error) {
    console.error('Add to queue error:', error);
    res.status(500).json({ error: 'Failed to add to queue' });
  }
});

/**
 * DELETE /api/queue/:position - Remove track from queue
 */
router.delete('/:position', authMiddleware, requireVoiceConnection, (req, res) => {
  const position = parseInt(req.params.position);

  if (isNaN(position) || position < 0) {
    return res.status(400).json({ error: 'Invalid position' });
  }

  const success = musicManager.removeFromQueue(position);

  if (!success) {
    return res.status(404).json({ error: 'Track not found at position' });
  }

  res.json({ success: true });
});

/**
 * PATCH /api/queue/reorder - Reorder tracks
 */
router.patch('/reorder', authMiddleware, requireVoiceConnection, (req, res) => {
  const { from, to } = req.body;

  if (typeof from !== 'number' || typeof to !== 'number') {
    return res.status(400).json({ error: 'from and to are required' });
  }

  const success = musicManager.reorderQueue(from, to);

  if (!success) {
    return res.status(400).json({ error: 'Invalid positions' });
  }

  res.json({ success: true });
});

/**
 * POST /api/queue/shuffle - Shuffle queue
 */
router.post('/shuffle', authMiddleware, requireVoiceConnection, (req, res) => {
  musicManager.shuffleQueue();
  res.json({ success: true });
});

/**
 * DELETE /api/queue - Clear queue
 */
router.delete('/', authMiddleware, requireVoiceConnection, (req, res) => {
  musicManager.clearQueue();
  res.json({ success: true });
});

/**
 * GET /api/queue/search - Search YouTube
 */
router.get('/search', authMiddleware, async (req, res) => {
  const { q, limit = 5 } = req.query;

  if (!q) {
    return res.status(400).json({ error: 'Query is required' });
  }

  try {
    const results = await search(q, parseInt(limit));
    res.json({ results });
  } catch (error) {
    console.error('Search error:', error);
    res.status(500).json({ error: 'Search failed' });
  }
});

/**
 * GET /api/queue/history - Get play history
 */
router.get('/history', optionalAuth, (req, res) => {
  const limit = parseInt(req.query.limit) || 50;
  const offset = parseInt(req.query.offset) || 0;

  console.log(`[History API] Fetching history: limit=${limit}, offset=${offset}`);

  try {
    const history = db.getHistory(limit, offset);
    console.log(`[History API] Returning ${history.length} records`);
    res.json({ history });
  } catch (error) {
    console.error('[History API] Database error:', error);
    res.status(500).json({ error: 'Failed to get history' });
  }
});

export default router;
