import { describe, it, expect, afterEach } from 'vitest';
import {
  validateEnv,
  validateTimezone,
  djRequiredVars,
  isDjConfigured,
  validateDjFormats,
  getDjConfig,
  DJ_GROUP_VARS
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

const saved = { ...process.env };

const DJ_VARS = [
  ...DJ_GROUP_VARS,
  'DJ_LLM_API_KEY',
  'ELEVENLABS_MODEL_ID',
  'DJ_DAILY_LINE_CAP',
  'DJ_DAILY_THEME_TRACK_CAP'
];

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

describe('DJ env group (R10, FR-030/FR-031)', () => {
  function clearDj() {
    for (const name of DJ_VARS) delete process.env[name];
  }
  function setAllDj() {
    process.env.ELEVENLABS_API_KEY = 'k';
    process.env.ELEVENLABS_VOICE_ID = 'v';
    process.env.DJ_LLM_BASE_URL = 'http://litellm:4000/v1';
    process.env.DJ_LLM_MODEL = 'm';
  }

  it('with no DJ vars requires nothing and is not configured', () => {
    clearDj();
    expect(djRequiredVars()).toEqual([]);
    expect(isDjConfigured()).toBe(false);
  });

  it('with only ELEVENLABS_API_KEY reports the other three in ONE aggregated error', () => {
    clearDj();
    for (const name of REQUIRED) process.env[name] = 'x';
    delete process.env.JWT_SECRET;
    process.env.ELEVENLABS_API_KEY = 'k';

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
  });

  it('is configured when all four are set', () => {
    clearDj();
    setAllDj();
    expect(djRequiredVars()).toEqual(DJ_GROUP_VARS);
    expect(isDjConfigured()).toBe(true);
    expect(() => validateDjFormats()).not.toThrow();
  });

  it.each(['0', '-3', '1.5', 'abc'])('rejects DJ_DAILY_LINE_CAP=%s', (value) => {
    clearDj();
    setAllDj();
    process.env.DJ_DAILY_LINE_CAP = value;
    expect(() => validateDjFormats()).toThrow(/DJ_DAILY_LINE_CAP/);
  });

  it('rejects a non-positive-integer DJ_DAILY_THEME_TRACK_CAP', () => {
    clearDj();
    setAllDj();
    process.env.DJ_DAILY_THEME_TRACK_CAP = '0';
    expect(() => validateDjFormats()).toThrow(/DJ_DAILY_THEME_TRACK_CAP/);
  });

  it.each(['ftp://host/v1', 'not a url', 'litellm:4000'])('rejects DJ_LLM_BASE_URL=%s', (url) => {
    clearDj();
    setAllDj();
    process.env.DJ_LLM_BASE_URL = url;
    expect(() => validateDjFormats()).toThrow(/DJ_LLM_BASE_URL/);
  });

  it('getDjConfig applies defaults and reads overrides', () => {
    clearDj();
    setAllDj();
    expect(getDjConfig()).toEqual({
      elevenlabs: { apiKey: 'k', voiceId: 'v', modelId: 'eleven_flash_v2_5' },
      llm: { baseUrl: 'http://litellm:4000/v1', model: 'm', apiKey: null },
      caps: { lines: 150, themedTracks: 100 }
    });

    process.env.DJ_LLM_API_KEY = 'secret';
    process.env.ELEVENLABS_MODEL_ID = 'eleven_turbo';
    process.env.DJ_DAILY_LINE_CAP = '20';
    process.env.DJ_DAILY_THEME_TRACK_CAP = '30';
    const config = getDjConfig();
    expect(config.llm.apiKey).toBe('secret');
    expect(config.elevenlabs.modelId).toBe('eleven_turbo');
    expect(config.caps).toEqual({ lines: 20, themedTracks: 30 });
  });
});
