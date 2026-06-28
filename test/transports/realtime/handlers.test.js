import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// handlers.js transitively imports the music manager, the Discord client, the
// voice manager, and the track resolver (all native/network). Each is mocked so
// the handler factories run in isolation. We exercise two behaviors that are
// pure handler logic: the per-user throttle on `queue:add`, and the truncation
// `notice` emission when a Spotify source is capped.
vi.mock('../../../src/core/musicManager.js', () => ({
  musicManager: {
    guildId: 'g1',
    addTracks: vi.fn(),
    ensurePlaying: vi.fn().mockResolvedValue(undefined)
  }
}));
vi.mock('../../../src/transports/discord/voiceManager.js', () => ({
  isConnected: vi.fn(() => true),
  joinChannel: vi.fn(),
  leaveChannel: vi.fn(),
  setChannelCache: vi.fn()
}));
vi.mock('../../../src/transports/discord/client.js', () => ({
  client: { isReady: vi.fn(() => true), guilds: { fetch: vi.fn() } }
}));
vi.mock('../../../src/services/trackResolver.js', () => ({ resolveQuery: vi.fn() }));
vi.mock('../../../src/utils/logger.js', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() }
}));

import { handleQueueAdd } from '../../../src/transports/realtime/handlers.js';
import { musicManager } from '../../../src/core/musicManager.js';
import { resolveQuery } from '../../../src/services/trackResolver.js';

function makeSocket(userId) {
  return {
    emit: vi.fn(),
    user: { discord_id: userId, username: 'tester' }
  };
}

describe('handleQueueAdd throttle', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    // Pin the clock so the per-user throttle (keyed on Date.now) is deterministic.
    vi.setSystemTime(new Date('2026-06-28T00:00:00Z'));
    resolveQuery.mockResolvedValue({ tracks: [{ id: 't1' }], truncation: null });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('accepts the first add then throttles an immediate second add from the same user', async () => {
    // Unique user id so prior tests cannot leave throttle state for this key.
    const socket = makeSocket('throttle-user-1');
    const handler = handleQueueAdd(socket);

    await handler({ query: 'first song' });
    expect(musicManager.addTracks).toHaveBeenCalledTimes(1);

    // Second call within the 1000ms window -> rejected with an error notice and
    // no further resolution/add.
    await handler({ query: 'second song' });
    expect(musicManager.addTracks).toHaveBeenCalledTimes(1);
    expect(socket.emit).toHaveBeenCalledWith('error', {
      message: 'You are adding tracks too quickly. Please slow down.'
    });
  });

  it('accepts a second add once the throttle window has elapsed', async () => {
    const socket = makeSocket('throttle-user-2');
    const handler = handleQueueAdd(socket);

    await handler({ query: 'first song' });
    expect(musicManager.addTracks).toHaveBeenCalledTimes(1);

    // Advance past the 1000ms queue:add window.
    vi.advanceTimersByTime(1001);

    await handler({ query: 'second song' });
    expect(musicManager.addTracks).toHaveBeenCalledTimes(2);
  });
});

describe('handleQueueAdd truncation notice', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('emits a notice when the resolved source was truncated', async () => {
    resolveQuery.mockResolvedValue({
      tracks: [{ id: 't1' }],
      truncation: { returned: 50, total: 120, cap: 50 }
    });
    const socket = makeSocket('truncation-user');
    const handler = handleQueueAdd(socket);

    await handler({ query: 'big playlist' });

    expect(musicManager.addTracks).toHaveBeenCalledTimes(1);
    expect(socket.emit).toHaveBeenCalledWith('notice', {
      message: 'Added 50 of 120 tracks (playlist capped at 50).'
    });
  });

  it('does not emit a notice when nothing was truncated', async () => {
    resolveQuery.mockResolvedValue({ tracks: [{ id: 't1' }], truncation: null });
    const socket = makeSocket('no-truncation-user');
    const handler = handleQueueAdd(socket);

    await handler({ query: 'one song' });

    expect(musicManager.addTracks).toHaveBeenCalledTimes(1);
    const noticeCall = socket.emit.mock.calls.find(([event]) => event === 'notice');
    expect(noticeCall).toBeUndefined();
  });
});
