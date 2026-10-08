import { describe, it, expect, vi, beforeEach } from 'vitest';

// The player and mediator pull in @discordjs/voice, yt-dlp, SQLite and the
// Discord voice manager. Everything with a native or network side effect is
// mocked; Queue, playback.advanceAndPlay and trackResolver stay real so the
// ensurePlaying() start path is exercised end to end.
const h = vi.hoisted(() => ({ mixers: [], audioPlayers: [] }));

vi.mock('@discordjs/voice', async () => {
  const { EventEmitter } = await import('events');
  const AudioPlayerStatus = {
    Idle: 'idle',
    Buffering: 'buffering',
    Playing: 'playing',
    Paused: 'paused'
  };
  class FakeAudioPlayer extends EventEmitter {
    constructor() {
      super();
      this.state = { status: AudioPlayerStatus.Idle };
      this.play = vi.fn(() => {
        this.state = { status: AudioPlayerStatus.Playing };
      });
      this.stop = vi.fn(() => {
        this.state = { status: AudioPlayerStatus.Idle };
      });
      this.pause = vi.fn(() => {
        this.state = { status: AudioPlayerStatus.Paused };
      });
      this.unpause = vi.fn(() => {
        this.state = { status: AudioPlayerStatus.Playing };
      });
      h.audioPlayers.push(this);
    }
  }
  return {
    AudioPlayerStatus,
    NoSubscriberBehavior: { Pause: 'pause' },
    StreamType: { Arbitrary: 'arbitrary', Raw: 'raw', OggOpus: 'ogg/opus' },
    createAudioPlayer: vi.fn(() => new FakeAudioPlayer()),
    createAudioResource: vi.fn((stream, opts) => ({ stream, opts }))
  };
});

vi.mock('../../src/core/audioMixer.js', async () => {
  const { PassThrough } = await import('stream');
  class DuckingMixer extends PassThrough {
    constructor() {
      super();
      this.overlay = vi.fn();
      this.cancelOverlay = vi.fn();
      h.mixers.push(this);
    }
  }
  return { DuckingMixer };
});

vi.mock('../../src/integrations/youtube.js', async () => {
  const { PassThrough } = await import('stream');
  return {
    getStream: vi.fn(async () => ({
      stream: new PassThrough(),
      type: 'arbitrary',
      cleanup: vi.fn()
    })),
    getPcmStream: vi.fn(async () => ({ stream: new PassThrough(), type: 'raw', cleanup: vi.fn() }))
  };
});

vi.mock('../../src/services/resolutionManager.js', () => ({
  resolutionManager: {
    ensureResolved: vi.fn(async (t) => t),
    setQueue: vi.fn(),
    start: vi.fn(),
    stop: vi.fn(),
    on: vi.fn(),
    processLookahead: vi.fn().mockResolvedValue(undefined),
    processingTracks: { clear: vi.fn() }
  },
  ResolutionManager: { needsResolution: vi.fn(() => false) }
}));
vi.mock('../../src/persistence/db.js', () => ({ db: { addToHistory: vi.fn() } }));
vi.mock('../../src/transports/discord/voiceManager.js', () => ({ getConnection: vi.fn() }));
vi.mock('../../src/utils/logger.js', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() }
}));
vi.mock('../../src/services/playback.js', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, advanceAndPlay: vi.fn(actual.advanceAndPlay) };
});

import { createAudioResource, StreamType } from '@discordjs/voice';
import { MusicPlayer } from '../../src/core/player.js';
import { Queue } from '../../src/core/queue.js';
import { musicManager } from '../../src/core/musicManager.js';
import { advanceAndPlay } from '../../src/services/playback.js';
import { getStream, getPcmStream } from '../../src/integrations/youtube.js';
import { DuckingMixer } from '../../src/core/audioMixer.js';

const connection = { subscribe: vi.fn() };
const track = (id) => ({ id, title: `Track ${id}`, url: `https://youtube.com/watch?v=${id}` });

beforeEach(() => {
  vi.clearAllMocks();
  h.mixers.length = 0;
});

