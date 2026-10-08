import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import express from 'express';

// The DJ router is a thin adapter over djService (contracts §3), so the service
// is mocked and each case asserts the call made and how its DjError codes map to
// HTTP (contracts §2). The auth mock can reject, as in stats.test.js: the 401 is
// the only thing keeping the settings off the open internet.
const { authState, service } = vi.hoisted(() => ({
  authState: { mode: 'allow', user: null },
  service: { getStateOrUnavailable: null, setSettings: null }
}));

vi.mock('../../../src/transports/http/middleware/auth.js', () => ({
  authMiddleware: (req, res, next) => {
    if (authState.mode === 'reject') {
      return res.status(401).json({ error: 'Authentication required' });
    }
    req.user = authState.user ?? { username: 'tester', discord_id: 'self-1' };
    next();
  },
  optionalAuth: (req, _res, next) => {
    req.user = authState.user ?? { username: 'tester', discord_id: 'self-1' };
    next();
  }
}));
vi.mock('../../../src/services/dj/djService.js', () => ({
  getStateOrUnavailable: (...args) => service.getStateOrUnavailable(...args),
  setSettings: (...args) => service.setSettings(...args)
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

const STATE = {
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
  theme: null
};

let server;
let baseUrl;

function request(method, body) {
  return fetch(`${baseUrl}/api/dj`, {
    method,
    headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
}

beforeEach(async () => {
  authState.mode = 'allow';
  authState.user = null;
  service.getStateOrUnavailable = vi.fn(() => STATE);
  service.setSettings = vi.fn((partial) => ({ ...STATE, ...partial }));

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

describe('GET /api/dj', () => {
  it('returns the DjState', async () => {
    const res = await request('GET');

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(STATE);
  });

  it('returns { available: false } when the DJ is not configured', async () => {
    service.getStateOrUnavailable = vi.fn(() => ({ available: false }));

    const res = await request('GET');

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ available: false });
  });

  it('rejects unauthenticated requests', async () => {
    authState.mode = 'reject';

    const res = await request('GET');

    expect(res.status).toBe(401);
    expect(service.getStateOrUnavailable).not.toHaveBeenCalled();
  });
});

describe('PATCH /api/dj', () => {
  it.each([
    [{ enabled: true }],
    [{ interval: 4 }],
    [{ lookahead: 10 }],
    [{ enabled: true, interval: 7, lookahead: 10 }]
  ])('passes %j to setSettings once and returns the new state', async (body) => {
    const res = await request('PATCH', body);

    expect(res.status).toBe(200);
    expect(service.setSettings).toHaveBeenCalledTimes(1);
    expect(service.setSettings).toHaveBeenCalledWith(body, { id: 'self-1', name: 'tester' });
    expect(await res.json()).toEqual({ ...STATE, ...body });
  });

  it('names the actor from the JWT user', async () => {
    authState.user = { username: 'kasper', global_name: 'Kasper', discord_id: '123' };

    await request('PATCH', { enabled: true });

    expect(service.setSettings).toHaveBeenCalledWith(
      { enabled: true },
      { id: '123', name: 'Kasper' }
    );
  });

  it.each([
    [DJ_UNAVAILABLE, 503, "The DJ isn't set up on this server."],
    [INVALID_INTERVAL, 400, 'Interval must be a whole number from 1 to 10.'],
    [INVALID_LOOKAHEAD, 400, 'Lookahead must be 5 or 10.']
  ])('maps %s to %i with { code, message }', async (code, status, message) => {
    service.setSettings = vi.fn(() => {
      throw new DjError(code, 'service text');
    });

    const res = await request('PATCH', { interval: 11 });

    expect(res.status).toBe(status);
    expect(await res.json()).toEqual({ code, message });
  });

  it('rejects a non-object body without calling the service', async () => {
    const res = await request('PATCH', [1, 2]);

    expect(res.status).toBe(400);
    expect(service.setSettings).not.toHaveBeenCalled();
  });

  it('rejects unauthenticated requests without calling the service', async () => {
    authState.mode = 'reject';

    const res = await request('PATCH', { enabled: true });

    expect(res.status).toBe(401);
    expect(service.setSettings).not.toHaveBeenCalled();
  });
});
