import { Router } from 'express';
import { musicManager } from '../../state/musicManager.js';
import { authMiddleware, optionalAuth } from '../middleware/auth.js';
import { search, getInfo, isValidUrl, isPlaylist, getPlaylist } from '../../music/youtube.js';
import { isConnected } from '../../bot/voiceManager.js';

const router = Router();

// Middleware to check voice connection for mutating operations
function requireVoiceConnection(req, res, next) {
  const guildId = musicManager.guildId || process.env.GUILD_ID;
  if (!isConnected(guildId)) {
    return res.status(400).json({ error: 'Bot is not in a voice channel. Use /join in Discord first.' });
  }
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
    let tracks = [];

    if (isPlaylist(query)) {
      // Handle playlist
      tracks = await getPlaylist(query);
      if (tracks.length === 0) {
        return res.status(404).json({ error: 'Playlist not found or empty' });
      }
    } else if (isValidUrl(query)) {
      // Handle direct URL
      const track = await getInfo(query);
      if (!track) {
        return res.status(404).json({ error: 'Video not found' });
      }
      tracks = [track];
    } else {
      // Search YouTube
      const results = await search(query, 1);
      if (results.length === 0) {
        return res.status(404).json({ error: 'No results found' });
      }
      tracks = [results[0]];
    }

    // Add requestedBy to all tracks
    tracks = tracks.map(track => ({
      ...track,
      requestedBy: req.user.username
    }));

    // Add to queue
    tracks.forEach(track => musicManager.addToQueue(track));

    res.json({
      success: true,
      added: tracks.length,
      tracks
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

export default router;
