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

/**
 * The AI DJ group (R10). All four or none: setting any one of them means the
 * operator intends to enable the DJ, so the rest become required.
 */
export const DJ_GROUP_VARS = [
  'ELEVENLABS_API_KEY',
  'ELEVENLABS_VOICE_ID',
  'DJ_LLM_BASE_URL',
  'DJ_LLM_MODEL'
];

function isSet(name) {
  const value = process.env[name];
  return value !== undefined && value !== null && String(value).trim() !== '';
}

/**
 * Names to append to the validateEnv() list: all four DJ group vars if ANY is
 * set, else none. Appending (rather than validating separately) reports a
 * partial DJ config in the same single aggregated error as other missing vars.
 *
 * @returns {string[]}
 */
export function djRequiredVars() {
  return DJ_GROUP_VARS.some(isSet) ? [...DJ_GROUP_VARS] : [];
}

/**
 * Whether the DJ is configured. False means the DJ service is never built and
 * the player keeps the legacy audio path (FR-030).
 *
 * @returns {boolean}
 */
export function isDjConfigured() {
  return DJ_GROUP_VARS.every(isSet);
}

const POSITIVE_INTEGER = /^[1-9]\d*$/;

/**
 * Validate the formats of the optional DJ values that are set. Caps must be
 * positive integers; the LLM base URL must be http(s).
 *
 * @throws {Error} Naming every invalid variable and its value
 */
export function validateDjFormats() {
  const problems = [];

  for (const name of ['DJ_DAILY_LINE_CAP', 'DJ_DAILY_THEME_TRACK_CAP']) {
    if (isSet(name) && !POSITIVE_INTEGER.test(String(process.env[name]).trim())) {
      problems.push(`${name}="${process.env[name]}" must be a positive integer`);
    }
  }

  if (isSet('DJ_LLM_BASE_URL')) {
    const raw = String(process.env.DJ_LLM_BASE_URL).trim();
    let protocol = null;
    try {
      protocol = new URL(raw).protocol;
    } catch {
      // Unparseable: reported below.
    }
    if (protocol !== 'http:' && protocol !== 'https:') {
      problems.push(`DJ_LLM_BASE_URL="${raw}" must be an http(s) URL`);
    }
  }

  if (problems.length > 0) {
    throw new Error(`Invalid environment variable(s): ${problems.join('; ')}. See .env.sample.`);
  }
}

/**
 * Read the DJ configuration with defaults applied. Call only after
 * validateDjFormats() has passed.
 *
 * @returns {{
 *   elevenlabs: { apiKey: string, voiceId: string, modelId: string },
 *   llm: { baseUrl: string, model: string, apiKey: string|null },
 *   caps: { lines: number, themedTracks: number }
 * }}
 */
export function getDjConfig() {
  const read = (name) => (isSet(name) ? String(process.env[name]).trim() : null);
  const cap = (name, fallback) => (isSet(name) ? parseInt(process.env[name], 10) : fallback);
  return {
    elevenlabs: {
      apiKey: read('ELEVENLABS_API_KEY'),
      voiceId: read('ELEVENLABS_VOICE_ID'),
      modelId: read('ELEVENLABS_MODEL_ID') ?? 'eleven_flash_v2_5'
    },
    llm: {
      baseUrl: read('DJ_LLM_BASE_URL'),
      model: read('DJ_LLM_MODEL'),
      apiKey: read('DJ_LLM_API_KEY')
    },
    caps: {
      lines: cap('DJ_DAILY_LINE_CAP', 150),
      themedTracks: cap('DJ_DAILY_THEME_TRACK_CAP', 100)
    }
  };
}