describe('MusicPlayer mixing path (R1, contracts §4)', () => {
  it('with mixing disabled play() uses the legacy stream type and overlay() returns false', async () => {
    const player = new MusicPlayer();
    player.setMixingEnabled(false);
    await player.play(track('a'), connection);

    expect(getStream).toHaveBeenCalledWith(track('a').url);
    expect(getPcmStream).not.toHaveBeenCalled();
    const [stream, opts] = createAudioResource.mock.calls[0];
    expect(opts).toEqual({ inputType: 'arbitrary' });
    expect(stream).not.toBeInstanceOf(DuckingMixer);
    expect(h.mixers).toHaveLength(0);
    expect(player.overlay(Buffer.alloc(8))).toBe(false);
  });

  it('with mixing enabled play() builds a Raw resource through a DuckingMixer', async () => {
    const player = new MusicPlayer();
    player.setMixingEnabled(true);
    await player.play(track('a'), connection);

    expect(getPcmStream).toHaveBeenCalledWith(track('a').url);
    expect(getStream).not.toHaveBeenCalled();
    expect(h.mixers).toHaveLength(1);
    const [stream, opts] = createAudioResource.mock.calls[0];
    expect(stream).toBe(h.mixers[0]);
    expect(opts).toEqual({ inputType: StreamType.Raw });

    const pcm = Buffer.alloc(16);
    expect(player.overlay(pcm)).toBe(true);
    expect(h.mixers[0].overlay).toHaveBeenCalledWith(pcm);
  });

  it('overlay() is accepted while the new resource is still buffering', async () => {
    // Real @discordjs/voice: play() of a not-yet-readable resource → Buffering,
    // and play() emits trackStart (→ track:change) before it becomes Playing.
    const player = new MusicPlayer();
    player.setMixingEnabled(true);
    player.audioPlayer.play.mockImplementationOnce(function () {
      this.state = { status: 'buffering' };
    });
    let accepted = null;
    player.once('trackStart', () => (accepted = player.overlay(Buffer.alloc(8))));
    await player.play(track('a'), connection);
    expect(player.audioPlayer.state.status).toBe('buffering');
    expect(accepted).toBe(true);
    expect(h.mixers[0].overlay).toHaveBeenCalled();
  });

  it('overlay() returns false when nothing is playing', () => {
    const player = new MusicPlayer();
    player.setMixingEnabled(true);
    expect(player.overlay(Buffer.alloc(8))).toBe(false);
  });

  it('overlay() returns false while paused', async () => {
    const player = new MusicPlayer();
    player.setMixingEnabled(true);
    await player.play(track('a'), connection);
    player.pause();
    expect(player.overlay(Buffer.alloc(8))).toBe(false);
    expect(h.mixers[0].overlay).not.toHaveBeenCalled();
  });

  it('pause() cancels the overlay', async () => {
    const player = new MusicPlayer();
    player.setMixingEnabled(true);
    await player.play(track('a'), connection);
    player.pause();
    expect(h.mixers[0].cancelOverlay).toHaveBeenCalled();
  });

  it('stop() cancels the overlay', async () => {
    const player = new MusicPlayer();
    player.setMixingEnabled(true);
    await player.play(track('a'), connection);
    player.stop();
    expect(h.mixers[0].cancelOverlay).toHaveBeenCalled();
  });

  it('play() cancels the previous track overlay and gives the new track its own mixer', async () => {
    const player = new MusicPlayer();
    player.setMixingEnabled(true);
    await player.play(track('a'), connection);
    const first = h.mixers[0];
    await player.play(track('b'), connection);
    expect(first.cancelOverlay).toHaveBeenCalled();
    expect(h.mixers).toHaveLength(2);
    player.overlay(Buffer.alloc(4));
    expect(h.mixers[1].overlay).toHaveBeenCalled();
    expect(first.overlay).not.toHaveBeenCalled();
  });

  it('cancelOverlay() is idempotent and safe with no mixer', () => {
    const player = new MusicPlayer();
    expect(() => {
      player.cancelOverlay();
      player.cancelOverlay();
    }).not.toThrow();
  });
});

