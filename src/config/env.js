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

// The AI DJ needs all four of these or none of them (FR-030, R10).
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
 * The DJ variables to add to the validateEnv() list. If ANY of the group is set,
 * all four are required, so a partial DJ config is reported in the same single
 * aggregated error as every other missing variable. If none is set, the DJ is
 * simply off and nothing extra is required.
 *
 * @returns {string[]}
 */
export function djRequiredVars() {
  return DJ_GROUP_VARS.some(isSet) ? [...DJ_GROUP_VARS] : [];
}

/**
 * @returns {boolean} True when all four DJ group variables are set
 */
export function isDjConfigured() {
  return DJ_GROUP_VARS.every(isSet);
}

/**
 * Check the formats of the DJ variables that are set. Caps must be positive
 * integers and the LLM base URL must be http(s). Collects every problem into one
 * error, like validateEnv().
 *
 * @throws {Error} If any set DJ variable has an invalid format
 */
export function validateDjFormats() {
  const problems = [];

  for (const name of ['DJ_DAILY_LINE_CAP', 'DJ_DAILY_THEME_TRACK_CAP']) {
    if (!isSet(name)) continue;
    const raw = String(process.env[name]).trim();
    if (!/^\d+$/.test(raw) || Number(raw) < 1) {
      problems.push(`${name}="${raw}" must be a positive whole number`);
    }
  }

  if (isSet('DJ_LLM_BASE_URL')) {
    const raw = String(process.env.DJ_LLM_BASE_URL).trim();
    let protocol = null;
    try {
      protocol = new URL(raw).protocol;
    } catch {
      // Falls through to the problem below.
    }
    if (protocol !== 'http:' && protocol !== 'https:') {
      problems.push(`DJ_LLM_BASE_URL="${raw}" must be an http(s) URL`);
    }
  }

  if (problems.length > 0) {
    throw new Error(`Invalid environment variable(s): ${problems.join('; ')}. See .env.sample.`);
  }
}

function capOrDefault(name, fallback) {
  return isSet(name) ? Number(String(process.env[name]).trim()) : fallback;
}

/**
 * The DJ configuration, with defaults applied. Read at call time, so it reflects
 * the environment validated at boot.
 *
 * @returns {{
 *   elevenlabs: { apiKey: string, voiceId: string, modelId: string },
 *   llm: { baseUrl: string, model: string, apiKey: string|null },
 *   caps: { lines: number, themedTracks: number }
 * }}
 */
export function getDjConfig() {
  return {
    elevenlabs: {
      apiKey: process.env.ELEVENLABS_API_KEY,
      voiceId: process.env.ELEVENLABS_VOICE_ID,
      modelId: isSet('ELEVENLABS_MODEL_ID') ? process.env.ELEVENLABS_MODEL_ID : 'eleven_flash_v2_5'
    },
    llm: {
      baseUrl: process.env.DJ_LLM_BASE_URL,
      model: process.env.DJ_LLM_MODEL,
      apiKey: isSet('DJ_LLM_API_KEY') ? process.env.DJ_LLM_API_KEY : null
    },
    caps: {
      lines: capOrDefault('DJ_DAILY_LINE_CAP', 150),
      themedTracks: capOrDefault('DJ_DAILY_THEME_TRACK_CAP', 100)
    }
  };
}
