import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// authMiddleware/optionalAuth transitively import the SQLite-backed db and the
// jsonwebtoken lib. We mock both so token verification is deterministic and no
// native binding is touched. The logger mock keeps the prod-misconfig warning
// out of the test output.
vi.mock('../../src/persistence/db.js', () => ({
  db: {
    findOrCreateUser: vi.fn(() => ({ id: 'developer', name: 'Developer' })),
    getSessionByToken: vi.fn(),
    getUserById: vi.fn()
  }
}));
vi.mock('jsonwebtoken', () => ({
  default: { verify: vi.fn() }
}));
vi.mock('../../src/utils/logger.js', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() }
}));

import jwt from 'jsonwebtoken';
import { db } from '../../src/persistence/db.js';
import { authMiddleware, optionalAuth } from '../../src/transports/http/middleware/auth.js';

function makeRes() {
  return {
    status: vi.fn().mockReturnThis(),
    json: vi.fn().mockReturnThis()
  };
}

describe('authMiddleware', () => {
  let savedNodeEnv;
  let savedDevMode;
  let savedDevModeCamel;

  beforeEach(() => {
    vi.clearAllMocks();
    // Disable the developer-mode bypass so the real token path is exercised.
    savedNodeEnv = process.env.NODE_ENV;
    savedDevMode = process.env.DEVELOPER_MODE;
    savedDevModeCamel = process.env.developerMode;
    delete process.env.NODE_ENV;
    delete process.env.DEVELOPER_MODE;
    delete process.env.developerMode;
    process.env.JWT_SECRET = 'test-secret';
  });

  afterEach(() => {
    restore('NODE_ENV', savedNodeEnv);
    restore('DEVELOPER_MODE', savedDevMode);
    restore('developerMode', savedDevModeCamel);
  });

  function restore(key, value) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }

  it('sets req.user and calls next() for a valid token cookie', () => {
    const user = { id: 'u1', username: 'alice' };
    jwt.verify.mockReturnValue({ sub: 'u1' });
    db.getSessionByToken.mockReturnValue({ user_id: 'u1' });
    db.getUserById.mockReturnValue(user);

    const req = { cookies: { token: 'good-token' }, headers: {} };
    const res = makeRes();
    const next = vi.fn();

    authMiddleware(req, res, next);

    expect(req.user).toEqual(user);
    expect(req.token).toBe('good-token');
    expect(next).toHaveBeenCalledTimes(1);
    expect(res.status).not.toHaveBeenCalled();
  });

  it('reads the token from the Authorization header when no cookie is present', () => {
    const user = { id: 'u2', username: 'bob' };
    jwt.verify.mockReturnValue({ sub: 'u2' });
    db.getSessionByToken.mockReturnValue({ user_id: 'u2' });
    db.getUserById.mockReturnValue(user);

    const req = { cookies: {}, headers: { authorization: 'Bearer header-token' } };
    const res = makeRes();
    const next = vi.fn();

    authMiddleware(req, res, next);

    expect(req.user).toEqual(user);
    expect(req.token).toBe('header-token');
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('returns 401 when no token is provided', () => {
    const req = { cookies: {}, headers: {} };
    const res = makeRes();
    const next = vi.fn();

    authMiddleware(req, res, next);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith({ error: 'Authentication required' });
    expect(next).not.toHaveBeenCalled();
    expect(req.user).toBeUndefined();
  });

  it('returns 401 when the token fails verification', () => {
    jwt.verify.mockImplementation(() => {
      throw new Error('bad signature');
    });

    const req = { cookies: { token: 'tampered' }, headers: {} };
    const res = makeRes();
    const next = vi.fn();

    authMiddleware(req, res, next);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith({ error: 'Invalid token' });
    expect(next).not.toHaveBeenCalled();
    // db lookups never happen once verification throws.
    expect(db.getSessionByToken).not.toHaveBeenCalled();
  });

  it('returns 401 when the token is valid but the session is gone', () => {
    jwt.verify.mockReturnValue({ sub: 'u1' });
    db.getSessionByToken.mockReturnValue(undefined);

    const req = { cookies: { token: 'expired' }, headers: {} };
    const res = makeRes();
    const next = vi.fn();

    authMiddleware(req, res, next);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith({ error: 'Session expired' });
    expect(next).not.toHaveBeenCalled();
  });
});

describe('optionalAuth', () => {
  let savedNodeEnv;
  let savedDevMode;
  let savedDevModeCamel;

  beforeEach(() => {
    vi.clearAllMocks();
    savedNodeEnv = process.env.NODE_ENV;
    savedDevMode = process.env.DEVELOPER_MODE;
    savedDevModeCamel = process.env.developerMode;
    delete process.env.NODE_ENV;
    delete process.env.DEVELOPER_MODE;
    delete process.env.developerMode;
    process.env.JWT_SECRET = 'test-secret';
  });

  afterEach(() => {
    restore('NODE_ENV', savedNodeEnv);
    restore('DEVELOPER_MODE', savedDevMode);
    restore('developerMode', savedDevModeCamel);
  });

  function restore(key, value) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }

  it('attaches req.user when a valid token is present', () => {
    const user = { id: 'u1', username: 'alice' };
    jwt.verify.mockReturnValue({ sub: 'u1' });
    db.getSessionByToken.mockReturnValue({ user_id: 'u1' });
    db.getUserById.mockReturnValue(user);

    const req = { cookies: { token: 'good-token' }, headers: {} };
    const res = makeRes();
    const next = vi.fn();

    optionalAuth(req, res, next);

    expect(req.user).toEqual(user);
    expect(next).toHaveBeenCalledTimes(1);
    expect(res.status).not.toHaveBeenCalled();
  });

  it('calls next() without a user when no token is present', () => {
    const req = { cookies: {}, headers: {} };
    const res = makeRes();
    const next = vi.fn();

    optionalAuth(req, res, next);

    expect(req.user).toBeUndefined();
    expect(next).toHaveBeenCalledTimes(1);
    expect(res.status).not.toHaveBeenCalled();
  });

  it('calls next() without a user when the token is invalid (never blocks the request)', () => {
    jwt.verify.mockImplementation(() => {
      throw new Error('bad token');
    });

    const req = { cookies: { token: 'bad' }, headers: {} };
    const res = makeRes();
    const next = vi.fn();

    optionalAuth(req, res, next);

    expect(req.user).toBeUndefined();
    expect(next).toHaveBeenCalledTimes(1);
    expect(res.status).not.toHaveBeenCalled();
  });
});
