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

// The AI DJ env group (R10): all four or none. Setting any one makes the others
// required, so a partial config is reported in the same aggregated error.
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
 * Names to append to validateEnv's list: all four DJ group vars if any is set,
 * otherwise none (the DJ is simply not configured).
 * @returns {string[]}
 */
export function djRequiredVars() {
  return DJ_GROUP_VARS.some(isSet) ? [...DJ_GROUP_VARS] : [];
}

/**
 * True when the whole DJ group is present.
 * @returns {boolean}
 */
export function isDjConfigured() {
  return DJ_GROUP_VARS.every(isSet);
}

/**
 * Validate the formats of the optional DJ settings. Only meaningful once the
 * group is configured; unset caps fall back to their defaults.
 * @throws {Error} Naming every malformed variable at once
 */
export function validateDjFormats() {
  if (!isDjConfigured()) return;
  const problems = [];

  for (const name of ['DJ_DAILY_LINE_CAP', 'DJ_DAILY_THEME_TRACK_CAP']) {
    if (!isSet(name)) continue;
    const raw = String(process.env[name]).trim();
    if (!/^\d+$/.test(raw) || Number(raw) < 1) {
      problems.push(`${name}="${raw}" must be a positive integer`);
    }
  }

  const baseUrl = String(process.env.DJ_LLM_BASE_URL).trim();
  let protocol = null;
  try {
    protocol = new URL(baseUrl).protocol;
  } catch {
    // reported below
  }
  if (protocol !== 'http:' && protocol !== 'https:') {
    problems.push(`DJ_LLM_BASE_URL="${baseUrl}" must be an http(s) URL`);
  }

  if (problems.length > 0) {
    throw new Error(`Invalid environment variable(s): ${problems.join('; ')}. See .env.sample.`);
  }
}

/**
 * The resolved DJ configuration with defaults applied.
 */
export function getDjConfig() {
  const env = process.env;
  const cap = (name, fallback) => (isSet(name) ? Number(String(env[name]).trim()) : fallback);
  return {
    elevenlabs: {
      apiKey: env.ELEVENLABS_API_KEY,
      voiceId: env.ELEVENLABS_VOICE_ID,
      modelId: isSet('ELEVENLABS_MODEL_ID') ? env.ELEVENLABS_MODEL_ID : 'eleven_flash_v2_5'
    },
    llm: {
      baseUrl: env.DJ_LLM_BASE_URL
        ? String(env.DJ_LLM_BASE_URL).replace(/\/+$/, '')
        : env.DJ_LLM_BASE_URL,
      model: env.DJ_LLM_MODEL,
      apiKey: isSet('DJ_LLM_API_KEY') ? env.DJ_LLM_API_KEY : null
    },
    caps: {
      lines: cap('DJ_DAILY_LINE_CAP', 150),
      themedTracks: cap('DJ_DAILY_THEME_TRACK_CAP', 100)
    }
  };
}
