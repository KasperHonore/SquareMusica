import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import express from 'express';

// Principle III / contracts §3: every DJ operation is the same djService call
// with the same arguments on Discord, HTTP and Socket.io, and every coded error
// maps through the one shared table (services/dj/messages.js). The matrix below
// is data: later stories append rows to OPERATIONS and ERROR_CASES.
vi.mock('../../src/services/dj/djService.js', () => ({
  getState: vi.fn(),
  getStateOrUnavailable: vi.fn(),
  setSettings: vi.fn()
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
  INVALID_LOOKAHEAD
} from '../../src/services/dj/errors.js';
import { DJ_ERROR_MESSAGES } from '../../src/services/dj/messages.js';
import { musicManager } from '../../src/core/musicManager.js';
import { Queue } from '../../src/core/queue.js';
import djRouter from '../../src/transports/http/routes/dj.js';
import queueRouter from '../../src/transports/http/routes/queue.js';
import { handleDjSettings, handlePlayerControl } from '../../src/transports/realtime/handlers.js';
import { handleDj } from '../../src/transports/discord/commands/dj.js';
import { handleClear as discordClear } from '../../src/transports/discord/commands/queue.js';

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

// A fresh user per socket, so the per-user `dj` throttle never carries over
// between matrix cells.
function socket() {
  socketUserSeq += 1;
  return { emit: vi.fn(), user: { username: 'member', discord_id: `socket-${socketUserSeq}` } };
}

function interaction(subcommand, { integers = {} } = {}) {
  return {
    guildId: 'g1',
    user: { id: 'member-1', username: 'member' },
    options: {
      getSubcommand: vi.fn(() => subcommand),
      getInteger: vi.fn((name) => integers[name] ?? null),
      getString: vi.fn(() => null)
    },
    reply: vi.fn().mockResolvedValue(undefined)
  };
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
  }
];

// Socket actors are per-test users (see socket()), so their id is checked by
// shape rather than literally.
function expectActorArgs(call, row, surface) {
  const [partial, actor] = call;
  expect(partial).toEqual(row.args[0]);
  if (surface === 'socket') {
    expect(actor).toEqual({ id: expect.stringMatching(/^socket-/), name: 'member' });
  } else {
    expect(actor).toEqual(row.args[1]);
  }
}

const SURFACES = {
  discord: async (row) => {
    const i = row.discord();
    await handleDj(i);
    return { interaction: i };
  },
  http: async (row) => {
    const res = await fetch(`${baseUrl}/api/dj`, {
      method: row.http.method,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(row.http.body)
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
  for (const code of ERROR_CASES) {
    for (const row of OPERATIONS) {
      it(`${row.name} → ${code}`, async () => {
        djService[row.service].mockImplementation(() => {
          throw new DjError(code);
        });
        const { http, text } = DJ_ERROR_MESSAGES[code];

        const { interaction: i } = await SURFACES.discord(row);
        expect(i.reply).toHaveBeenCalledWith({ content: text, ephemeral: true });

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
