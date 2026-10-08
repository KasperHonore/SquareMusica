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
 * The AI DJ env group (research R10). Optional as a whole, but all four or none:
 * a partial group is a startup error.
 */
export const DJ_GROUP_VARS = [
  'ELEVENLABS_API_KEY',
  'ELEVENLABS_VOICE_ID',
  'DJ_LLM_BASE_URL',
  'DJ_LLM_MODEL'
];

const DEFAULT_ELEVENLABS_MODEL_ID = 'eleven_flash_v2_5';
const DEFAULT_DJ_DAILY_LINE_CAP = 150;
const DEFAULT_DJ_DAILY_THEME_TRACK_CAP = 100;

function isSet(name) {
  const value = process.env[name];
  return value !== undefined && value !== null && String(value).trim() !== '';
}

/**
 * Names of the DJ vars that must be present. If ANY group var is set, all four
 * are returned, so src/index.js can append them to its validateEnv() list and a
 * partial group is reported in the same single aggregated error as every other
 * missing variable. Returns [] when none is set (DJ simply not configured).
 *
 * @returns {string[]}
 */
export function djRequiredVars() {
  return DJ_GROUP_VARS.some(isSet) ? [...DJ_GROUP_VARS] : [];
}

/**
 * @returns {boolean} True when all four DJ group vars are set.
 */
export function isDjConfigured() {
  return DJ_GROUP_VARS.every(isSet);
}

/**
 * Validate the formats of the DJ vars that are set: the daily caps must be
 * positive integers and DJ_LLM_BASE_URL must be an http(s) URL. Unset optional
 * vars are fine (their defaults apply).
 *
 * @throws {Error} Naming every offending variable
 */
export function validateDjFormats() {
  const problems = [];

  for (const name of ['DJ_DAILY_LINE_CAP', 'DJ_DAILY_THEME_TRACK_CAP']) {
    if (!isSet(name)) continue;
    const raw = String(process.env[name]).trim();
    if (!/^\d+$/.test(raw) || Number(raw) < 1) {
      problems.push(`${name}="${raw}" must be a positive integer`);
    }
  }

  if (isSet('DJ_LLM_BASE_URL')) {
    const raw = String(process.env.DJ_LLM_BASE_URL).trim();
    let protocol = null;
    try {
      protocol = new URL(raw).protocol;
    } catch {
      protocol = null;
    }
    if (protocol !== 'http:' && protocol !== 'https:') {
      problems.push(`DJ_LLM_BASE_URL="${raw}" must be an http:// or https:// URL`);
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
 * DJ configuration read from the environment, with defaults applied. Only
 * meaningful when isDjConfigured() is true.
 */
export function getDjConfig() {
  const env = process.env;
  return {
    elevenlabs: {
      apiKey: env.ELEVENLABS_API_KEY,
      voiceId: env.ELEVENLABS_VOICE_ID,
      modelId: isSet('ELEVENLABS_MODEL_ID') ? env.ELEVENLABS_MODEL_ID : DEFAULT_ELEVENLABS_MODEL_ID
    },
    llm: {
      baseUrl: env.DJ_LLM_BASE_URL,
      model: env.DJ_LLM_MODEL,
      apiKey: isSet('DJ_LLM_API_KEY') ? env.DJ_LLM_API_KEY : null
    },
    caps: {
      lines: capOrDefault('DJ_DAILY_LINE_CAP', DEFAULT_DJ_DAILY_LINE_CAP),
      themedTracks: capOrDefault('DJ_DAILY_THEME_TRACK_CAP', DEFAULT_DJ_DAILY_THEME_TRACK_CAP)
    }
  };
}