/** A minimal player double for musicManager tests. */
async function fakePlayer({ playable = true } = {}) {
  const { EventEmitter } = await import('events');
  const p = new EventEmitter();
  p.state = 'idle';
  p.isPlaying = vi.fn(() => p.state === 'playing');
  p.isPaused = vi.fn(() => p.state === 'paused');
  p.stop = vi.fn(() => {
    p.state = 'idle';
  });
  p.cancelOverlay = vi.fn();
  p.getPosition = vi.fn(() => 0);
  p.play = vi.fn(async (t) => {
    if (!playable) return false;
    p.state = 'playing';
    p.emit('trackStart', t);
    return true;
  });
  return p;
}

function seedQueue(ids, currentIndex = 0) {
  const q = new Queue();
  q.tracks = ids.map((id) => track(id));
  q.currentIndex = currentIndex;
  return q;
}

describe('musicManager overlay cancellation on queue clears (FR-009)', () => {
  let player;

  beforeEach(async () => {
    musicManager.removeAllListeners();
    player = await fakePlayer();
    player.state = 'playing';
    musicManager.player = player;
  });

  it('clearQueue() cancels the overlay', () => {
    musicManager.queue = seedQueue(['a', 'b', 'c'], 0);
    musicManager.clearQueue();
    expect(player.cancelOverlay).toHaveBeenCalledTimes(1);
  });

  it('clearUpcomingQueue() cancels the overlay while the current track keeps playing', () => {
    musicManager.queue = seedQueue(['a', 'b', 'c'], 0);
    musicManager.clearUpcomingQueue();
    expect(player.cancelOverlay).toHaveBeenCalledTimes(1);
    expect(player.stop).not.toHaveBeenCalled();
    expect(musicManager.queue.tracks.map((t) => t.id)).toEqual(['a']);
  });

  it('clearAllButCurrent() keeps only the current track, cancels once, emits one queue:update', () => {
    musicManager.queue = seedQueue(['a', 'b', 'c', 'd'], 2);
    const updates = [];
    musicManager.on('queue:update', (u) => updates.push(u));

    musicManager.clearAllButCurrent();

    expect(player.cancelOverlay).toHaveBeenCalledTimes(1);
    expect(player.stop).not.toHaveBeenCalled();
    expect(musicManager.queue.tracks.map((t) => t.id)).toEqual(['c']);
    expect(musicManager.queue.currentIndex).toBe(0);
    expect(updates).toHaveLength(1);
    expect(updates[0].tracks.map((t) => t.id)).toEqual(['c']);
    expect(updates[0].currentIndex).toBe(0);
  });

  it('clearAllButCurrent() on an empty queue leaves it empty', () => {
    musicManager.queue = new Queue();
    musicManager.clearAllButCurrent();
    expect(musicManager.queue.tracks).toEqual([]);
    expect(musicManager.queue.currentIndex).toBe(0);
  });
});

describe('musicManager.ensurePlaying() shared start path (FR-026)', () => {
  beforeEach(() => {
    musicManager.removeAllListeners();
    musicManager.setGetConnection(() => connection);
  });

  it('on an idle player starts the first queued track through advanceAndPlay', async () => {
    const player = await fakePlayer();
    musicManager.setPlayer(player);
    musicManager.queue = seedQueue(['a', 'b'], 0);
    const changes = [];
    const updates = [];
    musicManager.on('track:change', (t) => changes.push(t));
    musicManager.on('queue:update', (u) => updates.push(u));

    const played = await musicManager.ensurePlaying();

    expect(played).toBe(true);
    expect(advanceAndPlay).toHaveBeenCalledWith({
      player,
      queue: musicManager.queue,
      connection,
      skipCurrent: false
    });
    expect(player.play).toHaveBeenCalledWith(musicManager.queue.tracks[0], connection);
    expect(changes.map((t) => t?.id)).toEqual(['a']);
    expect(updates.length).toBeGreaterThanOrEqual(1);
  });

  it('returns false and starts nothing when already playing', async () => {
    const player = await fakePlayer();
    player.state = 'playing';
    musicManager.setPlayer(player);
    musicManager.queue = seedQueue(['a'], 0);
    expect(await musicManager.ensurePlaying()).toBe(false);
    expect(advanceAndPlay).not.toHaveBeenCalled();
    expect(player.play).not.toHaveBeenCalled();
  });

  it('returns false and starts nothing when paused', async () => {
    const player = await fakePlayer();
    player.state = 'paused';
    musicManager.setPlayer(player);
    musicManager.queue = seedQueue(['a'], 0);
    expect(await musicManager.ensurePlaying()).toBe(false);
    expect(advanceAndPlay).not.toHaveBeenCalled();
  });

  it('when nothing can play: returns false, stops the player, emits track:change(null) once', async () => {
    const player = await fakePlayer({ playable: false });
    musicManager.setPlayer(player);
    musicManager.queue = seedQueue(['a', 'b'], 0);
    const changes = [];
    musicManager.on('track:change', (t) => changes.push(t));

    const played = await musicManager.ensurePlaying();

    expect(played).toBe(false);
    expect(player.stop).toHaveBeenCalled();
    expect(changes).toEqual([null]);
  });
});

