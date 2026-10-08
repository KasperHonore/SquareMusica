import { Router } from 'express';
import { authMiddleware } from '../middleware/auth.js';
import * as djService from '../../../services/dj/djService.js';
import { DjError } from '../../../services/dj/errors.js';
import { toHttp } from '../../../services/dj/messages.js';
import { logger } from '../../../utils/logger.js';

const router = Router();

/** The DJ settings keys PATCH accepts (contracts §3). */
const SETTINGS_KEYS = ['enabled', 'interval', 'lookahead'];

function actorFrom(user) {
  return { id: user?.discord_id ?? null, name: user?.username ?? null };
}

function sendDjError(res, error) {
  const { status, body } = toHttp(error, { resetsAt: djService.getState().caps?.resetsAt });
  res.status(status).json(body);
}

/**
 * GET /api/dj - The current DjState, or { available: false } when the DJ env
 * group is not configured (FR-030).
 */
router.get('/', authMiddleware, (req, res) => {
  res.json(djService.getStateOrUnavailable());
});

/**
 * PATCH /api/dj - Change any subset of { enabled, interval, lookahead }.
 * djService validates the whole partial before writing, so it is all or nothing.
 */
router.patch('/', authMiddleware, (req, res) => {
  const body = req.body;
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return res
      .status(400)
      .json({ code: 'INVALID_REQUEST', message: 'Body must be a JSON object.' });
  }
  // contracts §2 has no code for a non-boolean `enabled`; djService treats it as
  // a programming error, so the transport rejects it before calling.
  if (body.enabled !== undefined && typeof body.enabled !== 'boolean') {
    return res
      .status(400)
      .json({ code: 'INVALID_REQUEST', message: 'enabled must be true or false.' });
  }

  const partial = {};
  for (const key of SETTINGS_KEYS) {
    if (body[key] !== undefined) partial[key] = body[key];
  }

  try {
    res.json(djService.setSettings(partial, actorFrom(req.user)));
  } catch (error) {
    if (error instanceof DjError) return sendDjError(res, error);
    logger.error('[DJ API] Failed to change settings:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * POST /api/dj/theme - Start themed mode, or change the theme when it is on.
 * Body { theme, lookahead? }. Answers once the first pick is queued.
 */
router.post('/theme', authMiddleware, async (req, res) => {
  const body = req.body;
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return res
      .status(400)
      .json({ code: 'INVALID_REQUEST', message: 'Body must be a JSON object.' });
  }
  const input = { theme: body.theme };
  if (body.lookahead !== undefined) input.lookahead = body.lookahead;

  try {
    res.json(await djService.startTheme(input, actorFrom(req.user), { transport: 'http' }));
  } catch (error) {
    if (error instanceof DjError) return sendDjError(res, error);
    logger.error('[DJ API] Failed to start theme:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * DELETE /api/dj/theme - Stop themed mode. Queued picks stay.
 */
router.delete('/theme', authMiddleware, (req, res) => {
  try {
    res.json(djService.stopTheme(actorFrom(req.user)));
  } catch (error) {
    if (error instanceof DjError) return sendDjError(res, error);
    logger.error('[DJ API] Failed to stop theme:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
