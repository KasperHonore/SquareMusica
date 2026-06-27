export function formatTime(seconds, emptyValue = '0:00') {
  if (!seconds || Number.isNaN(seconds)) return emptyValue;
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}
