import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import express from 'express';

// Principle III / contracts §3: every DJ operation is the same djService call
// with the same arguments on Discord, HTTP and Socket.io, and every coded error
// maps through the one shared table (services/dj/messages.js). The matrix below
// is data: later stories append rows to OPERATIONS and ERROR_CASES.
vi.mock('../../src/services/dj/djService.js', () => ({
  getState: vi.fn(),
  getStateOrUnavailable: vi.fn(),
  setSettings: vi.fn(),
  startTheme: vi.fn(),
  stopTheme: vi.fn(),
  getThemeOrigin: vi.fn(() => null)
}));
vi.mock('../../src/transports/http/middleware/auth.js', () => ({
  authMiddleware: (req, _res, next) => {
    req.user = { username: 'member', discord_id: 'member-1', avatar: null };
    next();
  },
  optionalAuth: (req, _res, next) => {
    req.user = { username: 'member', discord_id: 'member-1', avatar: null };
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
  db: { logEvent: vi.fn(), getHistory: vi.fn(() => []) }
}));
vi.mock('../../src/integrations/youtube.js', () => ({ search: vi.fn() }));
vi.mock('../../src/utils/logger.js', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() }
}));
// The Discord queue commands read the queue through playback.js; it is pointed
// at the same Queue the real musicManager mediates, set up in beforeEach.
const { shared } = vi.hoisted(() => ({ shared: { queue: null, player: null } }));
vi.mock('../../src/services/playback.js', () => ({
  getPlayer: vi.fn(() => shared.player),
  getQueue: vi.fn(() => shared.queue),
  advanceAndPlay: vi.fn().mockResolvedValue({ played: true })
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

import * as djService from '../../src/services/dj/djService.js';
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
import { DJ_ERROR_MESSAGES } from '../../src/services/dj/messages.js';
import { musicManager } from '../../src/core/musicManager.js';
import { Queue } from '../../src/core/queue.js';
import djRouter from '../../src/transports/http/routes/dj.js';
import queueRouter from '../../src/transports/http/routes/queue.js';
import playbackRouter from '../../src/transports/http/routes/playback.js';
import {
  handleDjSettings,
  handleDjThemeStart,
  handleDjThemeStop,
  handlePlayerControl
} from '../../src/transports/realtime/handlers.js';
import { handleDj } from '../../src/transports/discord/commands/dj.js';
import {
  handleClear as discordClear,
  handleShuffle as discordShuffle
} from '../../src/transports/discord/commands/queue.js';
import { handleStop as discordStop } from '../../src/transports/discord/commands/playback.js';
import { botEvents } from '../../src/events/bus.js';
import { STATS_EVENT } from '../../src/shared/statsEvents.js';

const STATE = {
  available: true,
  enabled: false,
  interval: 3,
  lookahead: 5,
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
let socketUserSeq = 0;

beforeEach(async () => {
  vi.clearAllMocks();
  djService.getState.mockReturnValue(STATE);
  djService.getStateOrUnavailable.mockReturnValue(STATE);
  djService.setSettings.mockImplementation((partial) => ({ ...STATE, ...partial }));
  djService.startTheme.mockImplementation(async ({ theme }) => ({
    ...STATE,
    theme: { theme, status: 'running', reason: null }
  }));
  djService.stopTheme.mockImplementation(() => STATE);

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

// A fresh user per socket, so the per-user `dj` throttle never carries over
// between matrix cells.
function socket() {
  socketUserSeq += 1;
  return { emit: vi.fn(), user: { username: 'member', discord_id: `socket-${socketUserSeq}` } };
}

function interaction(subcommand, { integers = {}, strings = {} } = {}) {
  const i = {
    guildId: 'g1',
    channelId: 'text-1',
    user: { id: 'member-1', username: 'member' },
    deferred: false,
    options: {
      getSubcommand: vi.fn(() => subcommand),
      getInteger: vi.fn((name) => integers[name] ?? null),
      getString: vi.fn((name) => strings[name] ?? null)
    },
    reply: vi.fn().mockResolvedValue(undefined),
    editReply: vi.fn().mockResolvedValue(undefined)
  };
  i.deferReply = vi.fn(async () => {
    i.deferred = true;
  });
  return i;
}

const ACTOR = { id: 'member-1', name: 'member' };

/**
 * contracts §3, one row per operation. `service` names the djService method and
 * `args` the exact arguments every surface must pass; each surface returns
 * whatever it needs for the error-mapping checks below.
 */
const OPERATIONS = [
  {
    name: 'Enable',
    service: 'setSettings',
    args: [{ enabled: true }, ACTOR],
    discord: () => interaction('on'),
    http: { method: 'PATCH', body: { enabled: true } },
    socket: { handler: handleDjSettings, payload: { enabled: true } }
  },
  {
    name: 'Disable',
    service: 'setSettings',
    args: [{ enabled: false }, ACTOR],
    discord: () => interaction('off'),
    http: { method: 'PATCH', body: { enabled: false } },
    socket: { handler: handleDjSettings, payload: { enabled: false } }
  },
  {
    name: 'Set interval',
    service: 'setSettings',
    args: [{ interval: 4 }, ACTOR],
    discord: () => interaction('interval', { integers: { every: 4 } }),
    http: { method: 'PATCH', body: { interval: 4 } },
    socket: { handler: handleDjSettings, payload: { interval: 4 } }
  },
  {
    name: 'Set lookahead',
    service: 'setSettings',
    args: [{ lookahead: 10 }, ACTOR],
    discord: () => interaction('lookahead', { integers: { size: 10 } }),
    http: { method: 'PATCH', body: { lookahead: 10 } },
    socket: { handler: handleDjSettings, payload: { lookahead: 10 } }
  },
  {
    name: 'Start / change theme',
    service: 'startTheme',
    args: [{ theme: 'classic rock road trip', lookahead: 5 }, ACTOR],
    origin: {
      discord: { transport: 'discord', channelId: 'text-1' },
      http: { transport: 'http' },
      socket: { transport: 'socket' }
    },
    // Deferred first (the first top-up can outlast Discord's 3 s), so
    // errors arrive through editReply.
    discordDeferred: true,
    errors: [
      DJ_UNAVAILABLE,
      INVALID_THEME,
      INVALID_LOOKAHEAD,
      NOT_IN_VOICE,
      NO_TRACKS_FOR_THEME,
      SERVICE_UNAVAILABLE,
      CAP_REACHED
    ],
    discord: () =>
      interaction('theme', {
        strings: { description: 'classic rock road trip' },
        integers: { lookahead: 5 }
      }),
    http: {
      method: 'POST',
      path: '/theme',
      body: { theme: 'classic rock road trip', lookahead: 5 }
    },
    socket: {
      handler: handleDjThemeStart,
      payload: { theme: 'classic rock road trip', lookahead: 5 }
    }
  },
  {
    name: 'Stop theme',
    service: 'stopTheme',
    args: [ACTOR],
    errors: [DJ_UNAVAILABLE],
    discord: () => interaction('theme-stop'),
    http: { method: 'DELETE', path: '/theme' },
    socket: { handler: handleDjThemeStop, payload: undefined }
  }
];

// Socket actors are per-test users (see socket()), so their id is checked by
// shape rather than literally.
function expectActorArgs(call, row, surface) {
  const actorIndex = row.args.indexOf(ACTOR);
  row.args.forEach((expected, index) => {
    if (index === actorIndex && surface === 'socket') {
      expect(call[index]).toEqual({ id: expect.stringMatching(/^socket-/), name: 'member' });
    } else {
      expect(call[index]).toEqual(expected);
    }
  });
  if (row.origin) {
    expect(call[row.args.length]).toEqual(row.origin[surface]);
  }
  expect(call).toHaveLength(row.args.length + (row.origin ? 1 : 0));
}

const SURFACES = {
  discord: async (row) => {
    const i = row.discord();
    await handleDj(i);
    return { interaction: i };
  },
  http: async (row) => {
    const res = await fetch(`${baseUrl}/api/dj${row.http.path ?? ''}`, {
      method: row.http.method,
      headers: { 'Content-Type': 'application/json' },
      ...(row.http.body ? { body: JSON.stringify(row.http.body) } : {})
    });
    return { res };
  },
  socket: async (row) => {
    const s = socket();
    await row.socket.handler(s)(row.socket.payload);
    return { socket: s };
  }
};

describe('Read state', () => {
  it('Discord /dj status and HTTP GET /api/dj both read getStateOrUnavailable()', async () => {
    const i = interaction('status');
    await handleDj(i);
    const res = await fetch(`${baseUrl}/api/dj`);

    expect(await res.json()).toEqual(STATE);
    expect(djService.getStateOrUnavailable).toHaveBeenCalledTimes(2);
    const content = i.reply.mock.calls[0][0].content;
    expect(content).toContain('Off');
    expect(content).toContain('every 3 tracks');
    expect(content).toContain('2/150');
    expect(content).toContain('00:00');
    expect(djService.setSettings).not.toHaveBeenCalled();
  });

  it('Discord /dj status reports DJ_UNAVAILABLE text when unconfigured; HTTP returns available:false', async () => {
    djService.getStateOrUnavailable.mockReturnValue({ available: false });
    const i = interaction('status');
    await handleDj(i);
    const res = await fetch(`${baseUrl}/api/dj`);

    expect(i.reply).toHaveBeenCalledWith({
      content: DJ_ERROR_MESSAGES[DJ_UNAVAILABLE].text,
      ephemeral: true
    });
    expect(await res.json()).toEqual({ available: false });
  });
});

describe('the same djService call and arguments on every surface', () => {
  for (const row of OPERATIONS) {
    for (const surface of Object.keys(SURFACES)) {
      it(`${row.name} via ${surface}`, async () => {
        await SURFACES[surface](row);

        const mock = djService[row.service];
        expect(mock).toHaveBeenCalledTimes(1);
        expectActorArgs(mock.mock.calls[0], row, surface);
      });
    }
  }

  it('Discord replies publicly to a successful settings change, like /loop', async () => {
    const i = interaction('interval', { integers: { every: 4 } });
    await handleDj(i);
    expect(typeof i.reply.mock.calls[0][0]).toBe('string');
  });
});

const ERROR_CASES = [DJ_UNAVAILABLE, INVALID_INTERVAL, INVALID_LOOKAHEAD];

describe('the same error-code mapping on every surface', () => {
  for (const row of OPERATIONS) {
    for (const code of row.errors ?? ERROR_CASES) {
      it(`${row.name} → ${code}`, async () => {
        djService[row.service].mockImplementation(() => {
          throw new DjError(code);
        });
        const entry = DJ_ERROR_MESSAGES[code];
        const http = entry.http;
        const text = typeof entry.text === 'function' ? entry.text(STATE) : entry.text;

        const { interaction: i } = await SURFACES.discord(row);
        if (row.discordDeferred) {
          expect(i.deferReply).toHaveBeenCalledTimes(1);
          expect(i.editReply).toHaveBeenCalledWith(text);
        } else {
          expect(i.reply).toHaveBeenCalledWith({ content: text, ephemeral: true });
        }

        const { res } = await SURFACES.http(row);
        expect(res.status).toBe(http);
        expect(await res.json()).toEqual({ code, message: text });

        const { socket: s } = await SURFACES.socket(row);
        expect(s.emit).toHaveBeenCalledWith('error', { code, message: text });
      });
    }
  }
});

describe('Clear queue during a DJ line (FR-009)', () => {
  // The real musicManager mediates all three clears, so this proves each
  // surface reaches the mediator rather than mutating the queue directly.
  let player;

  beforeEach(() => {
    const queue = new Queue();
    queue.add({ title: 'Playing', url: 'https://example.com/a' });
    queue.add({ title: 'Next', url: 'https://example.com/b' });
    queue.add({ title: 'Later', url: 'https://example.com/c' });
    player = { on: vi.fn(), cancelOverlay: vi.fn(), currentTrack: queue.getCurrent() };
    shared.queue = queue;
    shared.player = player;
    musicManager.setPlayer(player);
    musicManager.setQueue(queue);
  });

  afterEach(() => {
    musicManager.player = null;
    musicManager.queue = null;
  });

  const CLEARS = {
    discord: () => discordClear(interaction(null)),
    http: () => fetch(`${baseUrl}/api/queue`, { method: 'DELETE' }),
    socket: () => handlePlayerControl(socket())({ action: 'clear' })
  };

  for (const [surface, clear] of Object.entries(CLEARS)) {
    it(`${surface} clear cancels the overlay exactly once`, async () => {
      await clear();
      expect(player.cancelOverlay).toHaveBeenCalledTimes(1);
    });
  }
});

describe('Start theme on Discord defers before calling the service', () => {
  it('deferReply() runs before startTheme and the answer is an editReply', async () => {
    const order = [];
    const i = interaction('theme', { strings: { description: 'rock' } });
    i.deferReply.mockImplementation(async () => {
      order.push('defer');
      i.deferred = true;
    });
    djService.startTheme.mockImplementation(async () => {
      order.push('startTheme');
      return { ...STATE, theme: { theme: 'rock', status: 'running', reason: null } };
    });
    await handleDj(i);
    expect(order).toEqual(['defer', 'startTheme']);
    expect(i.editReply).toHaveBeenCalledWith(expect.stringContaining('rock'));
    expect(djService.startTheme.mock.calls[0][0]).toEqual({ theme: 'rock' });
  });
});

describe('Shuffle during themed mode (FR-024a)', () => {
  let statsEvents;
  const record = (event) => statsEvents.push(event);

  beforeEach(() => {
    const queue = new Queue();
    for (const id of ['a', 'b', 'c']) queue.add({ title: id, url: `https://example.com/${id}` });
    shared.queue = queue;
    shared.player = { on: vi.fn(), cancelOverlay: vi.fn() };
    musicManager.queue = queue;
    vi.spyOn(musicManager, 'shuffleQueue').mockReturnValue({
      shuffled: false,
      reason: THEMED_MODE_ACTIVE
    });
    statsEvents = [];
    botEvents.on(STATS_EVENT, record);
  });

  afterEach(() => {
    botEvents.off(STATS_EVENT, record);
    musicManager.shuffleQueue.mockRestore();
    musicManager.queue = null;
  });

  const { http, text } = DJ_ERROR_MESSAGES[THEMED_MODE_ACTIVE];

  it('Discord /shuffle replies ephemerally with the THEMED_MODE_ACTIVE text', async () => {
    const i = interaction(null);
    await discordShuffle(i);
    expect(musicManager.shuffleQueue).toHaveBeenCalledTimes(1);
    expect(i.reply).toHaveBeenCalledWith({ content: text, ephemeral: true });
    expect(statsEvents).toEqual([]);
  });

  it('POST /api/queue/shuffle answers 409 { code, message }', async () => {
    const res = await fetch(`${baseUrl}/api/queue/shuffle`, { method: 'POST' });
    expect(musicManager.shuffleQueue).toHaveBeenCalledTimes(1);
    expect(res.status).toBe(http);
    expect(await res.json()).toEqual({ code: THEMED_MODE_ACTIVE, message: text });
    expect(statsEvents).toEqual([]);
  });

  it('socket player:control shuffle emits error { code, message }', async () => {
    const s = socket();
    await handlePlayerControl(s)({ action: 'shuffle' });
    expect(musicManager.shuffleQueue).toHaveBeenCalledTimes(1);
    expect(s.emit).toHaveBeenCalledWith('error', { code: THEMED_MODE_ACTIVE, message: text });
    expect(statsEvents).toEqual([]);
  });
});

describe('Clear / stop during themed mode (FR-024b)', () => {
  // The real musicManager mediates every clear and stop; the clear hook is
  // what ends themed mode, so each surface must fire it exactly once.
  let hook;
  const METHODS = ['clearQueue', 'clearUpcomingQueue', 'clearAllButCurrent', 'stop'];

  beforeEach(() => {
    const queue = new Queue();
    for (const id of ['a', 'b', 'c']) queue.add({ title: id, url: `https://example.com/${id}` });
    const player = {
      on: vi.fn(),
      cancelOverlay: vi.fn(),
      stop: vi.fn(),
      isPlaying: vi.fn(() => true),
      isPaused: vi.fn(() => false),
      getPosition: vi.fn(() => 0)
    };
    shared.queue = queue;
    shared.player = player;
    musicManager.setPlayer(player);
    musicManager.setQueue(queue);
    hook = vi.fn();
    musicManager.setOnQueueCleared(hook);
    for (const method of METHODS) vi.spyOn(musicManager, method);
  });

  afterEach(() => {
    for (const method of METHODS) musicManager[method].mockRestore();
    musicManager.setOnQueueCleared(null);
    musicManager.player = null;
    musicManager.queue = null;
  });

  const totalCalls = () => METHODS.reduce((n, m) => n + musicManager[m].mock.calls.length, 0);

  const CASES = {
    'Discord /clear': () => discordClear(interaction(null)),
    'Discord /stop': () => discordStop(interaction(null)),
    'HTTP DELETE /api/queue': () => fetch(`${baseUrl}/api/queue`, { method: 'DELETE' }),
    'HTTP POST /api/player/stop': () => fetch(`${baseUrl}/api/player/stop`, { method: 'POST' }),
    'socket clear': () => handlePlayerControl(socket())({ action: 'clear' }),
    'socket stop': () => handlePlayerControl(socket())({ action: 'stop' })
  };

  for (const [name, run] of Object.entries(CASES)) {
    it(`${name} reaches one musicManager clear/stop method once and fires the hook once`, async () => {
      await run();
      expect(totalCalls()).toBe(1);
      expect(hook).toHaveBeenCalledTimes(1);
    });
  }
});

describe('socket throttle', () => {
  it('throttles a second dj:settings from the same user within 1000 ms', async () => {
    const s = socket();
    const handler = handleDjSettings(s);
    await handler({ enabled: true });
    await handler({ enabled: false });

    expect(djService.setSettings).toHaveBeenCalledTimes(1);
    expect(s.emit).toHaveBeenCalledWith(
      'error',
      expect.objectContaining({ message: expect.any(String) })
    );
  });
});

describe('matrix coverage', () => {
  it('drives every operation through all three surfaces', () => {
    expect(Object.keys(SURFACES).sort()).toEqual(['discord', 'http', 'socket']);
    for (const row of OPERATIONS) {
      expect(row.discord).toBeTypeOf('function');
      expect(row.http).toBeDefined();
      expect(row.socket).toBeDefined();
    }
  });
});
