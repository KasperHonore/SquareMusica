/**
 * AI DJ service (src/services/dj/).
 *
 * The shared error-code table from contracts/dj-api.md §2. Every transport maps a
 * DjError through this module (HTTP status, Discord ephemeral text, socket
 * `error { code, message }`), so the three surfaces cannot drift apart.
 * Modules in this folder MUST NOT import from src/transports/.
 */

import {
  DjError,
  DJ_UNAVAILABLE,
  INVALID_INTERVAL,
  INVALID_LOOKAHEAD,
  INVALID_THEME,
  NOT_IN_VOICE,
  NO_TRACKS_FOR_THEME,
  SERVICE_UNAVAILABLE,
  CAP_REACHED,
  THEMED_MODE_ACTIVE
} from './errors.js';

// Kept identical to requireVoiceConnection() in the Discord checks, which this
// layer may not import.
const NOT_IN_VOICE_TEXT = "I'm not in a voice channel! Use `/join` to add me first.";

/** code → { http, text }. `text` is a function only where it needs live state. */
export const DJ_MESSAGES = Object.freeze({
  [DJ_UNAVAILABLE]: { http: 503, text: "The DJ isn't set up on this server." },
  [INVALID_INTERVAL]: { http: 400, text: 'Interval must be a whole number from 1 to 10.' },
  [INVALID_LOOKAHEAD]: { http: 400, text: 'Lookahead must be 5 or 10.' },
  [INVALID_THEME]: { http: 400, text: 'Theme must be 1–200 characters.' },
  [NOT_IN_VOICE]: { http: 409, text: NOT_IN_VOICE_TEXT },
  [NO_TRACKS_FOR_THEME]: { http: 422, text: "I couldn't find any tracks for that theme." },
  [SERVICE_UNAVAILABLE]: {
    http: 503,
    text: "The DJ's music brain is unavailable right now, try again soon."
  },
  [CAP_REACHED]: {
    http: 429,
    text: (state) => `The DJ has hit today's limit; it resets at ${formatResetTime(state)}.`
  },
  [THEMED_MODE_ACTIVE]: { http: 409, text: 'Shuffle is off while themed mode is running.' }
});

/**
 * HH:MM of the next cap reset, read from `caps.resetsAt` as written (it already
 * carries the bot's local offset), so every surface shows the same clock time.
 * @param {Object} [state] - DjState
 * @returns {string}
 */
export function formatResetTime(state) {
  const resetsAt = state?.caps?.resetsAt;
  const match = typeof resetsAt === 'string' ? /T(\d{2}:\d{2})/.exec(resetsAt) : null;
  return match ? match[1] : '00:00';
}

/**
 * Map a coded DJ error to its reply on every surface.
 *
 * @param {unknown} error
 * @param {Object} [state] - Current DjState, needed for CAP_REACHED's reset time
 * @returns {{ code: string, http: number, message: string }|null} null when
 *   `error` is not a DjError with a known code (callers treat it as unexpected)
 */
export function describeDjError(error, state) {
  if (!(error instanceof DjError)) return null;
  const entry = DJ_MESSAGES[error.code];
  if (!entry) return null;
  const message = typeof entry.text === 'function' ? entry.text(state) : entry.text;
  return { code: error.code, http: entry.http, message };
}

/**
 * The settings keys a caller actually sent, so every transport hands
 * djService.setSettings() the same partial for the same request.
 * @param {Object} input
 * @returns {{ enabled?: unknown, interval?: unknown, lookahead?: unknown }}
 */
export function pickDjSettings(input) {
  const partial = {};
  if (input === null || typeof input !== 'object') return partial;
  for (const key of ['enabled', 'interval', 'lookahead']) {
    if (input[key] !== undefined) partial[key] = input[key];
  }
  return partial;
}
