/**
 * AI DJ service (feature 002). Every module in src/services/dj/ is consumed by
 * all three transports through djService and MUST NOT import src/transports/
 * (Constitution II). Errors are thrown as DjError with a shared code, and each
 * transport maps the code to its own reply format (contracts §2).
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
   * @param {string} code - One of the exported error code constants
   * @param {string} [message]
   */
  constructor(code, message = code) {
    super(message);
    this.name = 'DjError';
    this.code = code;
  }
}
