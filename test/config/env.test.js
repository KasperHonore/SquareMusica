import { describe, it, expect, afterEach } from 'vitest';
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
