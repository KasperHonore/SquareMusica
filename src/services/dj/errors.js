/**
 * Coded errors thrown by the DJ service (contracts/dj-api.md §2). Every transport
 * maps `code` to its own reply format, so the codes are the shared contract and
 * the messages are only for logs.
 */

export const DJ_UNAVAILABLE = 'DJ_UNAVAILABLE';
export const INVALID_INTERVAL = 'INVALID_INTERVAL';
export const INVALID_LOOKAHEAD = 'INVALID_LOOKAHEAD';
export const INVALID_THEME = 'INVALID_THEME';
export const NOT_IN_VOICE = 'NOT_IN_VOICE';
export const NO_TRACKS_FOR_THEME = 'NO_TRACKS_FOR_THEME';
export const SERVICE_UNAVAILABLE = 'SERVICE_UNAVAILABLE';
export const CAP_REACHED = 'CAP_REACHED';

export class DjError extends Error {
  /**
   * @param {string} code - One of the exported code constants
   * @param {string} [message]
   */
  constructor(code, message = code) {
    super(message);
    this.name = 'DjError';
    this.code = code;
  }
}
