import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import express from 'express';

// Constitution III: every DJ operation goes through the same djService call on
// Discord, HTTP and Socket.io, and its error codes map through the same table
// (contracts §2, §3). The service is mocked, so each row asserts only what the
// transport adds: which call, which arguments, and how a DjError is reported.
//
// OPERATIONS is a table so US3 and US4 append rows rather than tests.
const { service } = vi.hoisted(() => ({
  service: { getStateOrUnavailable: null, getState: null, setSettings: null }
}));

vi.mock('../../src/services/dj/djService.js', () => ({
  getStateOrUnavailable: (...args) => service.getStateOrUnavailable(...args),
  getState: (...args) => service.getState(...args),
  setSettings: (...args) => service.setSettings(...args)
}));
vi.mock('../../src/transports/http/middleware/auth.js', () => ({
  authMiddleware: (req, _res, next) => {
    req.user = { username: 'http-actor', discord_id: 'http-1' };
    next();
  },
  optionalAuth: (req, _res, next) => {
    req.user = { username: 'http-actor', discord_id: 'http-1' };
    next();
  }
}));
vi.mock('../../src/transports/discord/voiceManager.js', () => ({
  isConnected: vi.fn(() => true),
  getConnection: vi.fn(() => ({ id: 'conn-1' })),
  joinChannel: vi.fn(),
  leaveChannel: vi.fn(() => true),
  setChannelCache: vi.fn(),
  getChannelCache: vi.fn(() => null),
  getChannelInfo: vi.fn(() => null)
}));
vi.mock('../../src/transports/discord/client.js', () => ({
  client: { isReady: vi.fn(() => true), guilds: { fetch: vi.fn() } }
}));
vi.mock('../../src/transports/discord/commands/utils/checks.js', () => ({
  requireVoiceConnection: vi.fn().mockResolvedValue(true)
}));
vi.mock('../../src/services/trackResolver.js', () => ({
  resolveQuery: vi.fn(),
  tryPlayWithFallback: vi.fn(),
  enrichWithUserInfo: vi.fn((t) => t),
  triggerLookaheadIfNeeded: vi.fn()
}));
vi.mock('../../src/persistence/db.js', () => ({
  db: { logEvent: vi.fn(), getHistory: vi.fn(() => []) }
}));
vi.mock('../../src/integrations/youtube.js', () => ({ search: vi.fn() }));
vi.mock('../../src/utils/logger.js', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() }
}));
vi.mock('../../src/services/resolutionManager.js', () => ({
  resolutionManager: {
    on: vi.fn(),
    setQueue: vi.fn(),
    start: vi.fn(),
    processLookahead: vi.fn(),
    stop: vi.fn(),
    processingTracks: new Set()
  }
}));

// The clear row runs against the real mediator, so the queue it clears is a
// small fake and the player only records cancelOverlay() calls.
function fakeQueue() {
  const current = { title: 'A', url: 'https://example.com/a' };
  return {
    tracks: [current, { title: 'B', url: 'https://example.com/b' }],
    currentIndex: 0,
    getAll() {
      return this.tracks;
    },
    getCurrent() {
      return this.tracks[this.currentIndex] ?? null;
    },
    clear() {
      this.tracks = [];
      this.currentIndex = 0;
    },
    clearUpcoming() {
      this.tracks = this.tracks.slice(0, this.currentIndex + 1);
    }
  };
}
const { playback } = vi.hoisted(() => ({ playback: { queue: null } }));
vi.mock('../../src/services/playback.js', () => ({
  getPlayer: vi.fn(() => null),
  getQueue: vi.fn(() => playback.queue),
  advanceAndPlay: vi.fn().mockResolvedValue({ played: false })
}));

import djRouter from '../../src/transports/http/routes/dj.js';
import queueRouter from '../../src/transports/http/routes/queue.js';
import { handleDjSettings, handlePlayerControl } from '../../src/transports/realtime/handlers.js';
import { handleDj } from '../../src/transports/discord/commands/dj.js';
import { handleClear as discordClear } from '../../src/transports/discord/commands/queue.js';
import { musicManager } from '../../src/core/musicManager.js';
import {
  DjError,
  DJ_UNAVAILABLE,
  INVALID_INTERVAL,
  INVALID_LOOKAHEAD
} from '../../src/services/dj/errors.js';
import { DJ_MESSAGES } from '../../src/services/dj/messages.js';

