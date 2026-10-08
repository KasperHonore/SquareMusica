import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { PassThrough } from 'stream';

// The real @discordjs/voice AudioPlayer needs a voice connection; a small fake
// with the same state machine surface is enough to drive MusicPlayer.
vi.mock('@discordjs/voice', async () => {
  const { EventEmitter } = await import('events');
  const AudioPlayerStatus = {
    Idle: 'idle',
    Playing: 'playing',
    Paused: 'paused',
    Buffering: 'buffering'
  };
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
    createAudioPlayer: vi.fn(() => new FakeAudioPlayer()),
    createAudioResource: vi.fn((stream, options) => ({ stream, options }))
  };
});

vi.mock('../../src/integrations/youtube.js', () => ({
  getStream: vi.fn(),
  getPcmStream: vi.fn()
}));

vi.mock('../../src/services/resolutionManager.js', async () => {
  const { EventEmitter } = await import('events');
  const instance = Object.assign(new EventEmitter(), {
    setQueue: vi.fn(),
    start: vi.fn(),
    stop: vi.fn(),
    processLookahead: vi.fn().mockResolvedValue(undefined),
    processingTracks: new Set(),
    ensureResolved: vi.fn()
  });
  return {
    resolutionManager: instance,
    ResolutionManager: { needsResolution: () => false }
  };
});

vi.mock('../../src/persistence/db.js', () => ({ db: { addToHistory: vi.fn() } }));
vi.mock('../../src/transports/discord/voiceManager.js', () => ({ getConnection: vi.fn() }));
vi.mock('../../src/utils/logger.js', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() }
}));

import { createAudioResource, StreamType } from '@discordjs/voice';
import { getStream, getPcmStream } from '../../src/integrations/youtube.js';
import { MusicPlayer } from '../../src/core/player.js';
import { DuckingMixer } from '../../src/core/audioMixer.js';
import { Queue } from '../../src/core/queue.js';
import { musicManager } from '../../src/core/musicManager.js';

const connection = { subscribe: vi.fn() };
const track = (id) => ({ id, title: id, url: `https://youtube.com/watch?v=${id}` });

beforeEach(() => {
  vi.clearAllMocks();
  getStream.mockImplementation(async () => ({
    stream: new PassThrough(),
    type: StreamType.Arbitrary,
    cleanup: vi.fn()
  }));
  getPcmStream.mockImplementation(async () => ({
    stream: new PassThrough(),
    type: StreamType.Raw,
    cleanup: vi.fn()
  }));
});

describe('MusicPlayer mixing path (ADR-002)', () => {
  it('with mixing disabled play() uses the legacy stream type and overlay() is false', async () => {
    const player = new MusicPlayer();
    player.setMixingEnabled(false);
    await player.play(track('a'), connection);

    expect(getStream).toHaveBeenCalledOnce();
    expect(getPcmStream).not.toHaveBeenCalled();
    const [stream, options] = createAudioResource.mock.calls[0];
    expect(options).toEqual({ inputType: StreamType.Arbitrary });
    expect(stream).not.toBeInstanceOf(DuckingMixer);
    expect(player.overlay(Buffer.alloc(8))).toBe(false);
  });

  it('with mixing enabled play() builds a Raw resource through a DuckingMixer', async () => {
    const player = new MusicPlayer();
    player.setMixingEnabled(true);
    await player.play(track('a'), connection);

    expect(getPcmStream).toHaveBeenCalledWith('https://youtube.com/watch?v=a');
    expect(getStream).not.toHaveBeenCalled();
    const [stream, options] = createAudioResource.mock.calls[0];
    expect(options).toEqual({ inputType: StreamType.Raw });
    expect(stream).toBeInstanceOf(DuckingMixer);
    expect(player.overlay(Buffer.alloc(8))).toBe(true);
    expect(stream.hasOverlay()).toBe(true);
  });

  it('builds a new mixer per track', async () => {
    const player = new MusicPlayer();
    player.setMixingEnabled(true);
    await player.play(track('a'), connection);
    await player.play(track('b'), connection);
    const [first] = createAudioResource.mock.calls[0];
    const [second] = createAudioResource.mock.calls[1];
    expect(first).not.toBe(second);
  });

  it('a track switch or stop destroys the previous mixer and runs the stream cleanup', async () => {
    const player = new MusicPlayer();
    player.setMixingEnabled(true);
    await player.play(track('a'), connection);
    const [first] = createAudioResource.mock.calls[0];
    const firstCleanup = (await getPcmStream.mock.results[0].value).cleanup;

    await player.play(track('b'), connection);
    expect(first.destroyed).toBe(true);
    expect(firstCleanup).toHaveBeenCalledOnce();

    const [second] = createAudioResource.mock.calls[1];
    player.stop();
    expect(second.destroyed).toBe(true);
  });

  it('overlay() returns false when nothing is playing or when paused', async () => {
    const player = new MusicPlayer();
    player.setMixingEnabled(true);
    expect(player.overlay(Buffer.alloc(8))).toBe(false);

    await player.play(track('a'), connection);
    player.pause();
    expect(player.overlay(Buffer.alloc(8))).toBe(false);
  });

  it('pause(), stop() and play() each cancel the current overlay', async () => {
    const player = new MusicPlayer();
    player.setMixingEnabled(true);
    await player.play(track('a'), connection);

    for (const action of [
      () => player.pause(),
      () => player.stop(),
      () => player.play(track('b'), connection)
    ]) {
      const [mixer] = createAudioResource.mock.calls.at(-1);
      const cancel = vi.spyOn(mixer, 'cancelOverlay');
      player.resume();
      await action();
      expect(cancel).toHaveBeenCalled();
      if (player.currentTrack === null) await player.play(track('c'), connection);
    }
  });

  it('cancelOverlay() is safe with no mixer', () => {
    const player = new MusicPlayer();
    expect(() => {
      player.cancelOverlay();
      player.cancelOverlay();
    }).not.toThrow();
  });
});

