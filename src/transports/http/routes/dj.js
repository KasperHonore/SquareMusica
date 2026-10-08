import { Router } from 'express';
import { authMiddleware } from '../middleware/auth.js';
import * as djService from '../../../services/dj/djService.js';
import { describeDjError, pickDjSettings } from '../../../services/dj/messages.js';
import { logger } from '../../../utils/logger.js';

const router = Router();

/** The member making the change, from the JWT user (same shape on every surface). */
function actorFrom(user) {
  return { id: user?.discord_id ?? null, name: user?.username ?? 'Web User' };
}

/**
 * Reply to a failed DJ call. Coded errors map through the shared table in
 * services/dj/messages.js (contracts §2); anything else is a 500.
 */
function sendError(res, error) {
  const mapped = describeDjError(error, djService.getStateOrUnavailable());
  if (mapped) {
    return res.status(mapped.http).json({ code: mapped.code, message: mapped.message });
  }
  if (error instanceof TypeError) {
    return res.status(400).json({ code: 'INVALID_REQUEST', message: error.message });
  }
  logger.error('[DJ API] Request failed:', error);
  return res.status(500).json({ code: 'INTERNAL', message: 'Something went wrong.' });
}

/**
 * GET /api/dj - the DjState (contracts §1), or { available: false } when the
 * DJ env group is not configured.
 */
router.get('/', authMiddleware, (req, res) => {
  res.json(djService.getStateOrUnavailable());
});

/**
 * PATCH /api/dj - change any subset of { enabled, interval, lookahead }. The
 * service validates the whole body before writing, so a rejected request leaves
 * the state unchanged (US2 scenario 3).
 */
router.patch('/', authMiddleware, (req, res) => {
  const body = req.body;
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return res
      .status(400)
      .json({ code: 'INVALID_REQUEST', message: 'Request body must be a JSON object.' });
  }

  try {
    const state = djService.setSettings(pickDjSettings(body), actorFrom(req.user));
    res.json(state);
  } catch (error) {
    sendError(res, error);
  }
});

export default router;
