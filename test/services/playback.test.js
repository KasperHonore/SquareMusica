import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// services/playback.js transitively imports the mediator, voice manager, and
// player/queue, which in turn open the database and Discord client. We mock all
// of those so the unit under test (advanceAndPlay) runs in isolation with no
// native/DB side effects.
vi.mock('../../src/core/player.js', async () => {
  const { EventEmitter } = await import('events');
  // An emitter, not a bare class: getPlayer() registers real trackEnd/trackFailed
  // listeners on it, and the trackEnd handler is where track_complete is recorded.
  return {
    MusicPlayer: class extends EventEmitter {
      constructor() {
        super();
        this.stop = vi.fn();
      }
    }
  };
});
vi.mock('../../src/core/queue.js', () => ({ Queue: class {} }));
vi.mock('../../src/core/musicManager.js', () => ({
  musicManager: {
    guildId: 'g1',
    emit: vi.fn(),
    emitState: vi.fn(),
    emitQueueUpdate: vi.fn(),
    setPlayer: vi.fn(),
    setQueue: vi.fn(),
    setGetConnection: vi.fn(),
    getCurrentTrack: vi.fn(() => ({
      title: 'Finished Song',
      url: 'https://example.com/finished',
      requestedById: 'queuer-1',
      requestedBy: 'queuer'
    }))
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

import { advanceAndPlay, getPlayer } from '../../src/services/playback.js';
import { musicManager } from '../../src/core/musicManager.js';
import { resolutionManager } from '../../src/services/resolutionManager.js';
import { tryPlayWithFallback } from '../../src/services/trackResolver.js';
import { botEvents } from '../../src/events/bus.js';
import { STATS_EVENT } from '../../src/shared/statsEvents.js';

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

// FR-023: a natural track end and an explicit skip are distinct recorded actions
// and must never be crossed. Both paths call advanceAndPlay({ skipCurrent: true }),
// so nothing about the advance itself distinguishes them — only the caller knows,
// which is why track_complete is emitted from the trackEnd handler and skip from
// the transports. A flag on the mediator could not tell them apart.
describe('track_complete vs skip (FR-023)', () => {
  let captured;
  let listener;

  beforeEach(() => {
    captured = [];
    listener = (payload) => captured.push(payload);
    botEvents.on(STATS_EVENT, listener);
    tryPlayWithFallback.mockResolvedValue({ played: true, track: { id: 'next' } });
  });

  afterEach(() => {
    botEvents.off(STATS_EVENT, listener);
  });

  /** Fire trackEnd and let its async body settle. */
  async function fireTrackEnd() {
    const player = getPlayer();
    player.emit('trackEnd');
    // The handler body is an async IIFE; drain the microtask queue.
    for (let i = 0; i < 10; i++) await Promise.resolve();
  }

  it('records a natural end as track_complete with a null actor', async () => {
    await fireTrackEnd();

    const completions = captured.filter((e) => e.type === 'track_complete');
    expect(completions).toHaveLength(1);
    expect(completions[0].actor).toBeNull();
  });

  it('records the track that just ended, not the one that came next', async () => {
    await fireTrackEnd();

    const [completion] = captured.filter((e) => e.type === 'track_complete');
    expect(completion.track).not.toBeNull();
    expect(completion.track.title).toBe('Finished Song');
  });

  it('never records a natural end as a skip', async () => {
    await fireTrackEnd();

    expect(captured.filter((e) => e.type === 'skip')).toHaveLength(0);
  });

  it('emits nothing from advanceAndPlay itself, so a skip cannot be recorded as a completion', async () => {
    // advanceAndPlay is shared by both skip paths and the auto-advance. If it
    // emitted anything, every transport skip would also record a track_complete.
    const player = { stop: vi.fn() };
    const queue = { currentIndex: 0 };

    await advanceAndPlay({ player, queue, connection, skipCurrent: true });

    expect(captured).toHaveLength(0);
  });
});
