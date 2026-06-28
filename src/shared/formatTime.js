// CANONICAL source for formatTime.
// MIRRORED in web/src/utils/formatTime.js — the web app is a separate package
// and cannot import across the package boundary, so the logic is duplicated.
// Keep both copies byte-identical. The authoritative test is
// test/shared/formatTime.test.js.
export function formatTime(seconds, emptyValue = '0:00') {
  if (!seconds || Number.isNaN(seconds)) return emptyValue;
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}
