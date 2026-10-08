import { describe, it, expect, vi, beforeEach } from 'vitest';

// @discordjs/voice needs native opus bindings and a real voice connection, so
// the audio player is replaced by a small fake whose status the tests control.
vi.mock('@discordjs/voice', async () => {
  const { EventEmitter } = await import('events');
  const AudioPlayerStatus = {
    Idle: 'idle',
    Buffering: 'buffering',
    Playing: 'playing',
    Paused: 'paused',
    AutoPaused: 'autopaused'
  };
  class FakeAudioPlayer extends EventEmitter {
    constructor() {
      super();
      this.state = { status: AudioPlayerStatus.Idle };
      this.play = vi.fn(() => {
        this.state = { status: AudioPlayerStatus.Playing };
      });
      this.pause = vi.fn(() => {
        this.state = { status: AudioPlayerStatus.Paused };
      });
      this.unpause = vi.fn(() => {
        this.state = { status: AudioPlayerStatus.Playing };
      });
      this.stop = vi.fn(() => {
        this.state = { status: AudioPlayerStatus.Idle };
      });
    }
  }
  return {
    createAudioPlayer: vi.fn(() => new FakeAudioPlayer()),
    createAudioResource: vi.fn((stream, opts) => ({ stream, opts })),
    AudioPlayerStatus,
    NoSubscriberBehavior: { Pause: 'pause' },
    StreamType: { Arbitrary: 'arbitrary', Raw: 'raw' }
  };
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
vi.mock('../../src/integrations/spotify.js', () => ({}));
vi.mock('../../src/services/resolutionManager.js', async () => {
  const { EventEmitter } = await import('events');
  const resolutionManager = Object.assign(new EventEmitter(), {
    setQueue: vi.fn(),
    start: vi.fn(),
    stop: vi.fn(),
    processLookahead: vi.fn().mockResolvedValue(undefined),
    ensureResolved: vi.fn(),
    processingTracks: { clear: vi.fn() }
  });
  return {
    resolutionManager,
    ResolutionManager: { needsResolution: () => false }
  };
});
vi.mock('../../src/persistence/db.js', () => ({ db: { addToHistory: vi.fn() } }));
vi.mock('../../src/transports/discord/voiceManager.js', () => ({ getConnection: vi.fn() }));
vi.mock('../../src/utils/logger.js', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() }
}));

import { EventEmitter } from 'events';
import { createAudioResource } from '@discordjs/voice';
import { MusicPlayer } from '../../src/core/player.js';
import { DuckingMixer } from '../../src/core/audioMixer.js';
import { Queue } from '../../src/core/queue.js';
import { musicManager } from '../../src/core/musicManager.js';
import { getStream, getPcmStream } from '../../src/integrations/youtube.js';

const connection = { subscribe: vi.fn() };
const track = (id) => ({ id, title: `Song ${id}`, url: `https://example.com/${id}` });

