import {
  DJ_UNAVAILABLE,
  INVALID_INTERVAL,
  INVALID_LOOKAHEAD,
  INVALID_THEME,
  NOT_IN_VOICE,
  NO_TRACKS_FOR_THEME,
  SERVICE_UNAVAILABLE,
  CAP_REACHED
} from './errors.js';

// The shared error-code table (contracts/dj-api.md §2). Every transport maps a
// DjError through here, so the HTTP status, the Discord text and the socket
// message cannot diverge between them (Constitution III).

/** The text Discord already uses when the bot is not in voice (commands/utils/checks.js). */
export const NOT_IN_VOICE_TEXT = "I'm not in a voice channel! Use `/join` to add me first.";

/**
 * code → { http, text }. `text` is a string, or a function of the current
 * DjState for messages that carry live values.
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
  }
};

/**
 * A reset timestamp as local HH:MM (24-hour), e.g. "00:00".
 * @param {string|undefined} iso
 * @returns {string}
 */
export function formatResetTime(iso) {
  const d = iso ? new Date(iso) : null;
  if (!d || Number.isNaN(d.getTime())) return '00:00';
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/**
 * Map an error to its shared reply, or null when it is not a known DjError (the
 * transport then falls back to its own generic failure).
 * @param {unknown} error
 * @param {Object} [state] - DjState, for messages that need live values
 * @returns {{ code: string, http: number, message: string }|null}
 */
export function djErrorReply(error, state) {
  const entry = error && typeof error === 'object' ? DJ_ERROR_MESSAGES[error.code] : undefined;
  if (!entry) return null;
  const message = typeof entry.text === 'function' ? entry.text(state) : entry.text;
  return { code: error.code, http: entry.http, message };
}
