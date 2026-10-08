import { describe, it, expect, afterEach, beforeEach } from 'vitest';
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

const saved = { ...process.env };

afterEach(() => {
  for (const name of REQUIRED) {
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

describe('DJ configuration group (FR-030, R10)', () => {
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
  const savedDj = {};

  beforeEach(() => {
    for (const name of DJ_VARS) {
      savedDj[name] = process.env[name];
      delete process.env[name];
    }
  });

  afterEach(() => {
    for (const name of DJ_VARS) {
      if (savedDj[name] === undefined) delete process.env[name];
      else process.env[name] = savedDj[name];
    }
  });

  it('requires nothing and reports unconfigured when no DJ var is set', () => {
    expect(djRequiredVars()).toEqual([]);
    expect(isDjConfigured()).toBe(false);
  });

  it('reports a partial DJ group in the same aggregated error as other missing vars', () => {
    for (const name of REQUIRED) process.env[name] = 'x';
    delete process.env.JWT_SECRET;
    process.env.ELEVENLABS_API_KEY = 'key';

    let message = '';
    try {
      validateEnv([...REQUIRED, ...djRequiredVars()]);
    } catch (error) {
      message = error.message;
    }
    expect(message).toBe(
      'Missing required environment variable(s): JWT_SECRET, ELEVENLABS_VOICE_ID, ' +
        'DJ_LLM_BASE_URL, DJ_LLM_MODEL. Set them in your .env file (see .env.sample).'
    );
    expect(isDjConfigured()).toBe(false);
  });

  it('is configured when all four group vars are set', () => {
    process.env.ELEVENLABS_API_KEY = 'key';
    process.env.ELEVENLABS_VOICE_ID = 'voice';
    process.env.DJ_LLM_BASE_URL = 'http://litellm:4000';
    process.env.DJ_LLM_MODEL = 'gpt';
    expect(isDjConfigured()).toBe(true);
    expect(djRequiredVars()).toHaveLength(4);
  });

  it.each(['0', '-3', '1.5', 'abc'])('rejects DJ_DAILY_LINE_CAP=%s', (value) => {
    process.env.DJ_DAILY_LINE_CAP = value;
    expect(() => validateDjFormats()).toThrow(/DJ_DAILY_LINE_CAP/);
  });

  it.each(['0', '-1', '2.5', 'many'])('rejects DJ_DAILY_THEME_TRACK_CAP=%s', (value) => {
    process.env.DJ_DAILY_THEME_TRACK_CAP = value;
    expect(() => validateDjFormats()).toThrow(/DJ_DAILY_THEME_TRACK_CAP/);
  });

  it.each(['ftp://host', 'not a url', 'litellm:4000'])('rejects DJ_LLM_BASE_URL=%s', (value) => {
    process.env.DJ_LLM_BASE_URL = value;
    expect(() => validateDjFormats()).toThrow(/DJ_LLM_BASE_URL/);
  });

  it('accepts valid caps and an http(s) base URL, and unset values', () => {
    expect(() => validateDjFormats()).not.toThrow();
    process.env.DJ_DAILY_LINE_CAP = '20';
    process.env.DJ_DAILY_THEME_TRACK_CAP = '7';
    process.env.DJ_LLM_BASE_URL = 'https://proxy.example.com/v1';
    expect(() => validateDjFormats()).not.toThrow();
  });

  it('getDjConfig applies defaults', () => {
    process.env.ELEVENLABS_API_KEY = 'key';
    process.env.ELEVENLABS_VOICE_ID = 'voice';
    process.env.DJ_LLM_BASE_URL = 'http://litellm:4000';
    process.env.DJ_LLM_MODEL = 'gpt';
    expect(getDjConfig()).toEqual({
      elevenlabs: { apiKey: 'key', voiceId: 'voice', modelId: 'eleven_flash_v2_5' },
      llm: { baseUrl: 'http://litellm:4000', model: 'gpt', apiKey: null },
      caps: { lines: 150, themedTracks: 100 }
    });
  });

  it('getDjConfig reads optional overrides', () => {
    process.env.DJ_LLM_API_KEY = 'sk';
    process.env.ELEVENLABS_MODEL_ID = 'eleven_turbo';
    process.env.DJ_DAILY_LINE_CAP = '10';
    process.env.DJ_DAILY_THEME_TRACK_CAP = '20';
    const cfg = getDjConfig();
    expect(cfg.llm.apiKey).toBe('sk');
    expect(cfg.elevenlabs.modelId).toBe('eleven_turbo');
    expect(cfg.caps).toEqual({ lines: 10, themedTracks: 20 });
  });
});
