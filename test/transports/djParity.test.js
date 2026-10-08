import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import express from 'express';

// contracts/dj-api.md §3: every DJ operation reaches the same djService call
// with the same arguments from Discord, HTTP and Socket.io, and every DjError is
// mapped through the same table (messages.js). The matrix below is a table so
// later stories (shout-outs, themed mode) append rows instead of new tests.
//
// djService is mocked; the real musicManager runs over a fake player and queue
// so the "clear during a DJ line" row observes actual cancelOverlay() calls.
const { djMock } = vi.hoisted(() => ({
  djMock: { getState: null, getStateOrUnavailable: null, setSettings: null }
}));

vi.mock('../../src/services/dj/djService.js', () => ({
  getState: (...a) => djMock.getState(...a),
  getStateOrUnavailable: (...a) => djMock.getStateOrUnavailable(...a),
  setSettings: (...a) => djMock.setSettings(...a)
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
  enrichWithUserInfo: vi.fn(),
  triggerLookaheadIfNeeded: vi.fn()
}));
vi.mock('../../src/persistence/db.js', () => ({
  db: { logEvent: vi.fn(), getHistory: vi.fn(() => []), addToHistory: vi.fn() }
}));
vi.mock('../../src/integrations/youtube.js', () => ({ search: vi.fn() }));
vi.mock('../../src/utils/logger.js', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() }
}));
vi.mock('../../src/services/playback.js', () => ({
  getPlayer: vi.fn(() => null),
  getQueue: vi.fn(() => fakeQueue),
  advanceAndPlay: vi.fn()
}));
vi.mock('../../src/services/resolutionManager.js', () => ({
  resolutionManager: {
    setQueue: vi.fn(),
    start: vi.fn(),
    on: vi.fn(),
    processLookahead: vi.fn(),
    stop: vi.fn(),
    processingTracks: new Set()
  }
}));

import { musicManager } from '../../src/core/musicManager.js';
import djRouter from '../../src/transports/http/routes/dj.js';
import queueRouter from '../../src/transports/http/routes/queue.js';
import { handleDjSettings, handlePlayerControl } from '../../src/transports/realtime/handlers.js';
import { handleDj } from '../../src/transports/discord/commands/dj.js';
import { handleClear as discordClear } from '../../src/transports/discord/commands/queue.js';
import {
  DjError,
  DJ_UNAVAILABLE,
  INVALID_INTERVAL,
  INVALID_LOOKAHEAD
} from '../../src/services/dj/errors.js';
import { DJ_MESSAGES } from '../../src/services/dj/messages.js';

// The fake queue and player behind the real musicManager.
let fakeQueue;
let fakePlayer;

function makeQueue() {
  const current = { title: 'Current', url: 'https://example.com/current' };
  return {
    tracks: [current, { title: 'Next', url: 'https://example.com/next' }],
    currentIndex: 0,
    loopMode: 'off',
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
    },
    getResolutionStats: () => null
  };
}

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
let socketSeq = 0;

beforeEach(async () => {
  fakeQueue = makeQueue();
  fakePlayer = { cancelOverlay: vi.fn(), stop: vi.fn(), on: vi.fn() };
  musicManager.player = fakePlayer;
  musicManager.queue = fakeQueue;
  musicManager.guildId = 'g1';

  djMock.getState = vi.fn(() => djState());
  djMock.getStateOrUnavailable = vi.fn(() => djState());
  djMock.setSettings = vi.fn((partial) => djState(partial));

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
  musicManager.queue = null;
  await new Promise((resolve) => server.close(resolve));
});

