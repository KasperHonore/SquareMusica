import { Router } from 'express';
import { authMiddleware } from '../middleware/auth.js';
import { getStateOrUnavailable, setSettings } from '../../../services/dj/djService.js';
import { djErrorReply } from '../../../services/dj/messages.js';
import { logger } from '../../../utils/logger.js';

const router = Router();

// The only fields PATCH /api/dj forwards (contracts §3). Anything else in the
// body is ignored rather than passed to the service.
const SETTINGS_FIELDS = ['enabled', 'interval', 'lookahead'];

/**
 * Who made the change, keyed by Discord user id like every other DJ actor
 * (research R12). `req.user.id` is the internal users.id and is not used.
 */
function actorFrom(user) {
  return { id: user?.discord_id ?? null, name: user?.username ?? 'Web User' };
}

/**
 * Send a DjError as `{ code, message }` with its shared HTTP status. Returns
 * false when the error is not a DjError so the caller can fall back.
 */
function sendDjError(res, error) {
  const reply = djErrorReply(error, getStateOrUnavailable());
  if (!reply) return false;
  res.status(reply.http).json({ code: reply.code, message: reply.message });
  return true;
}

/**
 * GET /api/dj - the current DjState, or `{ available: false }` when the DJ is
 * not configured (FR-030).
 */
router.get('/', authMiddleware, (req, res) => {
  res.json(getStateOrUnavailable());
});

/**
 * PATCH /api/dj - change any subset of `{ enabled, interval, lookahead }`. The
 * service validates the whole partial before writing, so a bad field changes
 * nothing (US2 scenario 3).
 */
router.patch('/', authMiddleware, (req, res) => {
  const body = req.body;
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return res.status(400).json({ code: 'INVALID_BODY', message: 'Body must be a JSON object.' });
  }

  const partial = {};
  for (const field of SETTINGS_FIELDS) {
    if (body[field] !== undefined) partial[field] = body[field];
  }

  try {
    res.json(setSettings(partial, actorFrom(req.user)));
  } catch (error) {
    if (sendDjError(res, error)) return;
    if (error instanceof TypeError) {
      // A non-boolean `enabled`; contracts §2 has no code of its own for it.
      return res.status(400).json({ code: 'INVALID_BODY', message: error.message });
    }
    logger.error('[DJ API] Failed to change settings:', error);
    res.status(500).json({ code: 'INTERNAL', message: 'Failed to change DJ settings.' });
  }
});

export default router;
