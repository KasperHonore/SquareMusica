import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import express from 'express';

// djService is mocked so the router mounts without the db or the mediator, and
// each test controls exactly what the service returns or throws. The auth mock
// can reject, so the 401 path is exercised rather than assumed.
const { authState, djMock } = vi.hoisted(() => ({
  authState: { mode: 'allow', user: null },
  djMock: { getState: null, getStateOrUnavailable: null, setSettings: null }
}));

vi.mock('../../../src/transports/http/middleware/auth.js', () => ({
  authMiddleware: (req, res, next) => {
    if (authState.mode === 'reject') {
      return res.status(401).json({ error: 'Authentication required' });
    }
    req.user = authState.user ?? { username: 'tester', discord_id: 'self-1' };
    next();
  },
  optionalAuth: (req, _res, next) => next()
}));
vi.mock('../../../src/services/dj/djService.js', () => ({
  getState: (...a) => djMock.getState(...a),
  getStateOrUnavailable: (...a) => djMock.getStateOrUnavailable(...a),
  setSettings: (...a) => djMock.setSettings(...a)
}));
vi.mock('../../../src/utils/logger.js', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() }
}));

import djRouter from '../../../src/transports/http/routes/dj.js';
import {
  DjError,
  DJ_UNAVAILABLE,
  INVALID_INTERVAL,
  INVALID_LOOKAHEAD
} from '../../../src/services/dj/errors.js';
import { DJ_MESSAGES } from '../../../src/services/dj/messages.js';

function djState(overrides = {}) {
  return {
    available: true,
    enabled: false,
    interval: 3,
    lookahead: 5,
    health: 'ok',
    caps: {
      lines: { used: 0, limit: 150, reached: false },
      themedTracks: { used: 0, limit: 100, reached: false },
      resetsAt: '2026-10-09T00:00:00+02:00'
    },
    theme: null,
    ...overrides
  };
}

let server;
let baseUrl;
let current;

function get() {
  return fetch(`${baseUrl}/api/dj`);
}

function patch(body, raw = false) {
  return fetch(`${baseUrl}/api/dj`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: raw ? body : JSON.stringify(body)
  });
}

beforeEach(async () => {
  authState.mode = 'allow';
  authState.user = null;
  current = djState();
  djMock.getState = vi.fn(() => current);
  djMock.getStateOrUnavailable = vi.fn(() => current);
  djMock.setSettings = vi.fn((partial) => {
    current = { ...current, ...partial };
    return current;
  });

  const app = express();
  app.use(express.json());
  app.use('/api/dj', djRouter);
  server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

afterEach(async () => {
  await new Promise((resolve) => server.close(resolve));
});

describe('/api/dj authentication', () => {
  it('rejects GET without a session', async () => {
    authState.mode = 'reject';
    const res = await get();
    expect(res.status).toBe(401);
  });

  it('rejects PATCH without a session and never calls the service', async () => {
    authState.mode = 'reject';
    const res = await patch({ enabled: true });
    expect(res.status).toBe(401);
    expect(djMock.setSettings).not.toHaveBeenCalled();
  });
});

describe('GET /api/dj', () => {
  it('returns the DjState', async () => {
    const res = await get();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(djState());
  });

  it('returns { available: false } when the DJ is not configured', async () => {
    djMock.getStateOrUnavailable.mockReturnValue({ available: false });
    const res = await get();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ available: false });
  });
});

describe('PATCH /api/dj', () => {
  it.each([
    [{ enabled: true }],
    [{ interval: 4 }],
    [{ lookahead: 10 }],
    [{ enabled: true, interval: 7 }],
    [{ enabled: false, interval: 2, lookahead: 10 }]
  ])('passes %j to setSettings once and returns the new state', async (body) => {
    const res = await patch(body);

    expect(res.status).toBe(200);
    expect(djMock.setSettings).toHaveBeenCalledTimes(1);
    expect(djMock.setSettings).toHaveBeenCalledWith(body, { id: 'self-1', name: 'tester' });
    expect(await res.json()).toEqual(djState(body));
  });

  it('passes the JWT user as the actor', async () => {
    authState.user = { username: 'Kasper', discord_id: '123' };
    await patch({ enabled: true });
    expect(djMock.setSettings).toHaveBeenCalledWith(
      { enabled: true },
      { id: '123', name: 'Kasper' }
    );
  });

  it('ignores keys that are not DJ settings', async () => {
    await patch({ interval: 5, theme: 'x', available: false });
    expect(djMock.setSettings).toHaveBeenCalledWith({ interval: 5 }, expect.any(Object));
  });

  it('rejects a body that is not an object', async () => {
    const res = await patch('[1,2]', true);
    expect(res.status).toBe(400);
    expect(djMock.setSettings).not.toHaveBeenCalled();
  });

  it('rejects a non-boolean enabled without calling the service', async () => {
    const res = await patch({ enabled: 'yes' });
    expect(res.status).toBe(400);
    expect(djMock.setSettings).not.toHaveBeenCalled();
  });
});

describe('PATCH /api/dj error mapping (contracts §2)', () => {
  it.each([
    [DJ_UNAVAILABLE, 503, "The DJ isn't set up on this server."],
    [INVALID_INTERVAL, 400, 'Interval must be a whole number from 1 to 10.'],
    [INVALID_LOOKAHEAD, 400, 'Lookahead must be 5 or 10.']
  ])('maps %s to HTTP %i with { code, message }', async (code, status, message) => {
    djMock.setSettings.mockImplementation(() => {
      throw new DjError(code, 'service text');
    });

    const res = await patch({ interval: 4 });

    expect(res.status).toBe(status);
    expect(await res.json()).toEqual({ code, message });
    expect(DJ_MESSAGES[code]).toEqual({ http: status, text: message });
  });

  it('PATCH {"interval": 11} is rejected and the state is unchanged (US2/AC3)', async () => {
    // The real validation lives in djService; model it here so the route is
    // shown to return its error and nothing else.
    djMock.setSettings.mockImplementation((partial) => {
      if (partial.interval > 10) {
        throw new DjError(INVALID_INTERVAL);
      }
      current = { ...current, ...partial };
      return current;
    });

    const res = await patch({ interval: 11 });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe('INVALID_INTERVAL');
    expect(body.message).toMatch(/1 to 10/);
    expect(await (await get()).json()).toEqual(djState());
  });

  it('returns 500 on an unexpected error', async () => {
    djMock.setSettings.mockImplementation(() => {
      throw new Error('boom');
    });
    const res = await patch({ interval: 4 });
    expect(res.status).toBe(500);
  });
});