describe('musicManager queue clears cancel the overlay (FR-009)', () => {
  function wire(ids, currentIndex = 0) {
    const queue = new Queue();
    queue.tracks = ids.map((id) => ({ id }));
    queue.currentIndex = currentIndex;
    musicManager.queue = queue;
    musicManager.player = {
      cancelOverlay: vi.fn(),
      stop: vi.fn(),
      isPlaying: vi.fn(() => true),
      isPaused: vi.fn(() => false)
    };
    return queue;
  }

  it('clearQueue() cancels the overlay without stopping the track', () => {
    wire(['a', 'b']);
    musicManager.clearQueue();
    expect(musicManager.player.cancelOverlay).toHaveBeenCalledOnce();
    expect(musicManager.player.stop).not.toHaveBeenCalled();
  });

  it('clearUpcomingQueue() cancels the overlay and keeps the current track', () => {
    const queue = wire(['a', 'b', 'c']);
    musicManager.clearUpcomingQueue();
    expect(musicManager.player.cancelOverlay).toHaveBeenCalledOnce();
    expect(musicManager.player.stop).not.toHaveBeenCalled();
    expect(queue.tracks.map((tr) => tr.id)).toEqual(['a']);
  });

  it('clearAllButCurrent() keeps only the current track and emits one queue:update', () => {
    const queue = wire(['a', 'b', 'c', 'd'], 2);
    const updates = [];
    const listener = (payload) => updates.push(payload);
    musicManager.on('queue:update', listener);
    try {
      musicManager.clearAllButCurrent();
    } finally {
      musicManager.off('queue:update', listener);
    }
    expect(musicManager.player.cancelOverlay).toHaveBeenCalledOnce();
    expect(queue.tracks.map((tr) => tr.id)).toEqual(['c']);
    expect(queue.currentIndex).toBe(0);
    expect(updates).toHaveLength(1);
    expect(updates[0].currentIndex).toBe(0);
  });

  it('clearAllButCurrent() on an empty queue leaves it empty', () => {
    const queue = wire([]);
    musicManager.clearAllButCurrent();
    expect(queue.tracks).toEqual([]);
    expect(queue.currentIndex).toBe(0);
  });
});

describe('musicManager.ensurePlaying() goes through advanceAndPlay', () => {
  let events;
  const record = (name) => (payload) => events.push([name, payload]);
  const listeners = {
    'track:change': record('track:change'),
    'queue:update': record('queue:update')
  };

  beforeEach(() => {
    events = [];
    for (const [name, fn] of Object.entries(listeners)) musicManager.on(name, fn);
    musicManager.getConnection = () => connection;
  });

  afterEach(() => {
    for (const [name, fn] of Object.entries(listeners)) musicManager.off(name, fn);
  });

  function idlePlayer(playImpl) {
    return {
      isPlaying: vi.fn(() => false),
      isPaused: vi.fn(() => false),
      play: vi.fn(playImpl),
      stop: vi.fn(),
      getPosition: vi.fn(() => 0),
      cancelOverlay: vi.fn()
    };
  }

  it('starts the first queued track on an idle player and emits track:change and queue:update', async () => {
    const queue = new Queue();
    queue.tracks = [track('a'), track('b')];
    musicManager.queue = queue;
    const player = idlePlayer(async (tr) => {
      // The real player emits trackStart -> onTrackChange -> track:change.
      musicManager.emit('track:change', tr);
      return true;
    });
    musicManager.player = player;

    expect(await musicManager.ensurePlaying()).toBe(true);
    expect(player.play).toHaveBeenCalledOnce();
    expect(player.play.mock.calls[0][0].id).toBe('a');
    expect(queue.currentIndex).toBe(0);
    expect(events.map(([name]) => name)).toEqual(['track:change', 'queue:update']);
  });

  it.each([
    ['playing', true, false],
    ['paused', false, true]
  ])('returns false without starting anything when already %s', async (_, playing, paused) => {
    const queue = new Queue();
    queue.tracks = [track('a')];
    musicManager.queue = queue;
    const player = idlePlayer(async () => true);
    player.isPlaying.mockReturnValue(playing);
    player.isPaused.mockReturnValue(paused);
    musicManager.player = player;

    expect(await musicManager.ensurePlaying()).toBe(false);
    expect(player.play).not.toHaveBeenCalled();
    expect(events).toEqual([]);
  });

  it('when nothing can play: returns false, stops the player and emits track:change(null) once', async () => {
    const queue = new Queue();
    queue.tracks = [track('a'), track('b')];
    musicManager.queue = queue;
    const player = idlePlayer(async () => false);
    musicManager.player = player;

    expect(await musicManager.ensurePlaying()).toBe(false);
    expect(player.play).toHaveBeenCalledTimes(2);
    expect(player.stop).toHaveBeenCalledOnce();
    const changes = events.filter(([name]) => name === 'track:change');
    expect(changes).toEqual([['track:change', null]]);
  });
});
