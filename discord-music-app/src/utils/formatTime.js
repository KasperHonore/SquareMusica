/**
 * Format seconds into m:ss format
 * @param {number} seconds - Time in seconds
 * @param {string} emptyValue - Value to return for invalid input
 * @returns {string} Formatted time string
 */
export function formatTime(seconds, emptyValue = '0:00') {
  if (!seconds || isNaN(seconds)) return emptyValue;
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}
