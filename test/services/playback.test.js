import { describe, it, expect, vi, beforeEach } from 'vitest';

// services/playback.js transitively imports the mediator, voice manager, and
// player/queue, which in turn open the database and Discord client. We mock all
// of those so the unit under test (advanceAndPlay) runs in isolation with no
// native/DB side effects.
vi.mock('../../src/core/player.js', () => ({ MusicPlayer: class {} }));
vi.mock('../../src/core/queue.js', () => ({ Queue: class {} }));
vi.mock('../../src/core/musicManager.js', () => ({
  musicManager: {
    emit: vi.fn(),
    emitState: vi.fn(),
    emitQueueUpdate: vi.fn()
  }
}));
vi.mock('../../src/services/resolutionManager.js', () => ({
  resolutionManager: {
    processLookahead: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn(),
    processingTracks: { clear: vi.fn() }
  }
}));
vi.mock('../../src/services/trackResolver.js', () => ({ tryPlayWithFallback: vi.fn() }));
vi.mock('../../src/transports/discord/voiceManager.js', () => ({ getConnection: vi.fn() }));
vi.mock('../../src/utils/logger.js', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() }
}));

import { advanceAndPlay } from '../../src/services/playback.js';
import { musicManager } from '../../src/core/musicManager.js';
import { resolutionManager } from '../../src/services/resolutionManager.js';
import { tryPlayWithFallback } from '../../src/services/trackResolver.js';

const connection = { id: 'conn' };

describe('advanceAndPlay', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('on success: triggers lookahead at the current index and emits a queue update, without stopping', async () => {
    const track = { id: 'a' };
    tryPlayWithFallback.mockResolvedValue({ played: true, track });
    const player = { stop: vi.fn() };
    const queue = { currentIndex: 3 };

    const result = await advanceAndPlay({ player, queue, connection, skipCurrent: true });

    expect(result).toEqual({ played: true, track });
    expect(tryPlayWithFallback).toHaveBeenCalledWith(player, queue, connection, true);
    expect(resolutionManager.processLookahead).toHaveBeenCalledWith(3);
    expect(musicManager.emitQueueUpdate).toHaveBeenCalledTimes(1);
    expect(player.stop).not.toHaveBeenCalled();
    expect(musicManager.emit).not.toHaveBeenCalled();
    expect(musicManager.emitState).not.toHaveBeenCalled();
  });

  it('on fallthrough to a later track: still counts as played and uses the advanced index', async () => {
    const track = { id: 'c' };
    tryPlayWithFallback.mockResolvedValue({ played: true, track });
    const player = { stop: vi.fn() };
    const queue = { currentIndex: 2 };

    // skipCurrent defaults to true when omitted.
    const result = await advanceAndPlay({ player, queue, connection });

    expect(result).toEqual({ played: true, track });
    expect(tryPlayWithFallback).toHaveBeenCalledWith(player, queue, connection, true);
    expect(resolutionManager.processLookahead).toHaveBeenCalledWith(2);
    expect(player.stop).not.toHaveBeenCalled();
  });

  it('on empty/exhausted queue: stops the player, clears now-playing, and emits a queue update', async () => {
    tryPlayWithFallback.mockResolvedValue({ played: false, track: null });
    const player = { stop: vi.fn() };
    const queue = { currentIndex: 0 };

    const result = await advanceAndPlay({ player, queue, connection, skipCurrent: true });

    expect(result).toEqual({ played: false, track: null });
    expect(player.stop).toHaveBeenCalledTimes(1);
    expect(musicManager.emit).toHaveBeenCalledWith('track:change', null);
    expect(musicManager.emitState).toHaveBeenCalledTimes(1);
    expect(musicManager.emitQueueUpdate).toHaveBeenCalledTimes(1);
    expect(resolutionManager.processLookahead).not.toHaveBeenCalled();
  });
});
