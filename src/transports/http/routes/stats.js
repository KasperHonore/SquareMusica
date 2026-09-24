import { Router } from 'express';
import { authMiddleware } from '../middleware/auth.js';
import { SUPPORTED_PERIODS, buildStatsPayload } from '../../../services/statsQueries.js';
import { logger } from '../../../utils/logger.js';

const router = Router();

/**
 * Render the supported period list for the 400 body: "all", or
 * "all, week, or month". Built from SUPPORTED_PERIODS rather than hardcoded, so
 * the message can never advertise a period the service cannot resolve.
 */
function describeSupportedPeriods() {
  if (SUPPORTED_PERIODS.length === 1) return SUPPORTED_PERIODS[0];
  const head = SUPPORTED_PERIODS.slice(0, -1).join(', ');
  return `${head}, or ${SUPPORTED_PERIODS[SUPPORTED_PERIODS.length - 1]}`;
}

/**
 * GET /api/stats - DJ leaderboard and every award for one period.
 *
 * authMiddleware, not optionalAuth: optionalAuth never rejects, which would leave
 * per-member behavioral data readable by anyone who can reach the port.
 */
router.get('/', authMiddleware, (req, res) => {
  // Default to all-time when the parameter is absent (FR-018). An unrecognised
  // value is a 400, never a silent fallback to a different window — serving
  // all-time figures under a "This Week" label is the failure this prevents.
  const period = req.query.period === undefined ? 'all' : req.query.period;

  if (!SUPPORTED_PERIODS.includes(period)) {
    return res.status(400).json({ error: `Invalid period. Use ${describeSupportedPeriods()}.` });
  }

  try {
    const selfUserId = req.user?.discord_id || null;
    const payload = buildStatsPayload({ period, selfUserId });
    res.json(payload);
  } catch (error) {
    logger.error('[Stats API] Failed to build stats payload:', error);
    res.status(500).json({ error: 'Failed to load stats.' });
  }
});

export default router;
