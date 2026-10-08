/**
 * Shared DJ error-code table (contracts/dj-api.md §2).
 *
 * Every transport maps a DjError through this table, so the HTTP status,
 * Discord reply and socket `error { code, message }` cannot drift apart.
 * Lives under services/dj/ (not transports/) so all three transports can import
 * it without crossing the layer boundary the other way.
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

export const DJ_MESSAGES = Object.freeze({
  [DJ_UNAVAILABLE]: { http: 503, text: "The DJ isn't set up on this server." },
  [INVALID_INTERVAL]: { http: 400, text: 'Interval must be a whole number from 1 to 10.' },
  [INVALID_LOOKAHEAD]: { http: 400, text: 'Lookahead must be 5 or 10.' },
  [INVALID_THEME]: { http: 400, text: 'Theme must be 1–200 characters.' },
  // Same text as requireVoiceConnection() in the Discord command checks.
  [NOT_IN_VOICE]: { http: 409, text: "I'm not in a voice channel! Use `/join` to add me first." },
  [NO_TRACKS_FOR_THEME]: { http: 422, text: "I couldn't find any tracks for that theme." },
  [SERVICE_UNAVAILABLE]: {
    http: 503,
    text: "The DJ's music brain is unavailable right now, try again soon."
  },
  [CAP_REACHED]: { http: 429, text: "The DJ has hit today's limit; it resets at HH:MM." },
  [THEMED_MODE_ACTIVE]: { http: 409, text: 'Shuffle is off while themed mode is running.' }
});

/**
 * HH:MM of a `caps.resetsAt` string. resetsAt already carries the local offset
 * (e.g. 2026-10-09T00:00:00+02:00), so its own clock time is the local time.
 * @param {string|null|undefined} resetsAt
 * @returns {string|null}
 */
export function formatResetTime(resetsAt) {
  const match = typeof resetsAt === 'string' ? /T(\d{2}:\d{2})/.exec(resetsAt) : null;
  return match ? match[1] : null;
}

/**
 * The user-facing text for a code.
 * @param {string} code
 * @param {{ resetsAt?: string }} [context] - `caps.resetsAt` for CAP_REACHED
 * @returns {string}
 */
export function textFor(code, context = {}) {
  const entry = DJ_MESSAGES[code];
  if (!entry) return 'Something went wrong with the DJ. Please try again.';
  if (code === CAP_REACHED) {
    return entry.text.replace('HH:MM', formatResetTime(context.resetsAt) ?? 'midnight');
  }
  return entry.text;
}

/**
 * HTTP status and JSON body for a DjError.
 * @param {{ code: string }} error
 * @param {{ resetsAt?: string }} [context]
 * @returns {{ status: number, body: { code: string, message: string } }}
 */
export function toHttp(error, context) {
  const entry = DJ_MESSAGES[error.code];
  return {
    status: entry?.http ?? 500,
    body: { code: error.code, message: textFor(error.code, context) }
  };
}
