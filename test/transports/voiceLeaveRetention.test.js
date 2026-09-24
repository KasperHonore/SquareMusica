import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// FR-026: play history must survive a voice leave. Before this feature all four
// leave paths wiped it, which reset every figure on the DJ stats page each time
// the bot left a channel. These tests pin the three user-reachable leave routes
// (inactivity timeout — both channel-resolution paths, /leave, and the dashboard
// control) to "clears nothing, emits no historyCleared", and the guild-removal
// route (FR-027) to "clears both tables".
//
// The wipe is asserted absent at two levels: no db.clearAll* call, and no
// `historyCleared` emission. The second matters on its own — the dashboard
// refetches history on that event, so an emission without a clear would still
// look like a wipe to every connected client.
//
// discord.js is mocked so client.js is importable: it builds a Client and
// registers its listeners at import time. The mock records every registered
// handler so the real GuildDelete and VoiceStateUpdate bodies can be invoked,
// rather than a test-local copy of them.
// vi.hoisted, because vi.mock factories are hoisted above ordinary consts and
// the mock's Client registers handlers into this map at import time.
const { registeredHandlers } = vi.hoisted(() => ({ registeredHandlers: new Map() }));

vi.mock('discord.js', () => {
  class FakeClient {
    constructor() {
      this.user = { id: 'bot-1', tag: 'bot#0001', username: 'bot' };
      this.guilds = { cache: { size: 0, forEach: vi.fn() }, fetch: vi.fn() };
    }
    on(event, handler) {
      if (!registeredHandlers.has(event)) registeredHandlers.set(event, []);
      registeredHandlers.get(event).push(handler);
      return this;
    }
    once(event, handler) {
      return this.on(event, handler);
    }
    isReady() {
      return true;
    }
    login() {
      return Promise.resolve('token');
    }
    destroy() {}
  }

  return {
    Client: FakeClient,
    GatewayIntentBits: { Guilds: 1, GuildVoiceStates: 2, GuildMessages: 4 },
    Events: {
      GuildDelete: 'guildDelete',
      VoiceStateUpdate: 'voiceStateUpdate',
      InteractionCreate: 'interactionCreate'
    },
    EmbedBuilder: class {}
  };
});

vi.mock('../../src/persistence/db.js', () => ({
  db: {
    clearAllHistory: vi.fn(() => 3),
    clearAllEvents: vi.fn(() => 2),
    getHistory: vi.fn(() => []),
    findOrCreateUser: vi.fn(),
    getUserById: vi.fn(),
    getSessionByToken: vi.fn()
  }
}));
vi.mock('../../src/transports/discord/voiceManager.js', () => ({
  leaveChannel: vi.fn(() => true),
  setChannelCache: vi.fn(),
  getChannelCache: vi.fn(() => null),
  getChannelInfo: vi.fn(() => null),
  getConnection: vi.fn(() => ({ id: 'conn-1' })),
  isConnected: vi.fn(() => true),
  joinChannel: vi.fn()
}));
vi.mock('../../src/core/musicManager.js', () => ({
  musicManager: {
    guildId: 'g1',
    stop: vi.fn(() => true),
    emitVoiceContext: vi.fn(),
    emitState: vi.fn(),
    setGuildId: vi.fn(),
    setGetBotInfo: vi.fn(),
    setGetChannelInfo: vi.fn(),
    setIsConnected: vi.fn()
  }
}));
vi.mock('../../src/services/trackResolver.js', () => ({ resolveQuery: vi.fn() }));
vi.mock('../../src/utils/logger.js', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() }
}));

import { db } from '../../src/persistence/db.js';
import { musicManager } from '../../src/core/musicManager.js';
import { leaveChannel, getChannelCache } from '../../src/transports/discord/voiceManager.js';
import { botEvents } from '../../src/events/bus.js';
import { handleLeave } from '../../src/transports/discord/commands/voice.js';
import { handleVoiceLeave } from '../../src/transports/realtime/handlers.js';
// Imported for its import-time listener registration, captured by the mock above.
import '../../src/transports/discord/client.js';

/** The real handler client.js registered for the given Discord event. */
function handlerFor(event) {
  const handlers = registeredHandlers.get(event);
  expect(handlers, `no handler registered for ${event}`).toBeTruthy();
  return handlers[0];
}

let historyClearedSpy;

beforeEach(() => {
  vi.clearAllMocks();
  historyClearedSpy = vi.fn();
  botEvents.removeAllListeners('historyCleared');
  botEvents.on('historyCleared', historyClearedSpy);
});

