/**
 * Validate that the given environment variables are present and non-empty.
 * Collects ALL missing vars and throws a single aggregated Error rather than
 * failing on the first one, so the operator can fix everything in one pass.
 *
 * @param {string[]} required - Names of required environment variables
 * @throws {Error} If any required var is missing or empty
 */
export function validateEnv(required) {
  const missing = required.filter((name) => {
    const value = process.env[name];
    return value === undefined || value === null || String(value).trim() === '';
  });

  if (missing.length > 0) {
    throw new Error(
      `Missing required environment variable(s): ${missing.join(', ')}. ` +
        'Set them in your .env file (see .env.sample).'
    );
  }
}

/**
 * Validate that TZ names a real IANA timezone.
 *
 * libc silently falls back to UTC for an unknown zone, so a typo in TZ would make
 * every local-time stat run on the wrong clock without any error. Intl is strict
 * and throws RangeError instead, which is surfaced here as a config error.
 *
 * @throws {Error} If TZ is not a timezone the runtime recognises
 */
export function validateTimezone() {
  const tz = process.env.TZ;
  try {
    new Intl.DateTimeFormat('en', { timeZone: tz });
  } catch (error) {
    if (error instanceof RangeError) {
      throw new Error(
        `Invalid environment variable TZ="${tz}": not a known IANA timezone ` +
          '(e.g. Europe/Copenhagen). See .env.sample.'
      );
    }
    throw error;
  }
}
