import { Router } from 'express';
import { musicManager } from '../../state/musicManager.js';
import { authMiddleware, optionalAuth } from '../middleware/auth.js';
import { search, getInfo, isValidUrl, isPlaylist, getPlaylist } from '../../music/youtube.js';
import { isConnected } from '../../bot/voiceManager.js';
import { parseSpotifyUrl, getPublicTrack, getPublicPlaylistTracks } from '../../music/spotify.js';
import { resolveSpotifyTrack, resolveSpotifyTracks } from '../../music/resolver.js';
import { resolutionManager, ResolutionManager } from '../../music/resolutionManager.js';
import { db } from '../../database/db.js';

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
    let skippedTracks = [];

    // Check for Spotify URL first
    const spotifyParsed = parseSpotifyUrl(query);

    if (spotifyParsed.type === 'playlist') {
      // Handle Spotify playlist - add tracks immediately without resolution (lazy)
      const spotifyTracks = await getPublicPlaylistTracks(spotifyParsed.id);
      if (spotifyTracks.length === 0) {
        return res.status(404).json({ error: 'Spotify playlist not found or empty' });
      }

      // Convert to unresolved queue tracks (lazy resolution)
      tracks = spotifyTracks.map(st =>
        ResolutionManager.createUnresolvedTrack(st, req.user.username)
      );

      // Tracks will be resolved lazily - no skipped tracks at add time
    } else if (spotifyParsed.type === 'track') {
      // Handle Spotify track
      const spotifyTrack = await getPublicTrack(spotifyParsed.id);
      if (!spotifyTrack) {
        return res.status(404).json({ error: 'Spotify track not found' });
      }

      const youtubeTrack = await resolveSpotifyTrack(spotifyTrack);
      if (!youtubeTrack) {
        return res.status(404).json({ error: `Could not find "${spotifyTrack.title}" on YouTube` });
      }
      tracks = [youtubeTrack];
    } else if (isPlaylist(query)) {
      // Handle YouTube playlist
      tracks = await getPlaylist(query);
      if (tracks.length === 0) {
        return res.status(404).json({ error: 'Playlist not found or empty' });
      }
    } else if (isValidUrl(query)) {
      // Handle direct YouTube URL
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

    // Trigger lookahead resolution for Spotify playlists (non-blocking)
    const hasUnresolvedTracks = tracks.some(t => t.status === 'unresolved');
    if (hasUnresolvedTracks && musicManager.queue) {
      resolutionManager.setQueue(musicManager.queue);
      resolutionManager.start();
      resolutionManager.processLookahead(musicManager.getCurrentIndex()).catch(err => {
        console.error('Lookahead resolution error:', err);
      });
    }

    res.json({
      success: true,
      added: tracks.length,
      tracks,
      skipped: skippedTracks,
      lazyResolution: hasUnresolvedTracks
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

  try {
    const history = db.getHistory(limit, offset);
    res.json({ history });
  } catch (error) {
    console.error('History error:', error);
    res.status(500).json({ error: 'Failed to get history' });
  }
});

export default router;
