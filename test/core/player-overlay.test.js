import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PassThrough } from 'stream';

// The real MusicPlayer and musicManager run here; only the I/O edges are mocked:
// @discordjs/voice (no audio device), the yt-dlp integration, the database, the
// Discord voice manager and lazy resolution.
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
    }
    play(resource) {
      this.state = { status: AudioPlayerStatus.Playing, resource };
    }
    pause() {
      this.state = { ...this.state, status: AudioPlayerStatus.Paused };
      return true;
    }
    unpause() {
      this.state = { ...this.state, status: AudioPlayerStatus.Playing };
      return true;
    }
    stop() {
      this.state = { status: AudioPlayerStatus.Idle };
      return true;
    }
  }
  return {
    createAudioPlayer: () => new FakeAudioPlayer(),
    createAudioResource: vi.fn((stream, opts) => ({ stream, opts })),
    AudioPlayerStatus,
    NoSubscriberBehavior: { Pause: 'pause' },
    StreamType: { Arbitrary: 'arbitrary', Raw: 'raw' }
  };
});

vi.mock('../../src/integrations/youtube.js', () => ({
  getStream: vi.fn(async () => ({
    stream: new PassThrough(),
    type: 'arbitrary',
    cleanup: vi.fn()
  })),
  getPcmStream: vi.fn(async () => ({ stream: new PassThrough(), type: 'raw', cleanup: vi.fn() })),
  search: vi.fn(),
  getInfo: vi.fn(),
  isValidUrl: vi.fn(),
  isPlaylist: vi.fn(),
  getPlaylist: vi.fn()
}));

vi.mock('../../src/integrations/spotify.js', () => ({
  parseSpotifyUrl: vi.fn(),
  getPublicTrack: vi.fn(),
  getPublicPlaylistTracks: vi.fn(),
  getPublicAlbumTracks: vi.fn(),
  MAX_PLAYLIST_TRACKS: 100,
  MAX_ALBUM_TRACKS: 100
}));

vi.mock('../../src/services/resolutionManager.js', () => ({
  resolutionManager: {
    ensureResolved: vi.fn(async () => null),
    setQueue: vi.fn(),
    start: vi.fn(),
    stop: vi.fn(),
    on: vi.fn(),
    processLookahead: vi.fn(async () => undefined),
    processingTracks: { clear: vi.fn() }
  },
  ResolutionManager: { needsResolution: (track) => !track.url }
}));

vi.mock('../../src/persistence/db.js', () => ({ db: { addToHistory: vi.fn() } }));

const connection = { subscribe: vi.fn() };
vi.mock('../../src/transports/discord/voiceManager.js', () => ({
  getConnection: vi.fn(() => connection)
}));

vi.mock('../../src/utils/logger.js', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() }
}));

import { createAudioResource } from '@discordjs/voice';
import { getStream, getPcmStream } from '../../src/integrations/youtube.js';
import { MusicPlayer } from '../../src/core/player.js';
import { DuckingMixer } from '../../src/core/audioMixer.js';
import { Queue } from '../../src/core/queue.js';
import { musicManager } from '../../src/core/musicManager.js';
import { getPlayer, getQueue } from '../../src/services/playback.js';

const track = (id, url = `https://youtu.be/${id}`) => ({ id, title: id, url });

