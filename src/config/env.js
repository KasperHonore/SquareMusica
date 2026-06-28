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
