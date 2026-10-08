/**
 * The shared DJ error table (contracts/dj-api.md §2): code → HTTP status and
 * the member-facing text. Discord, HTTP and Socket.io all map DjError through
 * this one table, so the three surfaces cannot drift apart. MUST NOT import
 * src/transports/.
 */
import {
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

// Same wording as the Discord transport's requireVoiceConnection check.
const NOT_IN_VOICE_TEXT = "I'm not in a voice channel! Use `/join` to add me first.";

/**
 * HH:MM of a local ISO timestamp such as caps.resetsAt
 * ("2026-10-09T00:00:00+02:00" → "00:00"). The string already carries local
 * wall-clock time, so no timezone conversion is needed.
 * @param {string|undefined} iso
 * @returns {string}
 */
export function formatResetTime(iso) {
  const match = typeof iso === 'string' ? iso.match(/T(\d{2}):(\d{2})/) : null;
  return match ? `${match[1]}:${match[2]}` : '00:00';
}

/**
 * `text` is a string, or a function of the current DjState for messages that
 * embed live values.
 */
export const DJ_ERROR_MESSAGES = {
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
    text: (state) =>
      `The DJ has hit today's limit; it resets at ${formatResetTime(state?.caps?.resetsAt)}.`
  },
  [THEMED_MODE_ACTIVE]: { http: 409, text: 'Shuffle is off while themed mode is running.' }
};

/**
 * Resolve a coded DJ error to its reply on every surface.
 * @param {{ code?: string }} error - Usually a DjError
 * @param {Object} [state] - Current DjState, for messages with live values
 * @returns {{ code: string, http: number, message: string } | null} null when
 *   the error carries no known code (callers treat it as an internal failure)
 */
export function describeDjError(error, state = null) {
  const entry = error ? DJ_ERROR_MESSAGES[error.code] : undefined;
  if (!entry) return null;
  const message = typeof entry.text === 'function' ? entry.text(state) : entry.text;
  return { code: error.code, http: entry.http, message };
}
