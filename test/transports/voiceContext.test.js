import { describe, it, expect, vi, beforeEach } from 'vitest';

// R7: client.js must emit `voice:context` on every join or leave of the bot's
// channel, so the DJ can discard a line naming someone who left and the
// dashboard listener list stays current. discord.js is mocked so client.js is
// importable; the mock records the handlers it registers (as in
// voiceLeaveRetention.test.js) so the real VoiceStateUpdate body runs.
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
  db: { clearAllHistory: vi.fn(), clearAllEvents: vi.fn() }
}));
vi.mock('../../src/transports/discord/voiceManager.js', () => ({
  leaveChannel: vi.fn(() => true),
  setChannelCache: vi.fn(),
  getChannelCache: vi.fn(() => null),
  getChannelInfo: vi.fn(() => null),
  getConnection: vi.fn(() => null),
  isConnected: vi.fn(() => true),
  joinChannel: vi.fn()
}));
vi.mock('../../src/transports/discord/inactivityManager.js', () => ({
  startInactivityTimer: vi.fn(),
  cancelInactivityTimer: vi.fn()
}));
vi.mock('../../src/core/musicManager.js', () => ({
  musicManager: {
    guildId: 'g1',
    stop: vi.fn(),
    emitVoiceContext: vi.fn(),
    emitState: vi.fn(),
    setGuildId: vi.fn(),
    setGetBotInfo: vi.fn(),
    setGetChannelInfo: vi.fn(),
    setIsConnected: vi.fn()
  }
}));
vi.mock('../../src/utils/logger.js', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() }
}));

import { musicManager } from '../../src/core/musicManager.js';
import { getChannelCache } from '../../src/transports/discord/voiceManager.js';
import '../../src/transports/discord/client.js';

function voiceStateUpdate(oldChannelId, newChannelId) {
  const member = { user: { id: 'u1', username: 'someone', bot: false } };
  registeredHandlers.get('voiceStateUpdate')[0](
    { guild: { id: 'g1' }, channelId: oldChannelId, member },
    { guild: { id: 'g1' }, channelId: newChannelId, member }
  );
}

function cacheBotChannel({ humans = 1, cachedMembers = true } = {}) {
  const members = { filter: () => ({ size: humans }) };
  getChannelCache.mockReturnValue({
    id: 'chan-1',
    name: 'music',
    members: cachedMembers ? members : undefined,
    fetch: vi.fn().mockResolvedValue({ name: 'music', members })
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  getChannelCache.mockReturnValue(null);
});

describe('voice:context on membership changes (R7)', () => {
  it('a member joining the bot channel emits voice:context once', () => {
    cacheBotChannel({ humans: 2 });
    voiceStateUpdate(null, 'chan-1');
    expect(musicManager.emitVoiceContext).toHaveBeenCalledTimes(1);
  });

  it('a member leaving the bot channel emits voice:context once', () => {
    cacheBotChannel({ humans: 1 });
    voiceStateUpdate('chan-1', null);
    expect(musicManager.emitVoiceContext).toHaveBeenCalledTimes(1);
  });

  it('also emits on the fetch fallback path', async () => {
    cacheBotChannel({ humans: 1, cachedMembers: false });
    voiceStateUpdate('chan-1', 'other');
    await Promise.resolve();
    await Promise.resolve();
    expect(musicManager.emitVoiceContext).toHaveBeenCalledTimes(1);
  });

  it('an update in an unrelated channel emits nothing', () => {
    cacheBotChannel();
    voiceStateUpdate('other-a', 'other-b');
    expect(musicManager.emitVoiceContext).not.toHaveBeenCalled();
  });

  it('with no cached bot channel it emits nothing', () => {
    voiceStateUpdate(null, 'chan-1');
    expect(musicManager.emitVoiceContext).not.toHaveBeenCalled();
  });
});
