import { Router } from 'express';
import { authMiddleware } from '../middleware/auth.js';
import * as djService from '../../../services/dj/djService.js';
import { describeDjError } from '../../../services/dj/messages.js';
import { toActor } from '../../../shared/statsEvents.js';
import { logger } from '../../../utils/logger.js';

const router = Router();

/**
 * Map a thrown error to the shared contract body `{ code, message }`. Errors
 * without a DJ code are internal failures and stay a generic 500.
 */
function sendDjError(res, error) {
  const described = describeDjError(error, djService.getStateOrUnavailable());
  if (described) {
    return res.status(described.http).json({ code: described.code, message: described.message });
  }
  logger.error('[DJ API] Request failed:', error);
  return res.status(500).json({ error: 'Internal server error' });
}

/**
 * GET /api/dj - Current DjState, or { available: false } when unconfigured.
 */
router.get('/', authMiddleware, (req, res) => {
  res.json(djService.getStateOrUnavailable());
});

/**
 * PATCH /api/dj - Change any subset of { enabled, interval, lookahead }. The
 * service validates the whole body before writing, so it is all or nothing.
 */
router.patch('/', authMiddleware, (req, res) => {
  const body = req.body;
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return res.status(400).json({ error: 'Request body must be a JSON object.' });
  }

  const { enabled, interval, lookahead } = body;
  const partial = {};
  if (enabled !== undefined) partial.enabled = enabled;
  if (interval !== undefined) partial.interval = interval;
  if (lookahead !== undefined) partial.lookahead = lookahead;

  if (partial.enabled !== undefined && typeof partial.enabled !== 'boolean') {
    return res.status(400).json({ error: 'enabled must be true or false.' });
  }

  try {
    const { id, name } = toActor(req.user) ?? {};
    res.json(djService.setSettings(partial, { id, name }));
  } catch (error) {
    sendDjError(res, error);
  }
});

export default router;
