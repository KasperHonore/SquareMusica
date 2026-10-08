import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { musicManager } from '../../../core/musicManager.js';
import { authMiddleware, optionalAuth } from '../middleware/auth.js';
import { search } from '../../../integrations/youtube.js';
import { isConnected } from '../../discord/voiceManager.js';
import { resolveQuery } from '../../../services/trackResolver.js';
import { db } from '../../../persistence/db.js';
import { botEvents } from '../../../events/bus.js';
import {
  STATS_EVENT,
  STATS_EVENT_TYPES,
  createStatsEvent,
  captureTrack
} from '../../../shared/statsEvents.js';
import {
  ensureVoiceConnected,
  resolveQueryErrorToMessage,
  formatTruncationNotice,
  MAX_QUERY_LENGTH
} from '../../../shared/queueHelpers.js';
import { logger } from '../../../utils/logger.js';
import { describeDjError } from '../../../services/dj/messages.js';

const router = Router();

/**
 * Emit one recorded action on the shared bus.
 *
 * Wrapped so a recording failure cannot turn a working queue request into a 500:
 * bus listeners run synchronously, inside this handler.
 */
function emitAction(type, user, track, metadata = null) {
  try {
    botEvents.emit(STATS_EVENT, createStatsEvent({ type, actor: user, track, metadata }));
  } catch {
    // Deliberately silent; the recorder logs its own failures.
  }
}

// GET /search is a read but it spawns a yt-dlp subprocess, so it gets its own
// limiter (the global mutation limiter intentionally skips GETs). Cheap reads
// like /history stay unthrottled.
const searchLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many searches, please slow down.' }
});

// Middleware to check voice connection for mutating operations
function requireVoiceConnection(req, res, next) {
  const guildId = musicManager.guildId || process.env.GUILD_ID;
  const ok = ensureVoiceConnected({
    guildId,
    isConnected,
    onNotConnected: () =>
      res.status(400).json({ error: 'Bot is not in a voice channel. Use /join in Discord first.' })
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

  if (typeof query !== 'string' || query.length > MAX_QUERY_LENGTH) {
    return res
      .status(400)
      .json({ error: `Query must be a string of at most ${MAX_QUERY_LENGTH} characters` });
  }

  try {
    const userInfo = {
      username: req.user.username,
      id: req.user.discord_id,
      avatar: req.user.avatar
    };

    // Resolve query to tracks
    const { tracks: rawTracks, error, truncation } = await resolveQuery(query, userInfo);

    if (error) {
      return res.status(404).json({ error: resolveQueryErrorToMessage(error) });
    }

    const { tracks, lazyResolution } = musicManager.addTracks(rawTracks, userInfo);

    const truncationNotice = formatTruncationNotice(truncation);

    res.json({
      success: true,
      added: tracks.length,
      tracks,
      lazyResolution,
      truncated: !!truncation,
      ...(truncation && {
        total: truncation.total,
        cap: truncation.cap,
        message: truncationNotice
      })
    });
  } catch (error) {
    logger.error('Add to queue error:', error);
    res.status(500).json({ error: 'Failed to add to queue' });
  }
});

/**
 * DELETE /api/queue/:position - Remove track from queue
 */
router.delete('/:position', authMiddleware, requireVoiceConnection, (req, res) => {
  const position = parseInt(req.params.position, 10);
  const queueLength = musicManager.getQueue().length;

  if (!Number.isInteger(position) || position < 0 || position >= queueLength) {
    return res.status(400).json({ error: 'Invalid position' });
  }

  // Read the track BEFORE removing it, or there is nothing left to record.
  const removedTrack = captureTrack(() => musicManager.getQueue()[position]);

  const success = musicManager.removeFromQueue(position);

  if (!success) {
    return res.status(404).json({ error: 'Track not found at position' });
  }

  emitAction(STATS_EVENT_TYPES.REMOVE, req.user, removedTrack);

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

  const queueLength = musicManager.getQueue().length;

  if (
    !Number.isInteger(from) ||
    !Number.isInteger(to) ||
    from < 0 ||
    from >= queueLength ||
    to < 0 ||
    to >= queueLength
  ) {
    return res.status(400).json({ error: 'Invalid positions' });
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
  const { shuffled, reason } = musicManager.shuffleQueue();
  if (!shuffled && reason) {
    // Refused during themed mode (FR-024a): nothing changed, nothing recorded.
    const { code, http, text } = describeDjError(reason);
    return res.status(http).json({ code, message: text });
  }
  // Acts on the queue as a whole, so no track is recorded.
  emitAction(STATS_EVENT_TYPES.SHUFFLE, req.user, null);
  res.json({ success: true });
});

/**
 * DELETE /api/queue - Clear queue
 */
router.delete('/', authMiddleware, requireVoiceConnection, (req, res) => {
  const queueLength = musicManager.getQueue().length;

  musicManager.clearQueue();

  // The three surfaces clear different things and always have: this one empties
  // everything including the current track, realtime clears only the upcoming
  // tracks, and Discord keeps the current one. Recording the variant is what
  // stops one event type from silently equating three different outcomes.
  emitAction(STATS_EVENT_TYPES.CLEAR_QUEUE, req.user, null, {
    variant: 'all',
    queueLength
  });

  res.json({ success: true });
});

/**
 * GET /api/queue/search - Search YouTube
 */
router.get('/search', searchLimiter, authMiddleware, async (req, res) => {
  const { q } = req.query;

  if (!q) {
    return res.status(400).json({ error: 'Query is required' });
  }

  if (typeof q !== 'string' || q.length > MAX_QUERY_LENGTH) {
    return res
      .status(400)
      .json({ error: `Query must be a string of at most ${MAX_QUERY_LENGTH} characters` });
  }

  // Clamp limit to an integer in [1, 10] (default 5), ignoring junk input.
  const parsedLimit = parseInt(req.query.limit, 10);
  const limit = Number.isNaN(parsedLimit) ? 5 : Math.min(10, Math.max(1, parsedLimit));

  try {
    const results = await search(q, limit);
    res.json({ results });
  } catch (error) {
    logger.error('Search error:', error);
    res.status(500).json({ error: 'Search failed' });
  }
});

/**
 * GET /api/queue/history - Get play history
 */
router.get('/history', optionalAuth, (req, res) => {
  const limit = parseInt(req.query.limit) || 50;
  const offset = parseInt(req.query.offset) || 0;

  logger.debug(`[History API] Fetching history: limit=${limit}, offset=${offset}`);

  try {
    const history = db.getHistory(limit, offset);
    logger.debug(`[History API] Returning ${history.length} records`);
    res.json({ history });
  } catch (error) {
    logger.error('[History API] Database error:', error);
    res.status(500).json({ error: 'Failed to get history' });
  }
});

export default router;
