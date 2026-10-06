import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import express from 'express';

// GET/PATCH /api/dj (contracts/dj-api.md §1–§3). The service is mocked so the
// router mounts without SQLite; the auth middleware can reject, because the
// route must never be reachable without a session.
const { authState, djService } = vi.hoisted(() => {
  const state = {
    available: true,
    enabled: false,
    interval: 3,
    lookahead: 5,
    health: 'ok',
    caps: {
      lines: { used: 0, limit: 150, reached: false },
      themedTracks: { used: 0, limit: 100, reached: false },
      resetsAt: '2026-10-07T00:00:00+02:00'
    },
    theme: null
  };
  return {
    authState: { mode: 'allow' },
    djService: {
      state,
      getStateOrUnavailable: vi.fn(() => state),
      setSettings: vi.fn()
    }
  };
});

vi.mock('../../../src/transports/http/middleware/auth.js', () => ({
  authMiddleware: (req, res, next) => {
    if (authState.mode === 'reject') {
      return res.status(401).json({ error: 'Authentication required' });
    }
    req.user = { id: 42, username: 'tester', discord_id: 'discord-42' };
    next();
  },
  optionalAuth: (req, _res, next) => next()
}));
vi.mock('../../../src/services/dj/djService.js', () => ({
  getStateOrUnavailable: djService.getStateOrUnavailable,
  setSettings: djService.setSettings
}));
vi.mock('../../../src/utils/logger.js', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() }
}));

import djRouter from '../../../src/transports/http/routes/dj.js';
import { DjError } from '../../../src/services/dj/errors.js';

let server;
let baseUrl;

function get() {
  return fetch(`${baseUrl}/api/dj`);
}

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
  djService.getStateOrUnavailable.mockImplementation(() => djService.state);
  djService.setSettings.mockImplementation((partial) => ({ ...djService.state, ...partial }));

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
  it('rejects GET without a session', async () => {
    authState.mode = 'reject';
    const res = await get();
    expect(res.status).toBe(401);
  });

  it('rejects PATCH without a session and never calls the service', async () => {
    authState.mode = 'reject';
    const res = await patch({ enabled: true });
    expect(res.status).toBe(401);
    expect(djService.setSettings).not.toHaveBeenCalled();
  });
});

describe('GET /api/dj', () => {
  it('returns the DjState', async () => {
    const res = await get();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(djService.state);
  });

  it('returns { available: false } when the DJ is not configured', async () => {
    djService.getStateOrUnavailable.mockReturnValue({ available: false });
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
    [{ enabled: false, interval: 1, lookahead: 5 }]
  ])('accepts the subset %j and calls setSettings once with it', async (body) => {
    const res = await patch(body);

    expect(res.status).toBe(200);
    expect(djService.setSettings).toHaveBeenCalledTimes(1);
    expect(djService.setSettings.mock.calls[0][0]).toEqual(body);
    expect(await res.json()).toEqual({ ...djService.state, ...body });
  });

  it('passes the actor keyed by Discord user id, not the internal users.id', async () => {
    await patch({ enabled: true });
    expect(djService.setSettings.mock.calls[0][1]).toEqual({ id: 'discord-42', name: 'tester' });
  });

  it('does not forward fields outside { enabled, interval, lookahead }', async () => {
    await patch({ interval: 4, theme: 'nope', health: 'degraded' });
    expect(djService.setSettings.mock.calls[0][0]).toEqual({ interval: 4 });
  });

  it.each([['[1,2]'], ['"enabled"'], ['null']])(
    'rejects a non-object body %s with 400 and no service call',
    async (raw) => {
      const res = await patch(raw);
      expect(res.status).toBe(400);
      expect(djService.setSettings).not.toHaveBeenCalled();
    }
  );

  it.each([
    ['DJ_UNAVAILABLE', 503, "The DJ isn't set up on this server."],
    ['INVALID_INTERVAL', 400, 'Interval must be a whole number from 1 to 10.'],
    ['INVALID_LOOKAHEAD', 400, 'Lookahead must be 5 or 10.']
  ])('maps %s to HTTP %i with { code, message }', async (code, status, message) => {
    djService.setSettings.mockImplementation(() => {
      throw new DjError(code);
    });

    const res = await patch({ interval: 11 });

    expect(res.status).toBe(status);
    expect(await res.json()).toEqual({ code, message });
  });

  it('returns 500 for an unexpected failure', async () => {
    djService.setSettings.mockImplementation(() => {
      throw new Error('database is locked');
    });
    const res = await patch({ enabled: true });
    expect(res.status).toBe(500);
  });
});
