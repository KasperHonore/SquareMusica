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

function restoreDjVars() {
  for (const name of DJ_VARS) {
    if (saved[name] === undefined) delete process.env[name];
    else process.env[name] = saved[name];
  }
}

function setFullDjGroup() {
  process.env.ELEVENLABS_API_KEY = 'k';
  process.env.ELEVENLABS_VOICE_ID = 'v';
  process.env.DJ_LLM_BASE_URL = 'http://litellm:4000/v1';
  process.env.DJ_LLM_MODEL = 'm';
}

describe('DJ configuration group (FR-030, FR-031, R10)', () => {
  beforeEach(() => {
    for (const name of DJ_VARS) delete process.env[name];
  });
  afterEach(restoreDjVars);

  it('with no DJ vars requires nothing extra and reports unconfigured', () => {
    expect(djRequiredVars()).toEqual([]);
    expect(isDjConfigured()).toBe(false);
  });

  it('a partial DJ group is reported in ONE aggregated error with the base vars', () => {
    for (const name of REQUIRED) process.env[name] = 'x';
    delete process.env.JWT_SECRET;
    process.env.ELEVENLABS_API_KEY = 'k';

    let message = '';
    try {
      validateEnv([...REQUIRED, ...djRequiredVars()]);
    } catch (error) {
      message = error.message;
    }
    expect(message).toMatch(/Missing required environment variable\(s\):/);
    for (const name of ['JWT_SECRET', 'ELEVENLABS_VOICE_ID', 'DJ_LLM_BASE_URL', 'DJ_LLM_MODEL']) {
      expect(message).toContain(name);
    }
    expect(message).not.toContain('ELEVENLABS_API_KEY');
    expect(isDjConfigured()).toBe(false);
  });

  it('a full DJ group is configured and passes validation', () => {
    setFullDjGroup();
    expect(djRequiredVars()).toEqual([
      'ELEVENLABS_API_KEY',
      'ELEVENLABS_VOICE_ID',
      'DJ_LLM_BASE_URL',
      'DJ_LLM_MODEL'
    ]);
    expect(isDjConfigured()).toBe(true);
    expect(() => validateDjFormats()).not.toThrow();
  });

  it.each(['0', '-3', '1.5', 'abc'])('rejects DJ_DAILY_LINE_CAP=%s', (value) => {
    setFullDjGroup();
    process.env.DJ_DAILY_LINE_CAP = value;
    expect(() => validateDjFormats()).toThrow(/DJ_DAILY_LINE_CAP/);
  });

  it.each(['0', '-1', '2.5', 'many'])('rejects DJ_DAILY_THEME_TRACK_CAP=%s', (value) => {
    setFullDjGroup();
    process.env.DJ_DAILY_THEME_TRACK_CAP = value;
    expect(() => validateDjFormats()).toThrow(/DJ_DAILY_THEME_TRACK_CAP/);
  });

  it.each(['ftp://host/v1', 'not a url', 'litellm:4000'])('rejects DJ_LLM_BASE_URL=%s', (value) => {
    setFullDjGroup();
    process.env.DJ_LLM_BASE_URL = value;
    expect(() => validateDjFormats()).toThrow(/DJ_LLM_BASE_URL/);
  });

  it('getDjConfig applies defaults and reads overrides', () => {
    setFullDjGroup();
    expect(getDjConfig()).toEqual({
      elevenlabs: { apiKey: 'k', voiceId: 'v', modelId: 'eleven_flash_v2_5' },
      llm: { baseUrl: 'http://litellm:4000/v1', model: 'm', apiKey: null },
      caps: { lines: 150, themedTracks: 100 }
    });

    process.env.DJ_LLM_API_KEY = 'secret';
    process.env.ELEVENLABS_MODEL_ID = 'eleven_turbo_v2_5';
    process.env.DJ_DAILY_LINE_CAP = '20';
    process.env.DJ_DAILY_THEME_TRACK_CAP = '30';
    expect(getDjConfig()).toEqual({
      elevenlabs: { apiKey: 'k', voiceId: 'v', modelId: 'eleven_turbo_v2_5' },
      llm: { baseUrl: 'http://litellm:4000/v1', model: 'm', apiKey: 'secret' },
      caps: { lines: 20, themedTracks: 30 }
    });
  });
});