// A fresh user per socket so the per-user `dj` throttle never couples rows.
function socket() {
  socketSeq++;
  return {
    emit: vi.fn(),
    user: { username: `socket-actor-${socketSeq}`, discord_id: `socket-${socketSeq}` }
  };
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

function patch(body) {
  return fetch(`${baseUrl}/api/dj`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
}

/** Each surface returns what it replied, normalised to { ok, code?, message? }. */
async function viaHttp(body) {
  const res = await patch(body);
  const json = await res.json();
  return res.ok ? { ok: true, status: res.status } : { ok: false, status: res.status, ...json };
}

async function viaSocket(payload) {
  const s = socket();
  await handleDjSettings(s)(payload);
  const err = s.emit.mock.calls.find(([event]) => event === 'error');
  return err ? { ok: false, ...err[1] } : { ok: true };
}

async function viaDiscord(subcommand, integers) {
  const i = interaction(subcommand, integers);
  await handleDj(i);
  const [arg] = i.reply.mock.calls[0];
  if (typeof arg === 'object' && arg.ephemeral) return { ok: false, message: arg.content };
  return { ok: true, content: typeof arg === 'string' ? arg : arg.content };
}

const ACTORS = {
  http: { id: 'http-1', name: 'http-actor' },
  discord: { id: 'discord-1', name: 'discord-actor' }
};

/**
 * The settings rows of contracts §3. Each row names the `setSettings` partial
 * every surface must produce, and how each surface triggers it.
 */
const SETTINGS_ROWS = [
  {
    name: 'Enable',
    partial: { enabled: true },
    http: () => viaHttp({ enabled: true }),
    socket: () => viaSocket({ enabled: true }),
    discord: () => viaDiscord('on')
  },
  {
    name: 'Disable',
    partial: { enabled: false },
    http: () => viaHttp({ enabled: false }),
    socket: () => viaSocket({ enabled: false }),
    discord: () => viaDiscord('off')
  },
  {
    name: 'Set interval',
    partial: { interval: 4 },
    http: () => viaHttp({ interval: 4 }),
    socket: () => viaSocket({ interval: 4 }),
    discord: () => viaDiscord('interval', { every: 4 })
  },
  {
    name: 'Set lookahead',
    partial: { lookahead: 10 },
    http: () => viaHttp({ lookahead: 10 }),
    socket: () => viaSocket({ lookahead: 10 }),
    discord: () => viaDiscord('lookahead', { size: 10 })
  }
];

const SURFACES = ['http', 'socket', 'discord'];

describe('DJ settings rows reach the same djService call on every surface', () => {
  for (const row of SETTINGS_ROWS) {
    for (const surface of SURFACES) {
      it(`${row.name} via ${surface} calls setSettings(${JSON.stringify(row.partial)})`, async () => {
        const result = await row[surface]();

        expect(result.ok).toBe(true);
        expect(djMock.setSettings).toHaveBeenCalledTimes(1);
        const [partial, actor] = djMock.setSettings.mock.calls[0];
        expect(partial).toEqual(row.partial);
        expect(actor.id).toBeTruthy();
        expect(actor.name).toBeTruthy();
        if (ACTORS[surface]) expect(actor).toEqual(ACTORS[surface]);
      });
    }
  }
});

describe('Read state', () => {
  it('HTTP GET /api/dj returns getStateOrUnavailable()', async () => {
    const res = await fetch(`${baseUrl}/api/dj`);
    expect(await res.json()).toEqual(djState());
    expect(djMock.getStateOrUnavailable).toHaveBeenCalled();
  });

  it('Discord /dj status reports the same state and changes nothing', async () => {
    djMock.getStateOrUnavailable.mockReturnValue(djState({ enabled: true, interval: 7 }));
    const result = await viaDiscord('status');

    expect(result.ok).toBe(true);
    expect(result.content).toMatch(/On/);
    expect(result.content).toMatch(/every 7 tracks/);
    expect(result.content).toMatch(/Lookahead:\*\* 5/);
    expect(result.content).toMatch(/Health:\*\* ok/);
    expect(result.content).toMatch(/0 \/ 150/);
    expect(result.content).toMatch(/00:00/);
    expect(djMock.setSettings).not.toHaveBeenCalled();
  });

  it('every surface reports an unconfigured DJ the same way', async () => {
    djMock.getStateOrUnavailable.mockReturnValue({ available: false });
    expect(await (await fetch(`${baseUrl}/api/dj`)).json()).toEqual({ available: false });
    const result = await viaDiscord('status');
    expect(result).toEqual({ ok: false, message: DJ_MESSAGES[DJ_UNAVAILABLE].text });
  });
});

/** Error rows: the code the service throws, and a trigger per surface. */
const ERROR_ROWS = [
  {
    code: DJ_UNAVAILABLE,
    http: () => viaHttp({ enabled: true }),
    socket: () => viaSocket({ enabled: true }),
    discord: () => viaDiscord('on')
  },
  {
    code: INVALID_INTERVAL,
    http: () => viaHttp({ interval: 11 }),
    socket: () => viaSocket({ interval: 11 }),
    discord: () => viaDiscord('interval', { every: 11 })
  },
  {
    code: INVALID_LOOKAHEAD,
    http: () => viaHttp({ lookahead: 7 }),
    socket: () => viaSocket({ lookahead: 7 }),
    discord: () => viaDiscord('lookahead', { size: 7 })
  }
];

describe('DjError codes map identically on every surface (contracts §2)', () => {
  for (const row of ERROR_ROWS) {
    const { http, text } = DJ_MESSAGES[row.code];

    it(`${row.code}: HTTP ${http} { code, message }`, async () => {
      djMock.setSettings.mockImplementation(() => {
        throw new DjError(row.code);
      });
      expect(await row.http()).toEqual({ ok: false, status: http, code: row.code, message: text });
    });

    it(`${row.code}: socket error { code, message }`, async () => {
      djMock.setSettings.mockImplementation(() => {
        throw new DjError(row.code);
      });
      expect(await row.socket()).toEqual({ ok: false, code: row.code, message: text });
    });

    it(`${row.code}: Discord ephemeral text`, async () => {
      djMock.setSettings.mockImplementation(() => {
        throw new DjError(row.code);
      });
      expect(await row.discord()).toEqual({ ok: false, message: text });
    });
  }
});

describe('Clear queue during a DJ line cancels the overlay once on every surface (FR-009)', () => {
  const CLEAR = {
    discord: () => discordClear(interaction('clear')),
    http: () => fetch(`${baseUrl}/api/queue`, { method: 'DELETE' }),
    socket: () => handlePlayerControl(socket())({ action: 'clear' })
  };

  for (const surface of SURFACES) {
    it(`${surface} clear calls player.cancelOverlay() exactly once`, async () => {
      const res = await CLEAR[surface]();
      if (surface === 'http') expect(res.status).toBe(200);
      expect(fakePlayer.cancelOverlay).toHaveBeenCalledTimes(1);
    });
  }
});

describe('the socket dj throttle is per user', () => {
  it('drops a second change from the same user within 1 s', async () => {
    const s = socket();
    await handleDjSettings(s)({ interval: 4 });
    await handleDjSettings(s)({ interval: 5 });

    expect(djMock.setSettings).toHaveBeenCalledTimes(1);
    expect(s.emit).toHaveBeenCalledWith(
      'error',
      expect.objectContaining({ message: expect.any(String) })
    );
  });
});
