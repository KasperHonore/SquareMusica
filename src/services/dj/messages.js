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

// The shared error-code table (contracts §2). Every transport maps a DjError
// through here (HTTP status, Discord ephemeral text, socket `error {code,message}`)
// so the three surfaces cannot drift apart (Constitution III).

export const DJ_MESSAGES = Object.freeze({
  [DJ_UNAVAILABLE]: { http: 503, text: "The DJ isn't set up on this server." },
  [INVALID_INTERVAL]: { http: 400, text: 'Interval must be a whole number from 1 to 10.' },
  [INVALID_LOOKAHEAD]: { http: 400, text: 'Lookahead must be 5 or 10.' },
  [INVALID_THEME]: { http: 400, text: 'Theme must be 1–200 characters.' },
  // The existing Discord not-in-voice text (commands/utils/checks.js).
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
 * "HH:MM" from a DjState `caps.resetsAt` ISO string. The string carries the
 * local offset, so its wall-clock part is already the configured TZ's time.
 * @param {string|null|undefined} resetsAt
 * @returns {string}
 */
export function formatResetTime(resetsAt) {
  const match = typeof resetsAt === 'string' ? resetsAt.match(/T(\d{2}:\d{2})/) : null;
  return match ? match[1] : '00:00';
}

/**
 * Map a DJ error code to its HTTP status and user-facing text.
 * @param {string} code
 * @param {{ resetsAt?: string }} [context] - `resetsAt` fills CAP_REACHED's HH:MM
 * @returns {{ code: string, http: number, text: string } | null} null for unknown codes
 */
export function describeDjError(code, context = {}) {
  const entry = DJ_MESSAGES[code];
  if (!entry) return null;
  const text =
    code === CAP_REACHED
      ? entry.text.replace('HH:MM', formatResetTime(context.resetsAt))
      : entry.text;
  return { code, http: entry.http, text };
}
