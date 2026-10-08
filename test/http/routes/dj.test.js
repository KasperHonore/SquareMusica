import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import express from 'express';

// The dj router's only collaborator is djService, mocked here so the route runs
// without the database or the DJ's external clients. The auth mock can reject,
// so the 401 case is exercised rather than assumed (as in stats.test.js).
const { authState } = vi.hoisted(() => ({ authState: { mode: 'allow', user: null } }));

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
  getState: vi.fn(),
  getStateOrUnavailable: vi.fn(),
  setSettings: vi.fn()
}));
vi.mock('../../../src/utils/logger.js', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() }
}));

import djRouter from '../../../src/transports/http/routes/dj.js';
import * as djService from '../../../src/services/dj/djService.js';
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

function patch(body) {
  return fetch(`${baseUrl}/api/dj`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body)
  });
}

beforeEach(async () => {
  vi.clearAllMocks();
  authState.mode = 'allow';
  authState.user = null;
  djService.getState.mockReturnValue(STATE);
  djService.getStateOrUnavailable.mockReturnValue(STATE);
  djService.setSettings.mockImplementation((partial) => ({ ...STATE, ...partial }));

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

describe('authentication', () => {
  it('rejects an unauthenticated GET', async () => {
    authState.mode = 'reject';
    const res = await fetch(`${baseUrl}/api/dj`);
    expect(res.status).toBe(401);
    expect(djService.getStateOrUnavailable).not.toHaveBeenCalled();
  });

  it('rejects an unauthenticated PATCH without touching settings', async () => {
    authState.mode = 'reject';
    const res = await patch({ enabled: true });
    expect(res.status).toBe(401);
    expect(djService.setSettings).not.toHaveBeenCalled();
  });
});

describe('GET /api/dj', () => {
  it('returns the DjState', async () => {
    const res = await fetch(`${baseUrl}/api/dj`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(STATE);
  });

  it('returns { available: false } when the DJ is not configured', async () => {
    djService.getStateOrUnavailable.mockReturnValue({ available: false });
    const res = await fetch(`${baseUrl}/api/dj`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ available: false });
  });
});

describe('PATCH /api/dj', () => {
  it.each([
    [{ enabled: true }],
    [{ interval: 4 }],
    [{ lookahead: 10 }],
    [{ enabled: true, interval: 7, lookahead: 10 }]
  ])('passes %j to setSettings once and returns the new state', async (body) => {
    const res = await patch(body);

    expect(res.status).toBe(200);
    expect(djService.setSettings).toHaveBeenCalledTimes(1);
    expect(djService.setSettings).toHaveBeenCalledWith(body, { id: 'self-1', name: 'tester' });
    expect(await res.json()).toEqual({ ...STATE, ...body });
  });

  it('forwards only the settings fields', async () => {
    await patch({ interval: 2, theme: 'nope', enabled: undefined });
    expect(djService.setSettings).toHaveBeenCalledWith({ interval: 2 }, expect.any(Object));
  });

  it('rejects a non-object body with 400 and no service call', async () => {
    const res = await patch('[1, 2]');
    expect(res.status).toBe(400);
    expect(djService.setSettings).not.toHaveBeenCalled();
  });

  it.each([
    [DJ_UNAVAILABLE, 503, "The DJ isn't set up on this server."],
    [INVALID_INTERVAL, 400, 'Interval must be a whole number from 1 to 10.'],
    [INVALID_LOOKAHEAD, 400, 'Lookahead must be 5 or 10.']
  ])('maps %s to HTTP %i with { code, message }', async (code, status, message) => {
    djService.setSettings.mockImplementation(() => {
      throw new DjError(code);
    });

    const res = await patch({ interval: 11 });

    expect(res.status).toBe(status);
    expect(await res.json()).toEqual({ code, message });
  });

  it('returns a generic 500 for an uncoded failure', async () => {
    djService.setSettings.mockImplementation(() => {
      throw new Error('database is locked');
    });
    const res = await patch({ enabled: true });
    expect(res.status).toBe(500);
  });
});