describe('musicManager.getFullState() dj field', () => {
  it('reports { available: false } with no DJ state getter', () => {
    musicManager.setGetDjState(null);
    expect(musicManager.getFullState().dj).toEqual({ available: false });
  });

  it('includes the injected DJ state', () => {
    const state = { available: true, enabled: true };
    musicManager.setGetDjState(() => state);
    expect(musicManager.getFullState().dj).toBe(state);
    musicManager.setGetDjState(null);
  });
});

describe('musicManager themed-mode guards (FR-024a, FR-024b)', () => {
  let player;

  beforeEach(async () => {
    musicManager.removeAllListeners();
    musicManager.setOnQueueCleared(null);
    player = await fakePlayer();
    player.state = 'playing';
    musicManager.player = player;
  });

  it('shuffleQueue() refuses while themed mode is on and changes nothing', () => {
    const q = seedQueue(['a', 'b', 'c', 'd'], 1);
    q.prioritizeMemberTracks = true;
    musicManager.queue = q;
    const before = q.tracks.slice();
    const updates = [];
    musicManager.on('queue:update', (u) => updates.push(u));

    expect(musicManager.shuffleQueue()).toEqual({
      shuffled: false,
      reason: 'THEMED_MODE_ACTIVE'
    });
    expect(q.tracks).toEqual(before);
    expect(q.currentIndex).toBe(1);
    expect(updates).toHaveLength(0);
  });

  it('shuffleQueue() shuffles and emits one queue:update when themed mode is off', () => {
    musicManager.queue = seedQueue(['a', 'b', 'c'], 0);
    const updates = [];
    musicManager.on('queue:update', (u) => updates.push(u));

    expect(musicManager.shuffleQueue()).toEqual({ shuffled: true });
    expect(updates).toHaveLength(1);
  });

  const CLEARS = ['clearQueue', 'clearUpcomingQueue', 'clearAllButCurrent', 'stop'];

  for (const method of CLEARS) {
    it(`${method}() calls the cleared hook once, before its queue:update`, () => {
      musicManager.queue = seedQueue(['a', 'b', 'c'], 0);
      const order = [];
      musicManager.setOnQueueCleared(() => order.push('hook'));
      musicManager.on('queue:update', () => order.push('queue:update'));

      musicManager[method]();

      expect(order.filter((e) => e === 'hook')).toHaveLength(1);
      expect(order.indexOf('hook')).toBeLessThan(order.indexOf('queue:update'));
      musicManager.setOnQueueCleared(null);
    });

    it(`${method}() does not throw with no hook set`, () => {
      musicManager.queue = seedQueue(['a', 'b'], 0);
      expect(() => musicManager[method]()).not.toThrow();
    });
  }

  it('onTrackChange records a DJ pick with addedByDj', async () => {
    const { db } = await import('../../src/persistence/db.js');
    db.addToHistory.mockClear();
    const pick = { ...track('p'), addedByDj: true, requestedBy: 'SquareMusica DJ' };
    musicManager.onTrackChange(pick);
    expect(db.addToHistory).toHaveBeenCalledWith(
      pick,
      musicManager.guildId,
      expect.objectContaining({ addedByDj: true })
    );
  });
});
