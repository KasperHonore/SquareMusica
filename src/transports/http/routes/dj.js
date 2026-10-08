import { Router } from 'express';
import { authMiddleware } from '../middleware/auth.js';
import { getStateOrUnavailable, setSettings } from '../../../services/dj/djService.js';
import { DjError } from '../../../services/dj/errors.js';
import { describeDjError } from '../../../services/dj/messages.js';
import { logger } from '../../../utils/logger.js';

const router = Router();

/** The JWT user as a DJ actor `{ id, name }`. */
function actorFrom(user) {
  return { id: user?.discord_id ?? null, name: user?.global_name || user?.username || null };
}

/**
 * Send a DjError as `{ code, message }` with the shared status (contracts §2).
 * A TypeError is a malformed field (e.g. a non-boolean `enabled`), never a DJ
 * outcome; anything else is a bug.
 */
function sendError(res, error) {
  if (error instanceof DjError) {
    const described = describeDjError(error.code, {
      resetsAt: getStateOrUnavailable().caps?.resetsAt
    });
    if (described) {
      return res.status(described.http).json({ code: described.code, message: described.text });
    }
  }
  if (error instanceof TypeError) {
    return res.status(400).json({ error: error.message });
  }
  logger.error('[DJ API] Request failed:', error);
  return res.status(500).json({ error: 'Internal server error' });
}

/**
 * GET /api/dj - the DjState, or `{ available: false }` when the DJ env group is
 * not configured (FR-030).
 */
router.get('/', authMiddleware, (req, res) => {
  res.json(getStateOrUnavailable());
});

/**
 * PATCH /api/dj - change any subset of `{ enabled, interval, lookahead }`. The
 * service validates the whole body before writing, so a rejected change leaves
 * the previous settings in effect (US2 scenario 3).
 */
router.patch('/', authMiddleware, (req, res) => {
  const body = req.body;
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return res.status(400).json({ error: 'Request body must be a JSON object.' });
  }

  try {
    res.json(setSettings(body, actorFrom(req.user)));
  } catch (error) {
    sendError(res, error);
  }
});

export default router;
