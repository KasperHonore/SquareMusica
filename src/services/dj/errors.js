/**
 * AI DJ service (src/services/dj/).
 *
 * Coded errors thrown by djService. Every transport (Discord, HTTP, Socket.io)
 * maps `code` to its own reply format (contracts/dj-api.md §2), so the codes
 * here are the shared vocabulary. Modules in this folder MUST NOT import
 * src/transports/.
 */

export const DJ_UNAVAILABLE = 'DJ_UNAVAILABLE';
export const INVALID_INTERVAL = 'INVALID_INTERVAL';
export const INVALID_LOOKAHEAD = 'INVALID_LOOKAHEAD';
export const INVALID_THEME = 'INVALID_THEME';
export const NOT_IN_VOICE = 'NOT_IN_VOICE';
export const NO_TRACKS_FOR_THEME = 'NO_TRACKS_FOR_THEME';
export const SERVICE_UNAVAILABLE = 'SERVICE_UNAVAILABLE';
export const CAP_REACHED = 'CAP_REACHED';
export const THEMED_MODE_ACTIVE = 'THEMED_MODE_ACTIVE';

export class DjError extends Error {
  /**
   * @param {string} code - One of the exported error codes
   * @param {string} [message]
   */
  constructor(code, message = code) {
    super(message);
    this.name = 'DjError';
    this.code = code;
  }
}