describe('MusicPlayer mixing seam (contracts §4, R1)', () => {
  let player;

  beforeEach(() => {
    vi.clearAllMocks();
    player = new MusicPlayer();
  });

  it('with mixing disabled play() uses the legacy stream type and overlay() is refused', async () => {
    player.setMixingEnabled(false);

    expect(await player.play(track('a'), connection)).toBe(true);

    expect(getStream).toHaveBeenCalledTimes(1);
    expect(getPcmStream).not.toHaveBeenCalled();
    const [stream, opts] = createAudioResource.mock.calls[0];
    expect(stream).not.toBeInstanceOf(DuckingMixer);
    expect(opts).toEqual({ inputType: 'arbitrary' });
    expect(player.overlay(Buffer.alloc(8))).toBe(false);
  });

  it('defaults to the legacy path when setMixingEnabled was never called', async () => {
    await player.play(track('a'), connection);
    expect(getPcmStream).not.toHaveBeenCalled();
    expect(player.overlay(Buffer.alloc(8))).toBe(false);
  });

  it('with mixing enabled play() builds a Raw resource through a DuckingMixer', async () => {
    player.setMixingEnabled(true);

    await player.play(track('a'), connection);

    expect(getPcmStream).toHaveBeenCalledWith('https://example.com/a');
    expect(getStream).not.toHaveBeenCalled();
    const [stream, opts] = createAudioResource.mock.calls[0];
    expect(stream).toBeInstanceOf(DuckingMixer);
    expect(opts).toEqual({ inputType: 'raw' });
  });

  it('creates a new mixer per track', async () => {
    player.setMixingEnabled(true);
    await player.play(track('a'), connection);
    await player.play(track('b'), connection);
    const [first] = createAudioResource.mock.calls[0];
    const [second] = createAudioResource.mock.calls[1];
    expect(first).not.toBe(second);
  });

  it('overlay() returns false when nothing is playing', () => {
    player.setMixingEnabled(true);
    expect(player.overlay(Buffer.alloc(8))).toBe(false);
  });

  it('overlay() hands the buffer to the mixer while playing, and is refused when paused', async () => {
    player.setMixingEnabled(true);
    await player.play(track('a'), connection);
    const [mixer] = createAudioResource.mock.calls[0];
    const spy = vi.spyOn(mixer, 'overlay');

    const buf = Buffer.alloc(16);
    expect(player.overlay(buf)).toBe(true);
    expect(spy).toHaveBeenCalledWith(buf);

    player.pause();
    expect(player.overlay(buf)).toBe(false);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('pause() cancels the overlay on the current mixer', async () => {
    player.setMixingEnabled(true);
    await player.play(track('a'), connection);
    const [mixer] = createAudioResource.mock.calls[0];
    const spy = vi.spyOn(mixer, 'cancelOverlay');

    player.pause();

    expect(spy).toHaveBeenCalled();
  });

  it('stop() cancels the overlay on the current mixer', async () => {
    player.setMixingEnabled(true);
    await player.play(track('a'), connection);
    const [mixer] = createAudioResource.mock.calls[0];
    const spy = vi.spyOn(mixer, 'cancelOverlay');

    player.stop();

    expect(spy).toHaveBeenCalled();
    expect(player.overlay(Buffer.alloc(8))).toBe(false);
  });

  it('play() cancels the overlay on the previous mixer before switching', async () => {
    player.setMixingEnabled(true);
    await player.play(track('a'), connection);
    const [mixer] = createAudioResource.mock.calls[0];
    const spy = vi.spyOn(mixer, 'cancelOverlay');

    await player.play(track('b'), connection);

    expect(spy).toHaveBeenCalled();
  });

  it('cancelOverlay() is idempotent and safe with no mixer', () => {
    expect(() => {
      player.cancelOverlay();
      player.cancelOverlay();
    }).not.toThrow();
  });
});

/** A stand-in MusicPlayer: play() emits trackStart like the real one. */
class FakePlayer extends EventEmitter {
  constructor() {
    super();
    this.playing = false;
    this.paused = false;
    this.playable = true;
    this.cancelOverlay = vi.fn();
    this.stop = vi.fn(() => {
      this.playing = false;
    });
    this.play = vi.fn(async (t) => {
      if (!this.playable) return false;
      this.playing = true;
      this.emit('trackStart', t);
      return true;
    });
  }
  isPlaying() {
    return this.playing;
  }
  isPaused() {
    return this.paused;
  }
  getPosition() {
    return 0;
  }
}

describe('musicManager overlay cancellation and start path (FR-009, FR-026)', () => {
  let player;
  let queue;
  let emitted;

  beforeEach(() => {
    vi.clearAllMocks();
    musicManager.removeAllListeners();
    player = new FakePlayer();
    queue = new Queue();
    musicManager.setPlayer(player);
    musicManager.setQueue(queue);
    musicManager.setGetConnection(() => connection);
    emitted = [];
    for (const event of ['track:change', 'queue:update', 'player:state']) {
      musicManager.on(event, (payload) => emitted.push([event, payload]));
    }
  });

  const count = (event) => emitted.filter(([e]) => e === event).length;

  it('clearQueue() cancels the overlay', () => {
    queue.add(track('a'));
    musicManager.clearQueue();
    expect(player.cancelOverlay).toHaveBeenCalledTimes(1);
    expect(player.stop).not.toHaveBeenCalled();
  });

  it('clearUpcomingQueue() cancels the overlay while the current track keeps playing', () => {
    queue.add(track('a'));
    queue.add(track('b'));
    player.playing = true;

    musicManager.clearUpcomingQueue();

    expect(player.cancelOverlay).toHaveBeenCalledTimes(1);
    expect(player.stop).not.toHaveBeenCalled();
    expect(player.isPlaying()).toBe(true);
    expect(queue.length).toBe(1);
  });

  it('clearAllButCurrent() keeps only the current track, cancels the overlay, emits once', () => {
    for (const id of ['a', 'b', 'c', 'd']) queue.add(track(id));
    queue.currentIndex = 2;
    player.playing = true;

    musicManager.clearAllButCurrent();

    expect(player.cancelOverlay).toHaveBeenCalledTimes(1);
    expect(queue.tracks.map((t) => t.id)).toEqual(['c']);
    expect(queue.currentIndex).toBe(0);
    expect(count('queue:update')).toBe(1);
    expect(player.stop).not.toHaveBeenCalled();
  });

  it('clearAllButCurrent() on an empty queue leaves it empty', () => {
    musicManager.clearAllButCurrent();
    expect(queue.length).toBe(0);
    expect(queue.currentIndex).toBe(0);
    expect(count('queue:update')).toBe(1);
  });

  it('ensurePlaying() on an idle player starts the first queued track via advanceAndPlay', async () => {
    queue.add(track('a'));
    queue.add(track('b'));

    expect(await musicManager.ensurePlaying()).toBe(true);

    expect(player.play).toHaveBeenCalledTimes(1);
    expect(player.play.mock.calls[0][0].id).toBe('a');
    expect(emitted.some(([e, p]) => e === 'track:change' && p?.id === 'a')).toBe(true);
    expect(count('queue:update')).toBeGreaterThanOrEqual(1);
  });

  it('ensurePlaying() returns false and starts nothing when already playing', async () => {
    queue.add(track('a'));
    player.playing = true;

    expect(await musicManager.ensurePlaying()).toBe(false);
    expect(player.play).not.toHaveBeenCalled();
    expect(emitted).toEqual([]);
  });

  it('ensurePlaying() returns false and starts nothing when paused', async () => {
    queue.add(track('a'));
    player.paused = true;

    expect(await musicManager.ensurePlaying()).toBe(false);
    expect(player.play).not.toHaveBeenCalled();
  });

  it('ensurePlaying() with nothing playable stops the player and emits track:change(null) once', async () => {
    queue.add(track('a'));
    player.playable = false;

    expect(await musicManager.ensurePlaying()).toBe(false);

    expect(player.stop).toHaveBeenCalled();
    const changes = emitted.filter(([e]) => e === 'track:change');
    expect(changes).toEqual([['track:change', null]]);
    expect(count('queue:update')).toBeGreaterThanOrEqual(1);
  });
});
