import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import express from 'express';

// Constitution III / contracts §3: every DJ operation must reach the same
// djService call with the same arguments from Discord, HTTP and Socket.io, and a
// coded error must map to the same text on all three. The matrix below is a
// table so US3 and US4 can append rows without touching the assertions.
//
// djService is mocked; the real musicManager is used (with a spy player and a
// real Queue) so the "clear during a DJ line" row exercises each surface's real
// path down to player.cancelOverlay().
vi.mock('../../src/services/dj/djService.js', () => ({
  getState: vi.fn(),
  getStateOrUnavailable: vi.fn(),
  setSettings: vi.fn()
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
  tryPlayWithFallback: vi.fn()
}));
vi.mock('../../src/persistence/db.js', () => ({
  db: { logEvent: vi.fn(), getHistory: vi.fn(() => []), addToHistory: vi.fn() }
}));
vi.mock('../../src/integrations/youtube.js', () => ({ search: vi.fn() }));
vi.mock('../../src/utils/logger.js', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() }
}));
vi.mock('../../src/services/resolutionManager.js', () => ({
  resolutionManager: {
    setQueue: vi.fn(),
    start: vi.fn(),
    stop: vi.fn(),
    on: vi.fn(),
    processLookahead: vi.fn(),
    processingTracks: new Set()
  }
}));
const shared = vi.hoisted(() => ({ queue: null }));
vi.mock('../../src/services/playback.js', () => ({
  getPlayer: vi.fn(() => null),
  getQueue: vi.fn(() => shared.queue),
  advanceAndPlay: vi.fn().mockResolvedValue({ played: false })
}));

import * as djService from '../../src/services/dj/djService.js';
import { DjError } from '../../src/services/dj/errors.js';
import { DJ_MESSAGES } from '../../src/services/dj/messages.js';
import { musicManager } from '../../src/core/musicManager.js';
import { Queue } from '../../src/core/queue.js';
import djRouter from '../../src/transports/http/routes/dj.js';
import queueRouter from '../../src/transports/http/routes/queue.js';
import { handleDjSettings, handlePlayerControl } from '../../src/transports/realtime/handlers.js';
import { ClientEvents } from '../../src/transports/realtime/events.js';
import { handleDj } from '../../src/transports/discord/commands/dj.js';
import { handleClear as discordClear } from '../../src/transports/discord/commands/queue.js';

const STATE = {
  available: true,
  enabled: true,
  interval: 4,
  lookahead: 10,
  health: 'ok',
  caps: {
    lines: { used: 3, limit: 150, reached: false },
    themedTracks: { used: 0, limit: 100, reached: false },
    resetsAt: '2026-10-09T00:00:00+02:00'
  },
  theme: null
};

let server;
let baseUrl;
let socketSeq = 0;

// --- Surface drivers -------------------------------------------------------

/** A fresh socket per call: the `dj` throttle is per user, and parity is not
 * about the throttle. */
function socket() {
  socketSeq += 1;
  return {
    emit: vi.fn(),
    user: { username: 'socket-actor', discord_id: `socket-${socketSeq}` }
  };
}

function interaction(subcommand, ints = {}) {
  return {
    guildId: 'g1',
    user: { id: 'discord-1', username: 'discord-actor' },
    options: {
      getSubcommand: vi.fn(() => subcommand),
      getInteger: vi.fn((name) => ints[name] ?? null)
    },
    reply: vi.fn().mockResolvedValue(undefined)
  };
}

