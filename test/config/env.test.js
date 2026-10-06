import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { validateEnv, validateTimezone } from '../../src/config/env.js';

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

describe('DJ env group (FR-030, FR-031)', () => {
  let env;

  beforeEach(async () => {
    env = await import('../../src/config/env.js');
    for (const name of DJ_VARS) delete process.env[name];
  });

  afterEach(() => {
    for (const name of DJ_VARS) {
      if (saved[name] === undefined) delete process.env[name];
      else process.env[name] = saved[name];
    }
  });

  it('with no DJ vars set, requires nothing and reports unconfigured', () => {
    expect(env.djRequiredVars()).toEqual([]);
    expect(env.isDjConfigured()).toBe(false);
  });

  it('with only ELEVENLABS_API_KEY set, reports the other three in one aggregated error', () => {
    for (const name of REQUIRED) process.env[name] = 'x';
    delete process.env.JWT_SECRET;
    process.env.ELEVENLABS_API_KEY = 'k';

    let message = '';
    try {
      env.validateEnv([...REQUIRED, ...env.djRequiredVars()]);
    } catch (error) {
      message = error.message;
    }

    expect(message).toMatch(
      /Missing required environment variable\(s\): JWT_SECRET, ELEVENLABS_VOICE_ID, DJ_LLM_BASE_URL, DJ_LLM_MODEL\./
    );
    expect(env.isDjConfigured()).toBe(false);
  });

  it('with all four set, is configured and requires all four', () => {
    process.env.ELEVENLABS_API_KEY = 'k';
    process.env.ELEVENLABS_VOICE_ID = 'v';
    process.env.DJ_LLM_BASE_URL = 'http://litellm:4000/v1';
    process.env.DJ_LLM_MODEL = 'm';

    expect(env.djRequiredVars()).toEqual([
      'ELEVENLABS_API_KEY',
      'ELEVENLABS_VOICE_ID',
      'DJ_LLM_BASE_URL',
      'DJ_LLM_MODEL'
    ]);
    expect(env.isDjConfigured()).toBe(true);
  });

  it.each(['0', '-3', '1.5', 'abc'])('rejects DJ_DAILY_LINE_CAP=%s', (value) => {
    process.env.DJ_DAILY_LINE_CAP = value;
    expect(() => env.validateDjFormats()).toThrow(/DJ_DAILY_LINE_CAP/);
  });

  it.each(['0', 'ten'])('rejects DJ_DAILY_THEME_TRACK_CAP=%s', (value) => {
    process.env.DJ_DAILY_THEME_TRACK_CAP = value;
    expect(() => env.validateDjFormats()).toThrow(/DJ_DAILY_THEME_TRACK_CAP/);
  });

  it.each(['ftp://host/v1', 'not a url'])('rejects DJ_LLM_BASE_URL=%s', (value) => {
    process.env.DJ_LLM_BASE_URL = value;
    expect(() => env.validateDjFormats()).toThrow(/DJ_LLM_BASE_URL/);
  });

  it('accepts valid caps and an https base URL', () => {
    process.env.DJ_DAILY_LINE_CAP = '20';
    process.env.DJ_DAILY_THEME_TRACK_CAP = '5';
    process.env.DJ_LLM_BASE_URL = 'https://llm.example.com/v1';
    expect(() => env.validateDjFormats()).not.toThrow();
  });

  it('getDjConfig applies defaults', () => {
    process.env.ELEVENLABS_API_KEY = 'k';
    process.env.ELEVENLABS_VOICE_ID = 'v';
    process.env.DJ_LLM_BASE_URL = 'http://litellm:4000/v1';
    process.env.DJ_LLM_MODEL = 'm';

    expect(env.getDjConfig()).toEqual({
      elevenlabs: { apiKey: 'k', voiceId: 'v', modelId: 'eleven_flash_v2_5' },
      llm: { baseUrl: 'http://litellm:4000/v1', model: 'm', apiKey: null },
      caps: { lines: 150, themedTracks: 100 }
    });
  });
});
