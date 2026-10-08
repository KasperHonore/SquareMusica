import { describe, it, expect, vi, beforeEach } from 'vitest';

// A minimal stand-in for @discordjs/voice: an AudioPlayer whose status follows
// play/pause/unpause/stop, and a createAudioResource that records its inputs so
// the test can see which stream type and which stream object were used.
vi.mock('@discordjs/voice', async () => {
  const { EventEmitter } = await import('events');
  const AudioPlayerStatus = { Idle: 'idle', Playing: 'playing', Paused: 'paused' };
  class FakeAudioPlayer extends EventEmitter {
    constructor() {
      super();
      this.state = { status: AudioPlayerStatus.Idle };
    }
    play(resource) {
      this.state = { status: AudioPlayerStatus.Playing, resource };
    }
    pause() {
      this.state = { ...this.state, status: AudioPlayerStatus.Paused };
    }
    unpause() {
      this.state = { ...this.state, status: AudioPlayerStatus.Playing };
    }
    stop() {
      this.state = { status: AudioPlayerStatus.Idle };
    }
  }
  return {
    AudioPlayerStatus,
    NoSubscriberBehavior: { Pause: 'pause' },
    StreamType: { Arbitrary: 'arbitrary', Raw: 'raw' },
    createAudioPlayer: () => new FakeAudioPlayer(),
    createAudioResource: vi.fn((stream, options) => ({ stream, options }))
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
    getPcmStream: vi.fn(async () => ({
      stream: new PassThrough(),
      type: 'raw',
      cleanup: vi.fn()
    })),
    search: vi.fn(),
    getInfo: vi.fn(),
    isValidUrl: vi.fn(),
    isPlaylist: vi.fn(),
    getPlaylist: vi.fn()
  };
});
vi.mock('../../src/integrations/spotify.js', () => ({}));
vi.mock('../../src/persistence/db.js', () => ({ db: { addToHistory: vi.fn() } }));
vi.mock('../../src/services/resolutionManager.js', async () => {
  const { EventEmitter } = await import('events');
  const rm = Object.assign(new EventEmitter(), {
    setQueue: vi.fn(),
    start: vi.fn(),
    stop: vi.fn(),
    processLookahead: vi.fn().mockResolvedValue(undefined),
    ensureResolved: vi.fn(async (t) => t),
    processingTracks: { clear: vi.fn() }
  });
  class ResolutionManager {
    static needsResolution() {
      return false;
    }
  }
  return { resolutionManager: rm, ResolutionManager };
});
vi.mock('../../src/transports/discord/voiceManager.js', () => ({ getConnection: vi.fn() }));
vi.mock('../../src/utils/logger.js', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() }
}));

import { createAudioResource } from '@discordjs/voice';
import { getStream, getPcmStream } from '../../src/integrations/youtube.js';
import { MusicPlayer } from '../../src/core/player.js';
import { DuckingMixer } from '../../src/core/audioMixer.js';
import { Queue } from '../../src/core/queue.js';
import { musicManager } from '../../src/core/musicManager.js';

const connection = { subscribe: vi.fn() };
const track = (id) => ({ id, title: id, url: `https://www.youtube.com/watch?v=${id}` });

