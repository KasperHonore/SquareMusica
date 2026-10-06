import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import express from 'express';

// Transport parity for the AI DJ (contracts/dj-api.md §3, Constitution III).
// Each row of the operation matrix is driven through Discord, HTTP and Socket
// against a mocked djService, and must reach the same service call with the same
// arguments, and map the same coded error to each surface's reply format.
//
// The matrix is a table on purpose: US3 (shout-outs) and US4 (themes) append rows.
const { djService } = vi.hoisted(() => {
  const state = {
    available: true,
    enabled: false,
    interval: 3,
    lookahead: 5,
    health: 'ok',
    caps: {
      lines: { used: 2, limit: 150, reached: false },
      themedTracks: { used: 0, limit: 100, reached: false },
      resetsAt: '2026-10-07T00:00:00+02:00'
    },
    theme: null
  };
  return {
    djService: {
      state,
      getState: vi.fn(() => state),
      getStateOrUnavailable: vi.fn(() => state),
      setSettings: vi.fn(() => state)
    }
  };
});

vi.mock('../../src/services/dj/djService.js', () => ({
  getState: djService.getState,
  getStateOrUnavailable: djService.getStateOrUnavailable,
  setSettings: djService.setSettings
}));
vi.mock('../../src/transports/http/middleware/auth.js', () => ({
  authMiddleware: (req, _res, next) => {
    req.user = { id: 77, username: 'http-actor', discord_id: 'member-1' };
    next();
  },
  optionalAuth: (req, _res, next) => {
    req.user = { id: 77, username: 'http-actor', discord_id: 'member-1' };
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
vi.mock('../../src/services/resolutionManager.js', () => ({
  resolutionManager: {
    processLookahead: vi.fn(),
    stop: vi.fn(),
    start: vi.fn(),
    setQueue: vi.fn(),
    on: vi.fn(),
    processingTracks: new Set()
  }
}));

// The clear row runs through the REAL mediator, so each surface's clear path is
// what calls cancelOverlay. Only the player is fake.
const { fakePlayer, queueHolder } = vi.hoisted(() => ({
  fakePlayer: { cancelOverlay: null, on: () => {} },
  queueHolder: { queue: null }
}));
vi.mock('../../src/services/playback.js', () => ({
  getPlayer: vi.fn(() => fakePlayer),
  getQueue: vi.fn(() => queueHolder.queue),
  advanceAndPlay: vi.fn().mockResolvedValue({ played: true })
}));

import { DjError } from '../../src/services/dj/errors.js';
import { DJ_ERROR_MESSAGES } from '../../src/services/dj/messages.js';
import { musicManager } from '../../src/core/musicManager.js';
import { Queue } from '../../src/core/queue.js';
import djRouter from '../../src/transports/http/routes/dj.js';
import queueRouter from '../../src/transports/http/routes/queue.js';
import { handleDjSettings, handlePlayerControl } from '../../src/transports/realtime/handlers.js';
import { handleDj } from '../../src/transports/discord/commands/dj.js';
import { handleClear as discordClear } from '../../src/transports/discord/commands/queue.js';

let server;
let baseUrl;
let socketSeq = 0;

beforeEach(async () => {
  vi.clearAllMocks();
  djService.getState.mockImplementation(() => djService.state);
  djService.getStateOrUnavailable.mockImplementation(() => djService.state);
  djService.setSettings.mockImplementation(() => djService.state);

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

/** A socket for a fresh user each time, so the per-user `dj` throttle never interferes. */
function socket() {
  socketSeq++;
  return {
    emit: vi.fn(),
    user: { id: 77, username: 'socket-actor', discord_id: `member-${socketSeq}` }
  };
}

function interaction(subcommand, ints = {}) {
  return {
    guildId: 'g1',
    user: { id: 'member-1', username: 'discord-actor' },
    options: {
      getSubcommand: vi.fn(() => subcommand),
      getInteger: vi.fn((name) => ints[name] ?? null),
      getString: vi.fn(() => null)
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

/**
 * The operation matrix (contracts §3). Each row names the service method and
 * the arguments it must receive, plus one trigger per transport.
 */
const OPERATIONS = [
  {
    name: 'Read state',
    method: 'getStateOrUnavailable',
    args: [],
    discord: () => handleDj(interaction('status')),
    http: () => fetch(`${baseUrl}/api/dj`),
    // Pushed via dj:state and initial:state; the socket has no read request.
    socket: null
  },
  {
    name: 'Enable',
    method: 'setSettings',
    args: [{ enabled: true }],
    discord: () => handleDj(interaction('on')),
    http: () => patch({ enabled: true }),
    socket: () => handleDjSettings(socket())({ enabled: true })
  },
  {
    name: 'Disable',
    method: 'setSettings',
    args: [{ enabled: false }],
    discord: () => handleDj(interaction('off')),
    http: () => patch({ enabled: false }),
    socket: () => handleDjSettings(socket())({ enabled: false })
  },
  {
    name: 'Set interval',
    method: 'setSettings',
    args: [{ interval: 4 }],
    discord: () => handleDj(interaction('interval', { every: 4 })),
    http: () => patch({ interval: 4 }),
    socket: () => handleDjSettings(socket())({ interval: 4 })
  },
  {
    name: 'Set lookahead',
    method: 'setSettings',
    args: [{ lookahead: 10 }],
    discord: () => handleDj(interaction('lookahead', { size: 10 })),
    http: () => patch({ lookahead: 10 }),
    socket: () => handleDjSettings(socket())({ lookahead: 10 })
  }
];

const TRANSPORTS = ['discord', 'http', 'socket'];

describe('DJ operation matrix: same service call and arguments on every transport', () => {
  for (const op of OPERATIONS) {
    for (const transport of TRANSPORTS) {
      if (!op[transport]) continue;
      it(`${op.name} via ${transport} calls ${op.method}(${JSON.stringify(op.args)})`, async () => {
        await op[transport]();

        const fn = djService[op.method];
        expect(fn).toHaveBeenCalledTimes(1);
        // The partial (first argument) is identical across transports.
        for (let i = 0; i < op.args.length; i++) {
          expect(fn.mock.calls[0][i]).toEqual(op.args[i]);
        }
        if (op.method === 'setSettings') {
          // The actor is keyed by Discord user id, never the internal users.id.
          const actor = fn.mock.calls[0][1];
          expect(actor.id).toMatch(/^member-/);
          expect(actor.name).toBeTruthy();
        }
      });
    }
  }

  it('resolves the same member to the same actor id on HTTP and Discord', async () => {
    await patch({ enabled: true });
    await handleDj(interaction('on'));

    const [httpCall, discordCall] = djService.setSettings.mock.calls;
    expect(httpCall[1].id).toBe('member-1');
    expect(discordCall[1].id).toBe('member-1');
  });
});

/**
 * One error per code the settings rows can raise. Each transport must surface
 * the same code with the shared text: HTTP status + `{ code, message }`, Discord
 * ephemeral text, socket `error { code, message }`.
 */
const SETTINGS_ERRORS = [
  { code: 'DJ_UNAVAILABLE', partial: { enabled: true }, sub: ['on'] },
  { code: 'INVALID_INTERVAL', partial: { interval: 11 }, sub: ['interval', { every: 11 }] },
  { code: 'INVALID_LOOKAHEAD', partial: { lookahead: 7 }, sub: ['lookahead', { size: 7 }] }
];

describe('DJ error-code mapping is identical on every transport', () => {
  for (const { code, partial, sub } of SETTINGS_ERRORS) {
    const { http, text } = DJ_ERROR_MESSAGES[code];

    describe(code, () => {
      beforeEach(() => {
        djService.setSettings.mockImplementation(() => {
          throw new DjError(code);
        });
      });

      it(`${code} → HTTP ${http} { code, message }`, async () => {
        const res = await patch(partial);

        expect(res.status).toBe(http);
        expect(await res.json()).toEqual({ code, message: text });
      });

      it(`${code} → Discord ephemeral text`, async () => {
        const i = interaction(...sub);
        await handleDj(i);

        expect(i.reply).toHaveBeenCalledWith({ content: text, ephemeral: true });
      });

      it(`${code} → socket error { code, message }`, async () => {
        const s = socket();
        await handleDjSettings(s)(partial);

        expect(s.emit).toHaveBeenCalledWith('error', { code, message: text });
      });
    });
  }

  it('maps the contract HTTP statuses', () => {
    expect(DJ_ERROR_MESSAGES.DJ_UNAVAILABLE.http).toBe(503);
    expect(DJ_ERROR_MESSAGES.INVALID_INTERVAL.http).toBe(400);
    expect(DJ_ERROR_MESSAGES.INVALID_LOOKAHEAD.http).toBe(400);
  });
});

describe('Read state when the DJ is not configured', () => {
  beforeEach(() => {
    djService.getStateOrUnavailable.mockImplementation(() => ({ available: false }));
  });

  it('HTTP returns { available: false }', async () => {
    const res = await fetch(`${baseUrl}/api/dj`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ available: false });
  });

  it('Discord /dj status replies ephemerally with the shared unavailable text', async () => {
    const i = interaction('status');
    await handleDj(i);
    expect(i.reply).toHaveBeenCalledWith({
      content: DJ_ERROR_MESSAGES.DJ_UNAVAILABLE.text,
      ephemeral: true
    });
  });
});

describe('Clear queue during a DJ line cancels the overlay once on every transport (FR-009)', () => {
  beforeEach(() => {
    fakePlayer.cancelOverlay = vi.fn();
    const q = new Queue();
    q.add({ title: 'Now', url: 'https://example.com/now' });
    q.add({ title: 'Next', url: 'https://example.com/next' });
    q.add({ title: 'Later', url: 'https://example.com/later' });
    queueHolder.queue = q;
    // Wire the real mediator to the fake player and the real queue directly;
    // setPlayer/setQueue would start the resolution machinery.
    musicManager.player = fakePlayer;
    musicManager.queue = q;
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

  for (const transport of TRANSPORTS) {
    it(`${transport} clear calls player.cancelOverlay() exactly once`, async () => {
      const res = await CLEARS[transport]();
      if (res?.status) expect(res.status).toBe(200);

      expect(fakePlayer.cancelOverlay).toHaveBeenCalledTimes(1);
    });
  }
});

describe('matrix coverage', () => {
  it('covers every settings row of contracts §3 on every transport that has it', () => {
    expect(OPERATIONS.map((o) => o.name)).toEqual([
      'Read state',
      'Enable',
      'Disable',
      'Set interval',
      'Set lookahead'
    ]);
    for (const op of OPERATIONS) {
      expect(op.discord).toBeTypeOf('function');
      expect(op.http).toBeTypeOf('function');
    }
  });
});