describe('MusicPlayer mixing seam (contracts §4)', () => {
  let player;

  beforeEach(() => {
    vi.clearAllMocks();
    player = new MusicPlayer();
  });

  it('with mixing disabled, play() uses the legacy stream type and overlay() returns false', async () => {
    player.setMixingEnabled(false);
    await player.play(track('a'), connection);

    expect(getStream).toHaveBeenCalledWith('https://youtu.be/a');
    expect(getPcmStream).not.toHaveBeenCalled();
    const [stream, opts] = createAudioResource.mock.calls[0];
    expect(opts).toEqual({ inputType: 'arbitrary' });
    expect(stream).not.toBeInstanceOf(DuckingMixer);
    expect(player.overlay(Buffer.alloc(8))).toBe(false);
  });

  it('is disabled by default', async () => {
    await player.play(track('a'), connection);
    expect(getPcmStream).not.toHaveBeenCalled();
    expect(player.overlay(Buffer.alloc(8))).toBe(false);
  });

  it('with mixing enabled, play() builds a Raw resource through a DuckingMixer', async () => {
    player.setMixingEnabled(true);
    await player.play(track('a'), connection);

    expect(getPcmStream).toHaveBeenCalledWith('https://youtu.be/a');
    expect(getStream).not.toHaveBeenCalled();
    const [stream, opts] = createAudioResource.mock.calls[0];
    expect(opts).toEqual({ inputType: 'raw' });
    expect(stream).toBeInstanceOf(DuckingMixer);
    expect(player.overlay(Buffer.alloc(8))).toBe(true);
  });

  it('uses a new mixer per track', async () => {
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

  it('overlay() returns false while paused', async () => {
    player.setMixingEnabled(true);
    await player.play(track('a'), connection);
    player.pause();
    expect(player.overlay(Buffer.alloc(8))).toBe(false);
  });

  it('pause() cancels the overlay on the current mixer', async () => {
    player.setMixingEnabled(true);
    await player.play(track('a'), connection);
    const mixer = createAudioResource.mock.calls[0][0];
    const cancel = vi.spyOn(mixer, 'cancelOverlay');
    player.pause();
    expect(cancel).toHaveBeenCalled();
  });

  it('stop() cancels the overlay on the current mixer', async () => {
    player.setMixingEnabled(true);
    await player.play(track('a'), connection);
    const mixer = createAudioResource.mock.calls[0][0];
    const cancel = vi.spyOn(mixer, 'cancelOverlay');
    player.stop();
    expect(cancel).toHaveBeenCalled();
  });

  it('play() cancels the overlay on the current mixer before switching', async () => {
    player.setMixingEnabled(true);
    await player.play(track('a'), connection);
    const mixer = createAudioResource.mock.calls[0][0];
    const cancel = vi.spyOn(mixer, 'cancelOverlay');
    await player.play(track('b'), connection);
    expect(cancel).toHaveBeenCalled();
  });

  it('cancelOverlay() is idempotent and safe with no mixer', () => {
    expect(() => {
      player.cancelOverlay();
      player.cancelOverlay();
    }).not.toThrow();
  });
});

describe('musicManager overlay cancel and start path (FR-009, FR-026)', () => {
  let player;
  let queue;
  let events;

  beforeEach(() => {
    // The player is a singleton here, so spies from an earlier test must go.
    vi.restoreAllMocks();
    vi.clearAllMocks();
    player = getPlayer();
    queue = getQueue();
    player.stop();
    queue.clear();
    queue.loopMode = 'off';
    events = [];
    musicManager.removeAllListeners('track:change');
    musicManager.removeAllListeners('queue:update');
    musicManager.on('track:change', (t) => events.push(['track:change', t]));
    musicManager.on('queue:update', (q) => events.push(['queue:update', q]));
  });

  it('wires the real player and queue', () => {
    expect(player).toBeInstanceOf(MusicPlayer);
    expect(queue).toBeInstanceOf(Queue);
  });

  it('clearQueue() cancels the overlay', async () => {
    queue.add(track('a'));
    await player.play(queue.getCurrent(), connection);
    const cancel = vi.spyOn(player, 'cancelOverlay');
    const stop = vi.spyOn(player, 'stop');

    musicManager.clearQueue();

    expect(cancel).toHaveBeenCalledTimes(1);
    expect(stop).not.toHaveBeenCalled();
    expect(player.isPlaying()).toBe(true);
  });

  it('clearUpcomingQueue() cancels the overlay while the current track keeps playing', async () => {
    queue.add(track('a'));
    queue.add(track('b'));
    await player.play(queue.getCurrent(), connection);
    const cancel = vi.spyOn(player, 'cancelOverlay');
    const stop = vi.spyOn(player, 'stop');

    musicManager.clearUpcomingQueue();

    expect(cancel).toHaveBeenCalledTimes(1);
    expect(stop).not.toHaveBeenCalled();
    expect(player.isPlaying()).toBe(true);
    expect(queue.getAll().map((t) => t.id)).toEqual(['a']);
  });

  it('clearAllButCurrent() keeps only the current track, cancels the overlay, emits once', async () => {
    queue.add(track('a'));
    queue.add(track('b'));
    queue.add(track('c'));
    queue.currentIndex = 1;
    await player.play(queue.getCurrent(), connection);
    const cancel = vi.spyOn(player, 'cancelOverlay');
    events = [];

    musicManager.clearAllButCurrent();

    expect(cancel).toHaveBeenCalledTimes(1);
    expect(queue.getAll().map((t) => t.id)).toEqual(['b']);
    expect(queue.currentIndex).toBe(0);
    expect(events.filter(([e]) => e === 'queue:update')).toHaveLength(1);
    expect(player.isPlaying()).toBe(true);
  });

  it('clearAllButCurrent() on an empty queue leaves it empty', () => {
    musicManager.clearAllButCurrent();
    expect(queue.length).toBe(0);
    expect(queue.currentIndex).toBe(0);
  });

  it('ensurePlaying() on an idle player starts the first queued track and emits', async () => {
    queue.add(track('a'));
    queue.add(track('b'));

    const played = await musicManager.ensurePlaying();

    expect(played).toBe(true);
    expect(player.currentTrack.id).toBe('a');
    expect(queue.currentIndex).toBe(0);
    const changes = events.filter(([e]) => e === 'track:change');
    expect(changes).toHaveLength(1);
    expect(changes[0][1].id).toBe('a');
    expect(events.some(([e]) => e === 'queue:update')).toBe(true);
  });

  it('ensurePlaying() returns false and starts nothing when already playing', async () => {
    queue.add(track('a'));
    await player.play(queue.getCurrent(), connection);
    queue.add(track('b'));
    const play = vi.spyOn(player, 'play');

    expect(await musicManager.ensurePlaying()).toBe(false);
    expect(play).not.toHaveBeenCalled();
  });

  it('ensurePlaying() returns false and starts nothing when paused', async () => {
    queue.add(track('a'));
    await player.play(queue.getCurrent(), connection);
    player.pause();
    const play = vi.spyOn(player, 'play');

    expect(await musicManager.ensurePlaying()).toBe(false);
    expect(play).not.toHaveBeenCalled();
  });

  it('ensurePlaying() with nothing playable stops the player and emits track:change(null) once', async () => {
    // url: null tracks go through resolution, which the mock fails.
    queue.add({ id: 'x', title: 'x', url: null });
    queue.add({ id: 'y', title: 'y', url: null });
    const stop = vi.spyOn(player, 'stop');

    const played = await musicManager.ensurePlaying();

    expect(played).toBe(false);
    expect(stop).toHaveBeenCalled();
    const changes = events.filter(([e]) => e === 'track:change');
    expect(changes).toEqual([['track:change', null]]);
  });
});