const STATE = {
  available: true,
  enabled: true,
  interval: 4,
  lookahead: 10,
  health: 'ok',
  caps: {
    lines: { used: 2, limit: 150, reached: false },
    themedTracks: { used: 0, limit: 100, reached: false },
    resetsAt: '2026-10-09T00:00:00+02:00'
  },
  theme: null
};

let server;
let baseUrl;

beforeEach(async () => {
  service.getStateOrUnavailable = vi.fn(() => STATE);
  service.getState = vi.fn(() => STATE);
  service.setSettings = vi.fn(() => STATE);

  const app = express();
  app.use(express.json());
  app.use('/api/dj', djRouter);
  app.use('/api/queue', queueRouter);
  server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

afterEach(async () => {
  await new Promise((resolve) => server.close(resolve));
});

// Each socket gets a unique user so the per-user `dj` throttle never carries
// over between rows.
let socketSeq = 0;
function socket() {
  socketSeq++;
  return { emit: vi.fn(), user: { username: 'socket-actor', discord_id: `socket-${socketSeq}` } };
}

function interaction(subcommand, integers = {}) {
  return {
    guildId: 'g1',
    user: { id: 'discord-1', username: 'discord-actor' },
    options: {
      getSubcommand: vi.fn(() => subcommand),
      getInteger: vi.fn((name) => integers[name] ?? null)
    },
    reply: vi.fn().mockResolvedValue(undefined)
  };
}

/**
 * The operation matrix (contracts §3). Each row names the service method, the
 * arguments every surface must pass (actor excluded; it differs by surface),
 * and one trigger per surface. Each trigger returns what that surface told the
 * caller, normalised to `{ errorCode?, errorText?, status? }`.
 */
const OPERATIONS = [
  {
    name: 'Read state',
    method: 'getStateOrUnavailable',
    args: [],
    discord: () => runDiscord(interaction('status')),
    http: () => runHttp('GET'),
    socket: null // pushed via dj:state; there is no client → server read
  },
  {
    name: 'Enable',
    method: 'setSettings',
    args: [{ enabled: true }],
    discord: () => runDiscord(interaction('on')),
    http: () => runHttp('PATCH', { enabled: true }),
    socket: () => runSocket({ enabled: true })
  },
  {
    name: 'Disable',
    method: 'setSettings',
    args: [{ enabled: false }],
    discord: () => runDiscord(interaction('off')),
    http: () => runHttp('PATCH', { enabled: false }),
    socket: () => runSocket({ enabled: false })
  },
  {
    name: 'Set interval',
    method: 'setSettings',
    args: [{ interval: 4 }],
    discord: () => runDiscord(interaction('interval', { every: 4 })),
    http: () => runHttp('PATCH', { interval: 4 }),
    socket: () => runSocket({ interval: 4 })
  },
  {
    name: 'Set lookahead',
    method: 'setSettings',
    args: [{ lookahead: 10 }],
    discord: () => runDiscord(interaction('lookahead', { size: 10 })),
    http: () => runHttp('PATCH', { lookahead: 10 }),
    socket: () => runSocket({ lookahead: 10 })
  }
];

const ACTORS = {
  discord: { id: 'discord-1', name: 'discord-actor' },
  http: { id: 'http-1', name: 'http-actor' }
};

async function runDiscord(i) {
  await handleDj(i);
  const [reply] = i.reply.mock.calls.at(-1);
  const content = typeof reply === 'string' ? reply : reply.content;
  const ephemeral = typeof reply === 'object' && reply.ephemeral === true;
  return { reply: content, ephemeral };
}

async function runHttp(method, body) {
  const res = await fetch(`${baseUrl}/api/dj`, {
    method,
    headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  return { status: res.status, body: await res.json() };
}

async function runSocket(payload) {
  const s = socket();
  await handleDjSettings(s)(payload);
  const errorCall = s.emit.mock.calls.find(([event]) => event === 'error');
  return { error: errorCall ? errorCall[1] : null, user: s.user };
}

const SURFACES = ['discord', 'http', 'socket'];

describe('every DJ operation makes the same service call on every surface', () => {
  for (const op of OPERATIONS) {
    for (const surface of SURFACES) {
      if (!op[surface]) continue;
      it(`${op.name} via ${surface} calls ${op.method}(${JSON.stringify(op.args)}) once`, async () => {
        const result = await op[surface]();

        const fn = service[op.method];
        expect(fn).toHaveBeenCalledTimes(1);
        const call = fn.mock.calls[0];
        expect(call.slice(0, op.args.length)).toEqual(op.args);
        if (op.method === 'setSettings') {
          const expectedActor =
            surface === 'socket'
              ? { id: result.user.discord_id, name: 'socket-actor' }
              : ACTORS[surface];
          expect(call[1]).toEqual(expectedActor);
        }
      });
    }
  }
});

describe('settings changes reply publicly on Discord, like /loop', () => {
  for (const op of OPERATIONS.filter((o) => o.method === 'setSettings')) {
    it(`${op.name} is not ephemeral and never carries line text`, async () => {
      const { ephemeral, reply } = await op.discord();

      expect(ephemeral).toBe(false);
      expect(reply).toBeTruthy();
    });
  }
});

describe('/dj status reports the settings, health and caps', () => {
  it('shows enabled, interval, lookahead, health, used/limit and reset time', async () => {
    const { reply } = await runDiscord(interaction('status'));

    expect(reply).toContain('on');
    expect(reply).toContain('every 4 tracks');
    expect(reply).toContain('Lookahead: 10');
    expect(reply).toContain('Health: ok');
    expect(reply).toContain('2 / 150');
    expect(reply).toContain('00:00');
  });

  it('replies with the unavailable text when the DJ is not configured', async () => {
    service.getStateOrUnavailable = vi.fn(() => ({ available: false }));

    const discord = await runDiscord(interaction('status'));
    const http = await runHttp('GET');

    expect(discord).toEqual({ reply: DJ_MESSAGES[DJ_UNAVAILABLE].text, ephemeral: true });
    expect(http).toEqual({ status: 200, body: { available: false } });
  });
});

// One row per error a settings change can raise (contracts §2). The service
// throws; each surface must report the same code with the shared text.
const SETTINGS_ERRORS = [
  { code: DJ_UNAVAILABLE, http: 503 },
  { code: INVALID_INTERVAL, http: 400 },
  { code: INVALID_LOOKAHEAD, http: 400 }
];

describe('settings errors map identically on every surface', () => {
  for (const { code, http } of SETTINGS_ERRORS) {
    const text = DJ_MESSAGES[code].text;

    it(`${code}: HTTP ${http}, Discord ephemeral text, socket error {code,message}`, async () => {
      service.setSettings = vi.fn(() => {
        throw new DjError(code, 'service text');
      });

      const discord = await runDiscord(interaction('interval', { every: 4 }));
      const httpResult = await runHttp('PATCH', { interval: 4 });
      const socketResult = await runSocket({ interval: 4 });

      expect(httpResult).toEqual({ status: http, body: { code, message: text } });
      expect(discord).toEqual({ reply: text, ephemeral: true });
      expect(socketResult.error).toEqual({ code, message: text });
    });
  }
});

describe('Clear queue during a DJ line cancels the overlay once on every surface (FR-009)', () => {
  let player;

  beforeEach(() => {
    player = { cancelOverlay: vi.fn() };
    playback.queue = fakeQueue();
    musicManager.player = player;
    musicManager.queue = playback.queue;
    musicManager.guildId = 'g1';
  });

  afterEach(() => {
    musicManager.player = null;
    musicManager.queue = null;
  });

  const CLEAR = {
    discord: () => discordClear(interaction(null)),
    http: () => fetch(`${baseUrl}/api/queue`, { method: 'DELETE' }),
    socket: () => handlePlayerControl(socket())({ action: 'clear' })
  };

  for (const surface of SURFACES) {
    it(`${surface} clear calls player.cancelOverlay() exactly once`, async () => {
      await CLEAR[surface]();

      expect(player.cancelOverlay).toHaveBeenCalledTimes(1);
    });
  }
});

describe('the matrix covers every surface', () => {
  it('each settings row has a trigger on all three surfaces', () => {
    for (const op of OPERATIONS.filter((o) => o.method === 'setSettings')) {
      for (const surface of SURFACES) {
        expect(typeof op[surface], `${op.name} has no ${surface} trigger`).toBe('function');
      }
    }
  });
});

describe('dj:settings uses the per-user dj throttle (1000 ms)', () => {
  it('drops a second change from the same user within a second', async () => {
    const s = socket();
    const handler = handleDjSettings(s);

    await handler({ interval: 4 });
    await handler({ interval: 5 });

    expect(service.setSettings).toHaveBeenCalledTimes(1);
    expect(s.emit).toHaveBeenCalledWith(
      'error',
      expect.objectContaining({ message: expect.any(String) })
    );
  });
});
