/**
 * Tiny level-gated logger. Level is read once from LOG_LEVEL (default "info").
 * Ordering: error > warn > info > debug. A message is emitted when its level is
 * at or above the configured threshold.
 *
 * This intentionally wraps console.* and adds no dependencies. Domain-specific
 * debug flags (e.g. DEBUG_YTDLP) are handled where they are used and are not
 * affected by LOG_LEVEL.
 */
const LEVELS = { error: 0, warn: 1, info: 2, debug: 3 };

function resolveThreshold() {
  const configured = (process.env.LOG_LEVEL || 'info').toLowerCase();
  return Object.prototype.hasOwnProperty.call(LEVELS, configured)
    ? LEVELS[configured]
    : LEVELS.info;
}

const threshold = resolveThreshold();

function enabled(level) {
  return LEVELS[level] <= threshold;
}

export const logger = {
  error(...args) {
    if (enabled('error')) console.error(...args);
  },
  warn(...args) {
    if (enabled('warn')) console.warn(...args);
  },
  info(...args) {
    if (enabled('info')) console.log(...args);
  },
  debug(...args) {
    if (enabled('debug')) console.log(...args);
  }
};
