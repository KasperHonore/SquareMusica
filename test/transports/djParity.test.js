import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import express from 'express';

// Constitution III: every DJ operation goes through the same djService call on
// Discord, HTTP and Socket.io, and its error codes map through the same table
// (contracts §2, §3). The service is mocked, so each row asserts only what the
// transport adds: which call, which arguments, and how a DjError is reported.
//
// OPERATIONS is a table so US3 and US4 append rows rather than tests.
const { service } = vi.hoisted(() => ({
  service: {
    getStateOrUnavailable: null,
    getState: null,
    setSettings: null,
    getShoutouts: null,
    setShoutouts: null,
    startTheme: null,
    stopTheme: null,
    getThemeOrigin: null
  }
}));

vi.mock('../../src/services/dj/djService.js', () => ({
  getStateOrUnavailable: (...args) => service.getStateOrUnavailable(...args),
  getState: (...args) => service.getState(...args),
  setSettings: (...args) => service.setSettings(...args),
  getShoutouts: (...args) => service.getShoutouts(...args),
  setShoutouts: (...args) => service.setShoutouts(...args),
  startTheme: (...args) => service.startTheme(...args),
  stopTheme: (...args) => service.stopTheme(...args),
  getThemeOrigin: (...args) => service.getThemeOrigin(...args)
}));
// socketServer is driven against a fake io that records per-room emits, so the
// "Own shout-outs" row can assert who receives the dj:shoutouts push.
const { fakeIo } = vi.hoisted(() => {
  const io = {
    roomEmits: [],
    use() {},
    on() {},
    emit() {},
    close() {},
    to(room) {
      return { emit: (event, payload) => io.roomEmits.push({ room, event, payload }) };
    }
  };
  return { fakeIo: io };
});
vi.mock('socket.io', () => ({
  Server: function Server() {
    return fakeIo;
  }
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
vi.mock('../../src/transports/discord/client.js', async () => {
  const { EventEmitter } = await import('events');
  return {
    client: { isReady: vi.fn(() => true), guilds: { fetch: vi.fn() } },
    botEvents: new EventEmitter()
  };
});
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
  db: { logEvent: vi.fn(), getHistory: vi.fn(() => []), getPlaylists: vi.fn(() => []) }
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
import playbackRouter from '../../src/transports/http/routes/playback.js';
import {
  handleDjSettings,
  handleDjShoutouts,
  handleDjThemeStart,
  handleDjThemeStop,
  handlePlayerControl
} from '../../src/transports/realtime/handlers.js';
import {
  setupSocketServer,
  shutdownSocketServer
} from '../../src/transports/realtime/socketServer.js';
import { handleDj } from '../../src/transports/discord/commands/dj.js';
import {
  handleClear as discordClear,
  handleShuffle as discordShuffle
} from '../../src/transports/discord/commands/queue.js';
import { handleStop as discordStop } from '../../src/transports/discord/commands/playback.js';
import { botEvents } from '../../src/events/bus.js';
import { STATS_EVENT } from '../../src/shared/statsEvents.js';
import { musicManager } from '../../src/core/musicManager.js';
import {
  DjError,
  DJ_UNAVAILABLE,
  INVALID_INTERVAL,
  INVALID_LOOKAHEAD,
  INVALID_THEME,
  NOT_IN_VOICE,
  NO_TRACKS_FOR_THEME,
  SERVICE_UNAVAILABLE,
  CAP_REACHED,
  THEMED_MODE_ACTIVE
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

const THEMED_STATE = {
  ...STATE,
  theme: {
    theme: 'classic rock road trip',
    startedBy: { id: 'discord-1', name: 'discord-actor' },
    startedAt: '2026-10-08T18:00:00Z',
    status: 'running',
    reason: null
  }
};

let server;
let baseUrl;

beforeEach(async () => {
  service.getStateOrUnavailable = vi.fn(() => STATE);
  service.getState = vi.fn(() => STATE);
  service.setSettings = vi.fn(() => STATE);
  service.getShoutouts = vi.fn(() => ({ enabled: true }));
  // Mirrors the real service contract: one dj:shoutouts per change (T053).
  service.setShoutouts = vi.fn((userId, enabled) => {
    musicManager.emit('dj:shoutouts', { userId, enabled });
    return { enabled };
  });
  service.startTheme = vi.fn(async () => THEMED_STATE);
  service.stopTheme = vi.fn(() => STATE);
  service.getThemeOrigin = vi.fn(() => null);

  const app = express();
  app.use(express.json());
  app.use('/api/dj', djRouter);
  app.use('/api/queue', queueRouter);
  app.use('/api/player', playbackRouter);
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

function interaction(subcommand, integers = {}, booleans = {}, strings = {}) {
  return {
    guildId: 'g1',
    channelId: 'text-1',
    user: { id: 'discord-1', username: 'discord-actor' },
    options: {
      getSubcommand: vi.fn(() => subcommand),
      getInteger: vi.fn((name) => integers[name] ?? null),
      getBoolean: vi.fn((name) => booleans[name] ?? null),
      getString: vi.fn((name) => strings[name] ?? null)
    },
    reply: vi.fn().mockResolvedValue(undefined),
    deferReply: vi.fn().mockResolvedValue(undefined),
    editReply: vi.fn().mockResolvedValue(undefined)
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
  },
  // Own shout-outs: the member id is the Discord id on every surface (R12), so
  // `args` holds only the value; the id is checked per surface below.
  {
    name: 'Own shout-outs off',
    method: 'setShoutouts',
    args: [false],
    discord: () => runDiscord(interaction('shoutouts', {}, { enabled: false })),
    http: () => runHttp('PUT', { enabled: false }, '/shoutouts/me'),
    socket: () => runShoutoutsSocket({ enabled: false })
  },
  {
    name: 'Own shout-outs read',
    method: 'getShoutouts',
    args: [],
    discord: () => runDiscord(interaction('shoutouts')),
    http: () => runHttp('GET', undefined, '/shoutouts/me'),
    socket: null // pushed via dj:shoutouts; the page loads it over HTTP once
  },
  // Start / change theme: a start while a session runs is a change (US4/AC7),
  // so one row covers both. `origin` is checked per surface below.
  {
    name: 'Start / change theme',
    method: 'startTheme',
    args: [{ theme: 'classic rock road trip', lookahead: 5 }],
    discord: () =>
      runDiscordDeferred(
        interaction('theme', { lookahead: 5 }, {}, { description: 'classic rock road trip' })
      ),
    http: () => runHttp('POST', { theme: 'classic rock road trip', lookahead: 5 }, '/theme'),
    socket: () => runThemeSocket({ theme: 'classic rock road trip', lookahead: 5 })
  },
  {
    name: 'Stop theme',
    method: 'stopTheme',
    args: [],
    discord: () => runDiscord(interaction('theme-stop')),
    http: () => runHttp('DELETE', undefined, '/theme'),
    socket: () => runThemeStopSocket()
  }
];

const ORIGINS = {
  discord: { transport: 'discord', channelId: 'text-1' },
  http: { transport: 'http' },
  socket: { transport: 'socket' }
};

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

async function runDiscordDeferred(i) {
  await handleDj(i);
  expect(i.deferReply).toHaveBeenCalledTimes(1);
  const [reply] = i.editReply.mock.calls.at(-1);
  const content = typeof reply === 'string' ? reply : reply.content;
  return { reply: content };
}

async function runThemeSocket(payload) {
  const s = socket();
  await handleDjThemeStart(s)(payload);
  const errorCall = s.emit.mock.calls.find(([event]) => event === 'error');
  return { error: errorCall ? errorCall[1] : null, user: s.user };
}

async function runThemeStopSocket() {
  const s = socket();
  await handleDjThemeStop(s)();
  const errorCall = s.emit.mock.calls.find(([event]) => event === 'error');
  return { error: errorCall ? errorCall[1] : null, user: s.user };
}

async function runHttp(method, body, path = '') {
  const res = await fetch(`${baseUrl}/api/dj${path}`, {
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

async function runShoutoutsSocket(payload, s = socket()) {
  const ack = vi.fn();
  await handleDjShoutouts(s)(payload, ack);
  const errorCall = s.emit.mock.calls.find(([event]) => event === 'error');
  return { error: errorCall ? errorCall[1] : null, user: s.user, ack };
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
        if (op.method === 'setShoutouts' || op.method === 'getShoutouts') {
          // The member is always the Discord id (R12 Member identity).
          const memberId = surface === 'socket' ? result.user.discord_id : ACTORS[surface].id;
          expect(call[0]).toBe(memberId);
          expect(call.slice(1)).toEqual(op.args);
          return;
        }
        expect(call.slice(0, op.args.length)).toEqual(op.args);
        const socketActor = () => ({ id: result.user.discord_id, name: 'socket-actor' });
        if (op.method === 'startTheme') {
          expect(call[1]).toEqual(surface === 'socket' ? socketActor() : ACTORS[surface]);
          expect(call[2]).toEqual(ORIGINS[surface]);
          return;
        }
        if (op.method === 'stopTheme') {
          expect(call[0]).toEqual(surface === 'socket' ? socketActor() : ACTORS[surface]);
          return;
        }
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

describe('Own shout-outs (FR-019, contracts §3)', () => {
  it('Discord replies ephemerally with the current value', async () => {
    const off = await runDiscord(interaction('shoutouts', {}, { enabled: false }));
    expect(off.ephemeral).toBe(true);
    expect(off.reply).toMatch(/off/);

    const read = await runDiscord(interaction('shoutouts'));
    expect(read.ephemeral).toBe(true);
    expect(read.reply).toMatch(/on/);
  });

  it('HTTP returns { enabled } and the socket acks { enabled }', async () => {
    expect(await runHttp('PUT', { enabled: false }, '/shoutouts/me')).toEqual({
      status: 200,
      body: { enabled: false }
    });
    expect(await runHttp('GET', undefined, '/shoutouts/me')).toEqual({
      status: 200,
      body: { enabled: true }
    });
    const { ack } = await runShoutoutsSocket({ enabled: false });
    expect(ack).toHaveBeenCalledWith({ enabled: false });
  });

  it('DJ_UNAVAILABLE maps identically on every surface', async () => {
    const code = DJ_UNAVAILABLE;
    const text = DJ_MESSAGES[code].text;
    service.setShoutouts = vi.fn(() => {
      throw new DjError(code, 'service text');
    });

    const discord = await runDiscord(interaction('shoutouts', {}, { enabled: false }));
    const httpResult = await runHttp('PUT', { enabled: false }, '/shoutouts/me');
    const socketResult = await runShoutoutsSocket({ enabled: false });

    expect(discord).toEqual({ reply: text, ephemeral: true });
    expect(httpResult).toEqual({ status: 503, body: { code, message: text } });
    expect(socketResult.error).toEqual({ code, message: text });
  });

  describe('a change pushes dj:shoutouts only to that member', () => {
    beforeEach(() => {
      fakeIo.roomEmits = [];
      setupSocketServer({});
    });

    afterEach(() => {
      shutdownSocketServer();
    });

    const CHANGE = {
      discord: () => runDiscord(interaction('shoutouts', {}, { enabled: false })),
      http: () => runHttp('PUT', { enabled: false }, '/shoutouts/me'),
      socket: () =>
        runShoutoutsSocket(
          { enabled: false },
          {
            emit: vi.fn(),
            user: { username: 'socket-actor', discord_id: 'socket-member' }
          }
        )
    };
    const MEMBER = { discord: 'discord-1', http: 'http-1', socket: 'socket-member' };

    for (const surface of SURFACES) {
      it(`${surface}: exactly one dj:shoutouts { enabled } to user:<id>`, async () => {
        await CHANGE[surface]();

        const pushes = fakeIo.roomEmits.filter((e) => e.event === 'dj:shoutouts');
        expect(pushes).toEqual([
          { room: `user:${MEMBER[surface]}`, event: 'dj:shoutouts', payload: { enabled: false } }
        ]);
      });
    }
  });
});

// Theme-start errors (contracts §2). /dj theme defers, so Discord answers with
// editReply; the text is the same shared one.
const THEME_ERRORS = [
  { code: DJ_UNAVAILABLE, http: 503 },
  { code: INVALID_THEME, http: 400 },
  { code: INVALID_LOOKAHEAD, http: 400 },
  { code: NOT_IN_VOICE, http: 409 },
  { code: NO_TRACKS_FOR_THEME, http: 422 },
  { code: SERVICE_UNAVAILABLE, http: 503 },
  { code: CAP_REACHED, http: 429 }
];

describe('theme-start errors map identically on every surface', () => {
  for (const { code, http } of THEME_ERRORS) {
    const text =
      code === CAP_REACHED
        ? DJ_MESSAGES[code].text.replace('HH:MM', '00:00')
        : DJ_MESSAGES[code].text;

    it(`${code}: HTTP ${http}, Discord text, socket error {code,message}`, async () => {
      service.startTheme = vi.fn(async () => {
        throw new DjError(code, 'service text');
      });

      const discord = await runDiscordDeferred(
        interaction('theme', {}, {}, { description: 'rock' })
      );
      const httpResult = await runHttp('POST', { theme: 'rock' }, '/theme');
      const socketResult = await runThemeSocket({ theme: 'rock' });

      expect(httpResult).toEqual({ status: http, body: { code, message: text } });
      expect(discord.reply).toBe(text);
      expect(socketResult.error).toEqual({ code, message: text });
    });
  }
});

describe('Shuffle during themed mode is refused on every surface (FR-024a)', () => {
  let statsEvents;
  const onStats = (event) => statsEvents.push(event);

  beforeEach(() => {
    statsEvents = [];
    botEvents.on(STATS_EVENT, onStats);
    playback.queue = { ...fakeQueue(), length: 2 };
    vi.spyOn(musicManager, 'shuffleQueue').mockReturnValue({
      shuffled: false,
      reason: THEMED_MODE_ACTIVE
    });
  });

  afterEach(() => {
    botEvents.off(STATS_EVENT, onStats);
    musicManager.shuffleQueue.mockRestore();
    playback.queue = null;
  });

  const text = DJ_MESSAGES[THEMED_MODE_ACTIVE].text;

  it('Discord /shuffle replies ephemerally with THEMED_MODE_ACTIVE', async () => {
    const i = interaction(null);
    await discordShuffle(i);
    expect(i.reply).toHaveBeenCalledWith({ content: text, ephemeral: true });
    expect(musicManager.shuffleQueue).toHaveBeenCalledTimes(1);
    expect(statsEvents).toHaveLength(0);
  });

  it('POST /api/queue/shuffle answers 409 THEMED_MODE_ACTIVE', async () => {
    const res = await fetch(`${baseUrl}/api/queue/shuffle`, { method: 'POST' });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ code: THEMED_MODE_ACTIVE, message: text });
    expect(musicManager.shuffleQueue).toHaveBeenCalledTimes(1);
    expect(statsEvents).toHaveLength(0);
  });

  it('socket player:control shuffle emits error THEMED_MODE_ACTIVE', async () => {
    const s = socket();
    await handlePlayerControl(s)({ action: 'shuffle' });
    expect(s.emit).toHaveBeenCalledWith('error', { code: THEMED_MODE_ACTIVE, message: text });
    expect(musicManager.shuffleQueue).toHaveBeenCalledTimes(1);
    expect(statsEvents).toHaveLength(0);
  });
});

describe('Clear / stop during themed mode reach the mediator once on every surface (FR-024b)', () => {
  const METHODS = ['clearQueue', 'clearUpcomingQueue', 'clearAllButCurrent', 'stop'];

  beforeEach(() => {
    playback.queue = fakeQueue();
    for (const m of METHODS) vi.spyOn(musicManager, m).mockReturnValue(true);
  });

  afterEach(() => {
    for (const m of METHODS) musicManager[m].mockRestore();
    playback.queue = null;
  });

  const totalCalls = () => METHODS.reduce((n, m) => n + musicManager[m].mock.calls.length, 0);

  const CASES = [
    ['Discord /clear', 'clearAllButCurrent', () => discordClear(interaction(null))],
    ['Discord /stop', 'stop', () => discordStop(interaction(null))],
    ['DELETE /api/queue', 'clearQueue', () => fetch(`${baseUrl}/api/queue`, { method: 'DELETE' })],
    [
      'POST /api/player/stop',
      'stop',
      () =>
        fetch(`${baseUrl}/api/player/stop`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: '{}'
        })
    ],
    [
      'socket clear',
      'clearUpcomingQueue',
      () => handlePlayerControl(socket())({ action: 'clear' })
    ],
    ['socket stop', 'stop', () => handlePlayerControl(socket())({ action: 'stop' })]
  ];

  for (const [name, method, run] of CASES) {
    it(`${name} calls musicManager.${method}() exactly once`, async () => {
      await run();
      expect(musicManager[method]).toHaveBeenCalledTimes(1);
      expect(totalCalls()).toBe(1);
    });
  }
});

describe('/dj theme replies', () => {
  it('a start defers, then confirms the theme and lookahead', async () => {
    const { reply } = await runDiscordDeferred(
      interaction('theme', { lookahead: 5 }, {}, { description: 'classic rock road trip' })
    );
    expect(reply).toContain('classic rock road trip');
  });

  it('/dj theme-stop replies publicly', async () => {
    service.getStateOrUnavailable = vi.fn(() => THEMED_STATE);
    const { reply, ephemeral } = await runDiscord(interaction('theme-stop'));
    expect(ephemeral).toBe(false);
    expect(reply).toMatch(/off/);
  });

  it('/dj status shows the running theme', async () => {
    service.getStateOrUnavailable = vi.fn(() => THEMED_STATE);
    const { reply } = await runDiscord(interaction('status'));
    expect(reply).toContain('classic rock road trip');
  });
});

describe('a Discord-started theme posts one message per stall to its channel (FR-029)', () => {
  it('posts once per stall and not for other origins', async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    const client = { channels: { fetch: vi.fn().mockResolvedValue({ send }) } };
    const i = interaction('theme', {}, {}, { description: 'rock' });
    i.client = client;
    await handleDj(i);

    service.getThemeOrigin = vi.fn(() => ({ transport: 'discord', channelId: 'text-1' }));
    const stalled = {
      ...THEMED_STATE,
      theme: { ...THEMED_STATE.theme, status: 'stalled', reason: 'THEME_EXHAUSTED' }
    };
    musicManager.emit('dj:state', stalled);
    musicManager.emit('dj:state', stalled);
    await new Promise((r) => setTimeout(r, 0));
    expect(client.channels.fetch).toHaveBeenCalledWith('text-1');
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0][0].content).toMatch(/more tracks/);

    musicManager.emit('dj:state', THEMED_STATE); // running again
    service.getThemeOrigin = vi.fn(() => ({ transport: 'http' }));
    musicManager.emit('dj:state', stalled);
    await new Promise((r) => setTimeout(r, 0));
    expect(send).toHaveBeenCalledTimes(1);
  });
});