describe('MusicPlayer mixing path (R1, contracts §4)', () => {
  let player;

  beforeEach(() => {
    vi.clearAllMocks();
    player = new MusicPlayer();
  });

  it('with mixing disabled plays the legacy stream with its own type, and overlay() is false', async () => {
    player.setMixingEnabled(false);
    expect(await player.play(track('a'), connection)).toBe(true);

    expect(getStream).toHaveBeenCalledTimes(1);
    expect(getPcmStream).not.toHaveBeenCalled();
    const [stream, options] = createAudioResource.mock.calls[0];
    expect(options).toEqual({ inputType: 'arbitrary' });
    expect(stream).not.toBeInstanceOf(DuckingMixer);
    expect(player.overlay(Buffer.alloc(4))).toBe(false);
  });

  it('is disabled by default (DJ unconfigured)', async () => {
    await player.play(track('a'), connection);
    expect(getPcmStream).not.toHaveBeenCalled();
    expect(player.overlay(Buffer.alloc(4))).toBe(false);
  });

  it('with mixing enabled builds a Raw resource through a DuckingMixer', async () => {
    player.setMixingEnabled(true);
    await player.play(track('a'), connection);

    expect(getPcmStream).toHaveBeenCalledWith(track('a').url);
    expect(getStream).not.toHaveBeenCalled();
    const [stream, options] = createAudioResource.mock.calls[0];
    expect(options).toEqual({ inputType: 'raw' });
    expect(stream).toBeInstanceOf(DuckingMixer);
  });

  it('overlay() forwards to the mixer while playing and is false when idle or paused', async () => {
    player.setMixingEnabled(true);
    expect(player.overlay(Buffer.alloc(4))).toBe(false);

    await player.play(track('a'), connection);
    const mixer = createAudioResource.mock.calls[0][0];
    const spy = vi.spyOn(mixer, 'overlay');
    expect(player.overlay(Buffer.alloc(8))).toBe(true);
    expect(spy).toHaveBeenCalledTimes(1);

    player.pause();
    expect(player.overlay(Buffer.alloc(8))).toBe(false);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('pause(), stop() and play() each cancel the current overlay', async () => {
    player.setMixingEnabled(true);
    await player.play(track('a'), connection);
    const first = createAudioResource.mock.calls[0][0];
    const cancel = vi.spyOn(first, 'cancelOverlay');

    player.pause();
    expect(cancel).toHaveBeenCalledTimes(1);

    player.resume();
    await player.play(track('b'), connection);
    expect(cancel).toHaveBeenCalledTimes(2);

    const second = createAudioResource.mock.calls[1][0];
    const cancel2 = vi.spyOn(second, 'cancelOverlay');
    player.stop();
    expect(cancel2).toHaveBeenCalledTimes(1);
  });

  it('cancelOverlay() is idempotent and safe with nothing playing', () => {
    expect(() => {
      player.cancelOverlay();
      player.cancelOverlay();
    }).not.toThrow();
  });
});

describe('musicManager overlay cancel and start path (FR-009, FR-026)', () => {
  let player;
  let queue;
  let emitted;

  beforeEach(() => {
    vi.clearAllMocks();
    player = {
      cancelOverlay: vi.fn(),
      isPlaying: vi.fn(() => false),
      isPaused: vi.fn(() => false),
      play: vi.fn(async () => true),
      stop: vi.fn(),
      getPosition: vi.fn(() => 0)
    };
    queue = new Queue();
    musicManager.player = player;
    musicManager.queue = queue;
    musicManager.getConnection = () => connection;
    musicManager.removeAllListeners();
    emitted = [];
    for (const event of ['queue:update', 'track:change', 'player:state']) {
      musicManager.on(event, (payload) => emitted.push([event, payload]));
    }
  });

  const names = () => emitted.map(([e]) => e);

  it('clearQueue() cancels the overlay without stopping the player', () => {
    queue.tracks = [track('a'), track('b')];
    musicManager.clearQueue();
    expect(player.cancelOverlay).toHaveBeenCalledTimes(1);
    expect(player.stop).not.toHaveBeenCalled();
  });

  it('clearUpcomingQueue() cancels the overlay and keeps the current track', () => {
    queue.tracks = [track('a'), track('b'), track('c')];
    queue.currentIndex = 0;
    musicManager.clearUpcomingQueue();
    expect(player.cancelOverlay).toHaveBeenCalledTimes(1);
    expect(player.stop).not.toHaveBeenCalled();
    expect(queue.tracks.map((t) => t.id)).toEqual(['a']);
  });

  it('clearAllButCurrent() keeps only the current track at index 0 and emits once', () => {
    queue.tracks = [track('a'), track('b'), track('c'), track('d')];
    queue.currentIndex = 2;
    musicManager.clearAllButCurrent();
    expect(player.cancelOverlay).toHaveBeenCalledTimes(1);
    expect(queue.tracks.map((t) => t.id)).toEqual(['c']);
    expect(queue.currentIndex).toBe(0);
    expect(names().filter((n) => n === 'queue:update')).toHaveLength(1);
  });

  it('clearAllButCurrent() on an empty queue leaves it empty', () => {
    musicManager.clearAllButCurrent();
    expect(queue.tracks).toEqual([]);
    expect(queue.currentIndex).toBe(0);
  });

  it('ensurePlaying() on an idle player starts the first queued track via advanceAndPlay', async () => {
    queue.add(track('a'));
    queue.add(track('b'));
    expect(await musicManager.ensurePlaying()).toBe(true);

    expect(player.play).toHaveBeenCalledTimes(1);
    expect(player.play.mock.calls[0][0].id).toBe('a');
    expect(queue.currentIndex).toBe(0);
    expect(names()).toContain('queue:update');
    // The player's trackStart → onTrackChange path emits track:change in
    // production; with the fake player we drive it here to show the wiring.
    musicManager.onTrackChange(queue.getCurrent());
    expect(names()).toContain('track:change');
  });

  it('ensurePlaying() returns false and starts nothing when already playing or paused', async () => {
    queue.add(track('a'));
    player.isPlaying.mockReturnValue(true);
    expect(await musicManager.ensurePlaying()).toBe(false);
    player.isPlaying.mockReturnValue(false);
    player.isPaused.mockReturnValue(true);
    expect(await musicManager.ensurePlaying()).toBe(false);
    expect(player.play).not.toHaveBeenCalled();
    expect(emitted).toEqual([]);
  });

  it('ensurePlaying() with nothing playable stops the player and emits track:change(null) once', async () => {
    queue.add(track('a'));
    player.play.mockResolvedValue(false);
    expect(await musicManager.ensurePlaying()).toBe(false);
    expect(player.stop).toHaveBeenCalledTimes(1);
    const changes = emitted.filter(([e]) => e === 'track:change');
    expect(changes).toEqual([['track:change', null]]);
    expect(names()).toContain('queue:update');
  });
});
