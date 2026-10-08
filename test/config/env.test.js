import { describe, it, expect, afterEach } from 'vitest';
import {
  validateEnv,
  validateTimezone,
  djRequiredVars,
  isDjConfigured,
  validateDjFormats,
  getDjConfig
} from '../../src/config/env.js';

// Mirrors the list src/index.js validates at startup.
const REQUIRED = [
  'DISCORD_TOKEN',
  'APP_ID',
  'GUILD_ID',
  'DISCORD_CLIENT_SECRET',
  'JWT_SECRET',
  'OAUTH_REDIRECT_URI',
  'TZ'
];

const DJ_VARS = [
  'ELEVENLABS_API_KEY',
  'ELEVENLABS_VOICE_ID',
  'DJ_LLM_BASE_URL',
  'DJ_LLM_MODEL',
  'DJ_LLM_API_KEY',
  'ELEVENLABS_MODEL_ID',
  'DJ_DAILY_LINE_CAP',
  'DJ_DAILY_THEME_TRACK_CAP'
];

const saved = { ...process.env };

afterEach(() => {
  for (const name of [...REQUIRED, ...DJ_VARS]) {
    if (saved[name] === undefined) delete process.env[name];
    else process.env[name] = saved[name];
  }
});

describe('validateEnv with TZ required (FR-030)', () => {
  it('reports a missing TZ in the same aggregated error as other missing variables', () => {
    for (const name of REQUIRED) process.env[name] = 'x';
    delete process.env.TZ;
    delete process.env.JWT_SECRET;

    expect(() => validateEnv(REQUIRED)).toThrow(
      /Missing required environment variable\(s\): JWT_SECRET, TZ\./
    );
  });

  it('treats an empty TZ as missing', () => {
    for (const name of REQUIRED) process.env[name] = 'x';
    process.env.TZ = '  ';

    expect(() => validateEnv(REQUIRED)).toThrow(/: TZ\./);
  });
});

describe('validateTimezone (FR-030)', () => {
  it('rejects an unknown zone with a message naming TZ and its value', () => {
    process.env.TZ = 'Bogus/Zone';

    expect(() => validateTimezone()).toThrow(/TZ="Bogus\/Zone"/);
  });

  it('accepts Europe/Copenhagen', () => {
    process.env.TZ = 'Europe/Copenhagen';

    expect(() => validateTimezone()).not.toThrow();
  });
});

describe('DJ env group (FR-030, FR-031, R10)', () => {
  function clearDj() {
    for (const name of DJ_VARS) delete process.env[name];
  }

  it('with no DJ vars set, requires nothing and reports unconfigured', () => {
    clearDj();

    expect(djRequiredVars()).toEqual([]);
    expect(isDjConfigured()).toBe(false);
  });

  it('a partial DJ group is reported in ONE aggregated error with other missing vars', () => {
    clearDj();
    for (const name of REQUIRED) process.env[name] = 'x';
    delete process.env.JWT_SECRET;
    process.env.ELEVENLABS_API_KEY = 'key';

    expect(isDjConfigured()).toBe(false);
    let message = '';
    try {
      validateEnv([...REQUIRED, ...djRequiredVars()]);
    } catch (error) {
      message = error.message;
    }
    expect(message).toMatch(/^Missing required environment variable\(s\): /);
    for (const name of ['JWT_SECRET', 'ELEVENLABS_VOICE_ID', 'DJ_LLM_BASE_URL', 'DJ_LLM_MODEL']) {
      expect(message).toContain(name);
    }
    expect(message).not.toContain('ELEVENLABS_API_KEY');
    expect(message.match(/Missing required/g)).toHaveLength(1);
  });

  it('all four group vars set means configured, with defaults for the optional ones', () => {
    clearDj();
    process.env.ELEVENLABS_API_KEY = 'key';
    process.env.ELEVENLABS_VOICE_ID = 'voice';
    process.env.DJ_LLM_BASE_URL = 'http://litellm:4000/v1';
    process.env.DJ_LLM_MODEL = 'gpt-x';

    expect(djRequiredVars()).toHaveLength(4);
    expect(isDjConfigured()).toBe(true);
    expect(getDjConfig()).toEqual({
      elevenlabs: { apiKey: 'key', voiceId: 'voice', modelId: 'eleven_flash_v2_5' },
      llm: { baseUrl: 'http://litellm:4000/v1', model: 'gpt-x', apiKey: null },
      caps: { lines: 150, themedTracks: 100 }
    });
  });

  it('validateDjFormats rejects a non-positive-integer line cap', () => {
    clearDj();
    for (const bad of ['0', '-3', '1.5', 'abc']) {
      process.env.DJ_DAILY_LINE_CAP = bad;
      expect(() => validateDjFormats()).toThrow(/DJ_DAILY_LINE_CAP/);
    }
  });

  it('validateDjFormats rejects a non-positive-integer themed-track cap', () => {
    clearDj();
    process.env.DJ_DAILY_THEME_TRACK_CAP = '0';
    expect(() => validateDjFormats()).toThrow(/DJ_DAILY_THEME_TRACK_CAP/);
  });

  it('validateDjFormats rejects a base URL that is not http(s)', () => {
    clearDj();
    for (const bad of ['ftp://host/v1', 'not a url']) {
      process.env.DJ_LLM_BASE_URL = bad;
      expect(() => validateDjFormats()).toThrow(/DJ_LLM_BASE_URL/);
    }
  });

  it('validateDjFormats accepts valid values and unset optionals', () => {
    clearDj();
    expect(() => validateDjFormats()).not.toThrow();
    process.env.DJ_LLM_BASE_URL = 'https://proxy.example/v1';
    process.env.DJ_DAILY_LINE_CAP = '20';
    process.env.DJ_DAILY_THEME_TRACK_CAP = '5';
    expect(() => validateDjFormats()).not.toThrow();
  });
});
