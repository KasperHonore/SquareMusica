import { logger } from '../../utils/logger.js';

const INACTIVITY_TIMEOUT = 2 * 60 * 1000; // 2 minutes
const timers = new Map();

export function startInactivityTimer(guildId, onTimeout) {
  cancelInactivityTimer(guildId);
  logger.info(`[Inactivity] Starting 2-minute timer for guild ${guildId}`);
  const timerId = setTimeout(() => {
    timers.delete(guildId);
    logger.info(`[Inactivity] Auto-leaving empty channel in guild ${guildId}`);
    onTimeout();
  }, INACTIVITY_TIMEOUT);
  timers.set(guildId, timerId);
}

export function cancelInactivityTimer(guildId) {
  const timerId = timers.get(guildId);
  if (timerId) {
    clearTimeout(timerId);
    timers.delete(guildId);
    logger.info(`[Inactivity] Timer cancelled - user rejoined in guild ${guildId}`);
  }
}
