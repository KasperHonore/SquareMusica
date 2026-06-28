import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Importing the auth middleware transitively pulls in the SQLite-backed db.
// We mock it so the dev-user bypass path returns a deterministic object without
// touching the filesystem or native bindings. The logger is mocked to keep the
// production-misconfiguration warning out of the test output.
vi.mock('../../src/persistence/db.js', () => ({
  db: {
    findOrCreateUser: vi.fn(() => ({ id: 'developer', name: 'Developer' }))
  }
}));
vi.mock('../../src/utils/logger.js', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() }
}));

import { verifyToken } from '../../src/transports/http/middleware/auth.js';

describe('verifyToken developer-mode bypass', () => {
  let savedNodeEnv;
  let savedDeveloperMode;
  let savedDeveloperModeCamel;

  beforeEach(() => {
    savedNodeEnv = process.env.NODE_ENV;
    savedDeveloperMode = process.env.DEVELOPER_MODE;
    savedDeveloperModeCamel = process.env.developerMode;
    delete process.env.NODE_ENV;
    delete process.env.DEVELOPER_MODE;
    delete process.env.developerMode;
  });

  afterEach(() => {
    restore('NODE_ENV', savedNodeEnv);
    restore('DEVELOPER_MODE', savedDeveloperMode);
    restore('developerMode', savedDeveloperModeCamel);
  });

  function restore(key, value) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }

  it('refuses the bypass in production even when DEVELOPER_MODE=true', () => {
    process.env.NODE_ENV = 'production';
    process.env.DEVELOPER_MODE = 'true';

    const result = verifyToken(undefined);

    expect(result.user).toBeUndefined();
    expect(result.error).toBeTruthy();
  });

  it('honours the bypass outside production when DEVELOPER_MODE=true', () => {
    // NODE_ENV deleted in beforeEach -> non-production.
    process.env.DEVELOPER_MODE = 'true';

    const result = verifyToken(undefined);

    expect(result.error).toBeUndefined();
    expect(result.user).toBeDefined();
  });
});