function http(method, path, body) {
  return fetch(`${baseUrl}${path}`, {
    method,
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
}

/**
 * Run one surface's trigger and normalise the outcome so surfaces compare:
 * `{ ok, error?: { code?, message } }`.
 */
const DRIVERS = {
  discord: async ({ subcommand, ints }) => {
    const i = interaction(subcommand, ints);
    await handleDj(i);
    const [reply] = i.reply.mock.calls[0];
    // /dj status is ephemeral on success too, so an error is recognised by its
    // text being one of the shared table's.
    if (typeof reply === 'object' && errorTexts().includes(reply.content)) {
      return { ok: false, error: { message: reply.content }, raw: reply };
    }
    return { ok: true, raw: reply };
  },
  http: async ({ method, path, body }) => {
    const res = await http(method, path, body);
    const json = await res.json();
    if (!res.ok) return { ok: false, status: res.status, error: json };
    return { ok: true, status: res.status, raw: json };
  },
  socket: async ({ event, payload }) => {
    const s = socket();
    const handler = SOCKET_HANDLERS[event];
    await handler(s)(payload);
    const errorCall = s.emit.mock.calls.find(([name]) => name === 'error');
    if (errorCall) return { ok: false, error: errorCall[1] };
    return { ok: true };
  }
};

const SOCKET_HANDLERS = {
  [ClientEvents.DJ_SETTINGS]: handleDjSettings
};

function errorTexts() {
  return Object.keys(DJ_MESSAGES).map(expectedText);
}

// --- The matrix (contracts §3) ----------------------------------------------
//
// Each row: the djService method and arguments every surface must produce,
// and one trigger per surface. US3/US4 append rows here.

const HTTP_ACTOR = { id: 'http-1', name: 'http-actor' };
const DISCORD_ACTOR = { id: 'discord-1', name: 'discord-actor' };
const socketActor = () => ({ id: `socket-${socketSeq}`, name: 'socket-actor' });

const ROWS = [
  {
    name: 'Read state',
    method: 'getStateOrUnavailable',
    args: () => [],
    surfaces: {
      discord: { subcommand: 'status' },
      http: { method: 'GET', path: '/api/dj' }
      // Socket: pushed via dj:state / initial:state, no client request.
    }
  },
  {
    name: 'Enable',
    method: 'setSettings',
    args: (actor) => [{ enabled: true }, actor],
    surfaces: {
      discord: { subcommand: 'on' },
      http: { method: 'PATCH', path: '/api/dj', body: { enabled: true } },
      socket: { event: ClientEvents.DJ_SETTINGS, payload: { enabled: true } }
    }
  },
  {
    name: 'Disable',
    method: 'setSettings',
    args: (actor) => [{ enabled: false }, actor],
    surfaces: {
      discord: { subcommand: 'off' },
      http: { method: 'PATCH', path: '/api/dj', body: { enabled: false } },
      socket: { event: ClientEvents.DJ_SETTINGS, payload: { enabled: false } }
    }
  },
  {
    name: 'Set interval',
    method: 'setSettings',
    args: (actor) => [{ interval: 4 }, actor],
    surfaces: {
      discord: { subcommand: 'interval', ints: { every: 4 } },
      http: { method: 'PATCH', path: '/api/dj', body: { interval: 4 } },
      socket: { event: ClientEvents.DJ_SETTINGS, payload: { interval: 4 } }
    }
  },
  {
    name: 'Set lookahead',
    method: 'setSettings',
    args: (actor) => [{ lookahead: 10 }, actor],
    surfaces: {
      discord: { subcommand: 'lookahead', ints: { size: 10 } },
      http: { method: 'PATCH', path: '/api/dj', body: { lookahead: 10 } },
      socket: { event: ClientEvents.DJ_SETTINGS, payload: { lookahead: 10 } }
    }
  }
];

const ACTORS = { discord: () => DISCORD_ACTOR, http: () => HTTP_ACTOR, socket: socketActor };

// Codes a settings change can fail with (contracts §2).
const SETTINGS_ERRORS = ['DJ_UNAVAILABLE', 'INVALID_INTERVAL', 'INVALID_LOOKAHEAD'];

function expectedText(code) {
  const { text } = DJ_MESSAGES[code];
  return typeof text === 'function' ? text(STATE) : text;
}

// --- Setup -----------------------------------------------------------------

const player = {
  cancelOverlay: vi.fn(),
  on: vi.fn(),
  isPlaying: vi.fn(() => true),
  isPaused: vi.fn(() => false),
  stop: vi.fn(),
  resume: vi.fn(),
  pause: vi.fn()
};

function track(title) {
  return { title, url: `https://example.com/${title}`, requestedById: 'q1', requestedBy: 'q' };
}

beforeEach(async () => {
  vi.clearAllMocks();
  djService.getState.mockReturnValue(STATE);
  djService.getStateOrUnavailable.mockReturnValue(STATE);
  djService.setSettings.mockReturnValue(STATE);

  shared.queue = new Queue();
  for (const t of ['a', 'b', 'c']) shared.queue.add(track(t));
  musicManager.setQueue(shared.queue);
  musicManager.player = player;
  musicManager.setGuildId('g1');

  const app = express();
  app.use(express.json());
  app.use('/api/dj', djRouter);
  app.use('/api/queue', queueRouter);
  server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

afterEach(async () => {
  musicManager.player = null;
  await new Promise((resolve) => server.close(resolve));
});

// --- Assertions --------------------------------------------------------------

describe('each operation makes the same djService call from every surface', () => {
  for (const row of ROWS) {
    for (const [surface, trigger] of Object.entries(row.surfaces)) {
      it(`${row.name} via ${surface}`, async () => {
        const outcome = await DRIVERS[surface](trigger);

        expect(outcome.ok, JSON.stringify(outcome.error)).toBe(true);
        expect(djService[row.method]).toHaveBeenCalledTimes(1);
        expect(djService[row.method]).toHaveBeenCalledWith(...row.args(ACTORS[surface]()));
      });
    }
  }
});

describe('a settings error maps to the same code and text on every surface', () => {
  const mutatingRows = ROWS.filter((r) => r.method === 'setSettings');

  for (const code of SETTINGS_ERRORS) {
    for (const row of mutatingRows) {
      it(`${code} on "${row.name}"`, async () => {
        djService.setSettings.mockImplementation(() => {
          throw new DjError(code);
        });

        const discord = await DRIVERS.discord(row.surfaces.discord);
        const httpOut = await DRIVERS.http(row.surfaces.http);
        const sock = await DRIVERS.socket(row.surfaces.socket);

        const text = expectedText(code);
        // Discord: ephemeral reply with the shared text.
        expect(discord.ok).toBe(false);
        expect(discord.raw).toEqual({ content: text, ephemeral: true });
        // HTTP: the table's status with { code, message }.
        expect(httpOut.status).toBe(DJ_MESSAGES[code].http);
        expect(httpOut.error).toEqual({ code, message: text });
        // Socket: error { code, message }.
        expect(sock.error).toEqual({ code, message: text });
      });
    }
  }

  it('reports DJ_UNAVAILABLE for /dj status and leaves GET returning { available: false }', async () => {
    djService.getStateOrUnavailable.mockReturnValue({ available: false });

    const discord = await DRIVERS.discord({ subcommand: 'status' });
    const httpOut = await DRIVERS.http({ method: 'GET', path: '/api/dj' });

    expect(discord.raw).toEqual({ content: expectedText('DJ_UNAVAILABLE'), ephemeral: true });
    expect(httpOut.raw).toEqual({ available: false });
  });
});

describe('Discord reply visibility (contracts §3 rules)', () => {
  for (const row of ROWS.filter((r) => r.method === 'setSettings')) {
    it(`${row.name} replies publicly like /loop`, async () => {
      const i = interaction(row.surfaces.discord.subcommand, row.surfaces.discord.ints);
      await handleDj(i);

      const [reply] = i.reply.mock.calls[0];
      expect(typeof reply).toBe('string');
    });
  }

  it('/dj status shows enabled, interval, lookahead, health and caps', async () => {
    const i = interaction('status');
    await handleDj(i);

    const { content } = i.reply.mock.calls[0][0];
    expect(content).toMatch(/on/);
    expect(content).toMatch(/every 4 tracks/);
    expect(content).toMatch(/10/);
    expect(content).toMatch(/ok/);
    expect(content).toMatch(/3\/150/);
    expect(content).toMatch(/00:00/);
  });
});

describe('Clear queue during a DJ line cancels the overlay once on every surface (FR-009)', () => {
  const CLEAR = {
    discord: () => discordClear({ ...interaction('clear'), options: {} }),
    http: () => http('DELETE', '/api/queue'),
    socket: () => handlePlayerControl(socket())({ action: 'clear' })
  };

  for (const [surface, trigger] of Object.entries(CLEAR)) {
    it(`${surface} clear calls player.cancelOverlay() exactly once`, async () => {
      await trigger();

      expect(player.cancelOverlay).toHaveBeenCalledTimes(1);
    });
  }
});

describe('matrix coverage', () => {
  it('covers the four US2 rows of contracts §3', () => {
    const names = ROWS.map((r) => r.name);
    expect(names).toEqual(
      expect.arrayContaining(['Read state', 'Enable', 'Disable', 'Set interval', 'Set lookahead'])
    );
    for (const row of ROWS.filter((r) => r.method === 'setSettings')) {
      expect(Object.keys(row.surfaces).sort()).toEqual(['discord', 'http', 'socket']);
    }
  });
});