afterEach(() => {
  botEvents.removeAllListeners('historyCleared');
});

function expectNoWipe() {
  expect(db.clearAllHistory).not.toHaveBeenCalled();
  expect(db.clearAllEvents).not.toHaveBeenCalled();
  expect(historyClearedSpy).not.toHaveBeenCalled();
}

/**
 * Drive client.js's VoiceStateUpdate handler to the "last human left" branch and
 * fire the inactivity timer it starts. `cachedMembers` chooses which of the two
 * duplicated channel-resolution paths runs: a Collection-like `members` takes the
 * cached path, and omitting it forces the `.fetch()` fallback path. Both paths
 * contain their own copy of the leave block, which is why both are covered.
 */
async function runInactivityLeave({ useCachedPath }) {
  const emptyMembers = { filter: () => ({ size: 0 }) };
  const botChannel = {
    id: 'chan-1',
    name: 'music',
    members: useCachedPath ? emptyMembers : undefined,
    fetch: vi.fn().mockResolvedValue({ name: 'music', members: emptyMembers })
  };
  getChannelCache.mockReturnValue(botChannel);

  const oldState = { guild: { id: 'g1' }, channelId: 'chan-1', member: null };
  const newState = {
    guild: { id: 'g1' },
    channelId: null,
    member: { user: { id: 'u1', username: 'someone', bot: false } }
  };

  handlerFor('voiceStateUpdate')(oldState, newState);

  if (!useCachedPath) {
    // Let the fallback .fetch() promise settle so the timer gets started.
    await Promise.resolve();
    await Promise.resolve();
    expect(botChannel.fetch).toHaveBeenCalled();
  }

  // The inactivity timer is 2 minutes; run past it to fire the leave callback.
  await vi.advanceTimersByTimeAsync(2 * 60 * 1000 + 1000);
}

describe('FR-026: play history survives a voice leave', () => {
  it('survives the /leave Discord command', async () => {
    const interaction = { guildId: 'g1', reply: vi.fn().mockResolvedValue(undefined) };

    await handleLeave(interaction);

    expect(leaveChannel).toHaveBeenCalledWith('g1');
    expect(musicManager.stop).toHaveBeenCalled();
    expectNoWipe();
  });

  it('survives the dashboard leave control', async () => {
    const socket = { emit: vi.fn(), user: { discord_id: 'd1', username: 'tester' } };

    await handleVoiceLeave(socket)();

    expect(leaveChannel).toHaveBeenCalledWith('g1');
    expect(musicManager.stop).toHaveBeenCalled();
    expect(socket.emit).not.toHaveBeenCalledWith('error', expect.anything());
    expectNoWipe();
  });

  it('survives the inactivity timeout on the cached-channel path', async () => {
    vi.useFakeTimers();
    try {
      await runInactivityLeave({ useCachedPath: true });

      expect(leaveChannel).toHaveBeenCalledWith('g1');
      expect(musicManager.stop).toHaveBeenCalled();
      expectNoWipe();
    } finally {
      vi.useRealTimers();
    }
  });

  it('survives the inactivity timeout on the fallback-fetch path', async () => {
    // The second, easily-missed copy of the leave block: fixing only the cached
    // path leaves the wipe firing whenever the channel cache misses.
    vi.useFakeTimers();
    try {
      await runInactivityLeave({ useCachedPath: false });

      expect(leaveChannel).toHaveBeenCalledWith('g1');
      expect(musicManager.stop).toHaveBeenCalled();
      expectNoWipe();
    } finally {
      vi.useRealTimers();
    }
  });

  it('leaves no clearHistory method on the mediator for a future caller to find', async () => {
    // T006 deleted musicManager.clearHistory() once its last caller went. If it
    // comes back, all four leave paths have a one-line wipe available again.
    const actual = await vi.importActual('../../src/core/musicManager.js');
    expect(actual.musicManager.clearHistory).toBeUndefined();
  });
});

describe('FR-027: guild removal clears history and events together', () => {
  it('clears both tables in the same operation', () => {
    handlerFor('guildDelete')({ id: 'g1', name: 'Test Guild' });

    expect(db.clearAllHistory).toHaveBeenCalledTimes(1);
    expect(db.clearAllEvents).toHaveBeenCalledTimes(1);
  });

  it('still emits historyCleared so the dashboard refetches', () => {
    handlerFor('guildDelete')({ id: 'g1', name: 'Test Guild' });

    expect(historyClearedSpy).toHaveBeenCalledWith('g1');
  });
});
