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
  djMock: {
    getState: null,
    getStateOrUnavailable: null,
    setSettings: null,
    startTheme: null,
    stopTheme: null,
    origin: null
  }
}));

vi.mock('../../src/services/dj/djService.js', () => ({
  getState: (...a) => djMock.getState(...a),
  getStateOrUnavailable: (...a) => djMock.getStateOrUnavailable(...a),
  setSettings: (...a) => djMock.setSettings(...a),
  startTheme: (...a) => djMock.startTheme(...a),
  stopTheme: (...a) => djMock.stopTheme(...a),
  getThemeOrigin: () => djMock.origin
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
  client: {
    isReady: vi.fn(() => true),
    guilds: { fetch: vi.fn() },
    channels: { fetch: vi.fn() }
  }
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
import playbackRouter from '../../src/transports/http/routes/playback.js';
import {
  handleDjSettings,
  handleDjThemeStart,
  handleDjThemeStop,
  handlePlayerControl
} from '../../src/transports/realtime/handlers.js';
import {
  handleDj,
  onDjState,
  registerDjStateListener
} from '../../src/transports/discord/commands/dj.js';
import { client } from '../../src/transports/discord/client.js';
import {
  handleClear as discordClear,
  handleShuffle as discordShuffle
} from '../../src/transports/discord/commands/queue.js';
import { handleStop as discordStop } from '../../src/transports/discord/commands/playback.js';
import { botEvents } from '../../src/events/bus.js';
import { STATS_EVENT } from '../../src/shared/statsEvents.js';
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

// The fake queue and player behind the real musicManager.
let fakeQueue;
let fakePlayer;

function makeQueue() {
  const current = { title: 'Current', url: 'https://example.com/current' };
  return {
    tracks: [current, { title: 'Next', url: 'https://example.com/next' }],
    currentIndex: 0,
    loopMode: 'off',
    prioritizeMemberTracks: false,
    get length() {
      return this.tracks.length;
    },
    shuffle() {},
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
  fakePlayer = {
    cancelOverlay: vi.fn(),
    stop: vi.fn(),
    on: vi.fn(),
    isPlaying: vi.fn(() => true),
    isPaused: vi.fn(() => false),
    getPosition: vi.fn(() => 0)
  };
  musicManager.player = fakePlayer;
  musicManager.queue = fakeQueue;
  musicManager.guildId = 'g1';

  djMock.getState = vi.fn(() => djState());
  djMock.getStateOrUnavailable = vi.fn(() => djState());
  djMock.setSettings = vi.fn((partial) => djState(partial));
  djMock.startTheme = vi.fn(async ({ theme }, actor) =>
    djState({
      theme: { theme, startedBy: actor, startedAt: 'now', status: 'running', reason: null }
    })
  );
  djMock.stopTheme = vi.fn(() => djState());

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
  vi.restoreAllMocks();
  musicManager.setOnQueueCleared(null);
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

function interaction(subcommand, integers = {}, strings = {}) {
  return {
    guildId: 'g1',
    channelId: 'chan-1',
    user: { id: 'discord-1', username: 'discord-actor' },
    options: {
      getSubcommand: vi.fn(() => subcommand),
      getInteger: vi.fn((name) => integers[name] ?? null),
      getString: vi.fn((name) => strings[name] ?? null)
    },
    reply: vi.fn().mockResolvedValue(undefined),
    deferReply: vi.fn().mockResolvedValue(undefined),
    editReply: vi.fn().mockResolvedValue(undefined),
    deleteReply: vi.fn().mockResolvedValue(undefined),
    followUp: vi.fn().mockResolvedValue(undefined)
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

// ---------------------------------------------------------------------------
// Themed mode rows (US4, contracts §3)
// ---------------------------------------------------------------------------

/** Discord /dj theme replies via deferReply + editReply, or an ephemeral followUp. */
async function viaDiscordTheme(subcommand, { strings = {}, integers = {} } = {}) {
  const i = interaction(subcommand, integers, strings);
  await handleDj(i);
  const followUp = i.followUp.mock.calls[0]?.[0];
  if (followUp?.ephemeral) return { ok: false, message: followUp.content, i };
  const reply = i.reply.mock.calls[0]?.[0];
  if (reply && typeof reply === 'object' && reply.ephemeral) {
    return { ok: false, message: reply.content, i };
  }
  return { ok: true, i };
}

async function viaHttpTheme(method, body) {
  const res = await fetch(`${baseUrl}/api/dj/theme`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined
  });
  const json = await res.json();
  return res.ok ? { ok: true, status: res.status } : { ok: false, status: res.status, ...json };
}

async function viaSocketHandler(handler, payload) {
  const s = socket();
  await handler(s)(payload);
  const err = s.emit.mock.calls.find(([event]) => event === 'error');
  return err ? { ok: false, ...err[1] } : { ok: true };
}

const THEME_ROWS = [
  {
    name: 'Start / change theme',
    call: 'startTheme',
    http: () => viaHttpTheme('POST', { theme: 'classic rock road trip', lookahead: 5 }),
    socket: () =>
      viaSocketHandler(handleDjThemeStart, { theme: 'classic rock road trip', lookahead: 5 }),
    discord: () =>
      viaDiscordTheme('theme', {
        strings: { description: 'classic rock road trip' },
        integers: { lookahead: 5 }
      }),
    expectArgs: (surface, args) => {
      expect(args[0]).toEqual({ theme: 'classic rock road trip', lookahead: 5 });
      expect(args[2].transport).toBe(surface);
      if (surface === 'discord') expect(args[2].channelId).toBe('chan-1');
    }
  },
  {
    name: 'Stop theme',
    call: 'stopTheme',
    http: () => viaHttpTheme('DELETE'),
    socket: () => viaSocketHandler(handleDjThemeStop),
    discord: () => viaDiscordTheme('theme-stop'),
    expectArgs: () => {}
  }
];

describe('themed-mode rows reach the same djService call on every surface', () => {
  for (const row of THEME_ROWS) {
    for (const surface of SURFACES) {
      it(`${row.name} via ${surface} calls ${row.call} once`, async () => {
        const result = await row[surface]();

        expect(result.ok).toBe(true);
        expect(djMock[row.call]).toHaveBeenCalledTimes(1);
        const args = djMock[row.call].mock.calls[0];
        const actor = row.call === 'startTheme' ? args[1] : args[0];
        expect(actor.id).toBeTruthy();
        expect(actor.name).toBeTruthy();
        if (ACTORS[surface]) expect(actor).toEqual(ACTORS[surface]);
        row.expectArgs(surface, args);
      });
    }
  }

  it('Discord /dj theme defers before calling startTheme and answers with editReply', async () => {
    const order = [];
    djMock.startTheme.mockImplementation(async ({ theme }) => {
      order.push('startTheme');
      return djState({ theme: { theme, status: 'running', reason: null } });
    });
    const i = interaction('theme', {}, { description: 'rock' });
    i.deferReply.mockImplementation(async () => order.push('deferReply'));
    await handleDj(i);
    expect(order).toEqual(['deferReply', 'startTheme']);
    expect(i.editReply).toHaveBeenCalledTimes(1);
    expect(i.reply).not.toHaveBeenCalled();
  });

  it('Discord /dj theme says so when a clear ended themed mode before it started', async () => {
    djMock.startTheme.mockImplementation(async () => djState({ theme: null }));
    const i = interaction('theme', {}, { description: 'rock' });
    await handleDj(i);
    expect(i.editReply).toHaveBeenCalledWith(expect.stringMatching(/cleared/));
    expect(i.followUp).not.toHaveBeenCalled();
  });
});

const THEME_ERRORS = [
  INVALID_THEME,
  NOT_IN_VOICE,
  NO_TRACKS_FOR_THEME,
  SERVICE_UNAVAILABLE,
  CAP_REACHED
];

describe('theme-start errors map identically on every surface (contracts §2)', () => {
  const throwing = (code) =>
    djMock.startTheme.mockImplementation(async () => {
      throw new DjError(code);
    });

  for (const code of THEME_ERRORS) {
    const { http } = DJ_MESSAGES[code];
    // resetsAt in djState() is 00:00 local.
    const text = DJ_MESSAGES[code].text.replace('HH:MM', '00:00');

    it(`${code}: HTTP ${http} { code, message }`, async () => {
      throwing(code);
      expect(await THEME_ROWS[0].http()).toEqual({ ok: false, status: http, code, message: text });
    });

    it(`${code}: socket error { code, message }`, async () => {
      throwing(code);
      expect(await THEME_ROWS[0].socket()).toEqual({ ok: false, code, message: text });
    });

    it(`${code}: Discord ephemeral text`, async () => {
      throwing(code);
      const { ok, message } = await THEME_ROWS[0].discord();
      expect({ ok, message }).toEqual({ ok: false, message: text });
    });
  }
});

describe('Shuffle during themed mode is refused on every surface (FR-024a)', () => {
  const SHUFFLE = {
    discord: async () => {
      const i = interaction('shuffle');
      await discordShuffle(i);
      const [arg] = i.reply.mock.calls[0];
      return arg?.ephemeral ? { ok: false, message: arg.content } : { ok: true };
    },
    http: async () => {
      const res = await fetch(`${baseUrl}/api/queue/shuffle`, { method: 'POST' });
      const json = await res.json();
      return res.ok ? { ok: true } : { ok: false, status: res.status, ...json };
    },
    socket: () => viaSocketHandler(handlePlayerControl, { action: 'shuffle' })
  };
  const { http, text } = DJ_MESSAGES[THEMED_MODE_ACTIVE];
  const EXPECTED = {
    discord: { ok: false, message: text },
    http: { ok: false, status: http, code: THEMED_MODE_ACTIVE, message: text },
    socket: { ok: false, code: THEMED_MODE_ACTIVE, message: text }
  };

  let statsEvents;
  const onStats = (e) => statsEvents.push(e);
  beforeEach(() => {
    statsEvents = [];
    botEvents.on(STATS_EVENT, onStats);
  });
  afterEach(() => botEvents.off(STATS_EVENT, onStats));

  for (const surface of SURFACES) {
    it(`${surface} shuffle maps to THEMED_MODE_ACTIVE and records no shuffle event`, async () => {
      const spy = vi
        .spyOn(musicManager, 'shuffleQueue')
        .mockReturnValue({ shuffled: false, reason: THEMED_MODE_ACTIVE });
      const before = fakeQueue.tracks.slice();

      expect(await SHUFFLE[surface]()).toEqual(EXPECTED[surface]);
      expect(spy).toHaveBeenCalledTimes(1);
      expect(fakeQueue.tracks).toEqual(before);
      expect(statsEvents.filter((e) => e.type === 'shuffle')).toHaveLength(0);
    });

    it(`${surface} shuffle still works and is recorded when themed mode is off`, async () => {
      expect((await SHUFFLE[surface]()).ok).toBe(true);
      expect(statsEvents.filter((e) => e.type === 'shuffle')).toHaveLength(1);
    });
  }

  it('the real musicManager refuses when the queue flag is set', async () => {
    fakeQueue.prioritizeMemberTracks = true;
    expect(await SHUFFLE.http()).toEqual(EXPECTED.http);
  });
});

describe('Clear / stop during themed mode reach musicManager once on every surface (FR-024b)', () => {
  const ROWS = {
    'Discord /clear': () => discordClear(interaction('clear')),
    'Discord /stop': () => discordStop(interaction('stop')),
    'DELETE /api/queue': () => fetch(`${baseUrl}/api/queue`, { method: 'DELETE' }),
    'POST /api/player/stop': () => fetch(`${baseUrl}/api/player/stop`, { method: 'POST' }),
    'socket clear': () => handlePlayerControl(socket())({ action: 'clear' }),
    'socket stop': () => handlePlayerControl(socket())({ action: 'stop' })
  };
  const METHODS = ['clearQueue', 'clearUpcomingQueue', 'clearAllButCurrent', 'stop'];

  for (const [name, run] of Object.entries(ROWS)) {
    it(`${name} calls one musicManager clear/stop method once, firing the cleared hook once`, async () => {
      const spies = METHODS.map((m) => vi.spyOn(musicManager, m));
      const hook = vi.fn();
      musicManager.setOnQueueCleared(hook);

      const res = await run();
      if (res?.status !== undefined) expect(res.status).toBe(200);

      const calls = spies.reduce((sum, spy) => sum + spy.mock.calls.length, 0);
      expect(calls).toBe(1);
      expect(hook).toHaveBeenCalledTimes(1);
    });
  }
});

describe('Discord stall notices (FR-029, Discord-only affordance)', () => {
  let send;
  const theme = (status, reason = null, startedAt = 't1') => ({
    theme: 'rock',
    startedBy: { id: 'discord-1', name: 'discord-actor' },
    startedAt,
    status,
    reason
  });
  const push = async (t) => {
    onDjState(djState({ theme: t }));
    await new Promise((r) => setTimeout(r, 0));
  };

  beforeEach(async () => {
    send = vi.fn().mockResolvedValue(undefined);
    client.channels.fetch.mockReset();
    client.channels.fetch.mockResolvedValue({ send });
    djMock.origin = { transport: 'discord', channelId: 'chan-1' };
    await push(null);
  });

  afterEach(() => {
    djMock.origin = null;
  });

  it('the listener is registered by the bootstrap, once however often it is called', () => {
    musicManager.off('dj:state', onDjState);
    expect(musicManager.listeners('dj:state')).not.toContain(onDjState);
    registerDjStateListener();
    registerDjStateListener();
    expect(musicManager.listeners('dj:state').filter((l) => l === onDjState)).toHaveLength(1);
    musicManager.off('dj:state', onDjState);
  });

  it('posts one message per stall to the originating channel', async () => {
    await push(theme('running'));
    await push(theme('stalled', 'NO_LISTENERS'));
    await push(theme('stalled', 'NO_LISTENERS'));
    expect(client.channels.fetch).toHaveBeenCalledWith('chan-1');
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0][0]).toMatch(/rock/);
    expect(send.mock.calls[0][0]).toMatch(/nobody is in the voice channel/);

    await push(theme('running'));
    await push(theme('stalled', 'THEME_EXHAUSTED'));
    expect(send).toHaveBeenCalledTimes(2);
  });

  it('posts nothing for a theme started on another surface', async () => {
    djMock.origin = { transport: 'http' };
    await push(theme('stalled', 'CAP_REACHED'));
    expect(send).not.toHaveBeenCalled();
  });
});
