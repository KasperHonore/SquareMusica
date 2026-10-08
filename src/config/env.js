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

const DJ_DEFAULT_ELEVENLABS_MODEL = 'eleven_flash_v2_5';
const DJ_DEFAULT_LINE_CAP = 150;
const DJ_DEFAULT_THEME_TRACK_CAP = 100;

function isSet(name) {
  const value = process.env[name];
  return value !== undefined && value !== null && String(value).trim() !== '';
}

/**
 * Names of DJ variables that must be present. If ANY of the DJ group is set,
 * all four are required, so src/index.js can append them to the list it passes
 * to validateEnv and a partial DJ config lands in the same aggregated error.
 *
 * @returns {string[]}
 */
export function djRequiredVars() {
  return DJ_GROUP_VARS.some(isSet) ? [...DJ_GROUP_VARS] : [];
}

/**
 * @returns {boolean} True when the whole DJ group is set.
 */
export function isDjConfigured() {
  return DJ_GROUP_VARS.every(isSet);
}

function parsePositiveInt(name, fallback) {
  if (!isSet(name)) return fallback;
  const raw = String(process.env[name]).trim();
  if (!/^\d+$/.test(raw) || Number(raw) < 1) return null;
  return Number(raw);
}

/**
 * Validate the formats of the DJ variables. Only meaningful once the group is
 * present; does nothing when the DJ is unconfigured.
 *
 * @throws {Error} Listing every malformed DJ variable
 */
export function validateDjFormats() {
  if (!isDjConfigured()) return;

  const problems = [];
  for (const name of ['DJ_DAILY_LINE_CAP', 'DJ_DAILY_THEME_TRACK_CAP']) {
    if (parsePositiveInt(name, 1) === null) {
      problems.push(`${name}="${process.env[name]}" must be a positive whole number`);
    }
  }

  const baseUrl = process.env.DJ_LLM_BASE_URL;
  let protocol = null;
  try {
    protocol = new URL(baseUrl).protocol;
  } catch {
    // Reported below.
  }
  if (protocol !== 'http:' && protocol !== 'https:') {
    problems.push(`DJ_LLM_BASE_URL="${baseUrl}" must be an http(s) URL`);
  }

  if (problems.length > 0) {
    throw new Error(`Invalid DJ configuration: ${problems.join('; ')}. See .env.sample.`);
  }
}

/**
 * Resolved DJ configuration with defaults applied. Call only after
 * validateDjFormats() has passed.
 */
export function getDjConfig() {
  return {
    elevenlabs: {
      apiKey: process.env.ELEVENLABS_API_KEY,
      voiceId: process.env.ELEVENLABS_VOICE_ID,
      modelId: isSet('ELEVENLABS_MODEL_ID')
        ? process.env.ELEVENLABS_MODEL_ID
        : DJ_DEFAULT_ELEVENLABS_MODEL
    },
    llm: {
      baseUrl: process.env.DJ_LLM_BASE_URL,
      model: process.env.DJ_LLM_MODEL,
      apiKey: isSet('DJ_LLM_API_KEY') ? process.env.DJ_LLM_API_KEY : null
    },
    caps: {
      lines: parsePositiveInt('DJ_DAILY_LINE_CAP', DJ_DEFAULT_LINE_CAP),
      themedTracks: parsePositiveInt('DJ_DAILY_THEME_TRACK_CAP', DJ_DEFAULT_THEME_TRACK_CAP)
    }
  };
}
