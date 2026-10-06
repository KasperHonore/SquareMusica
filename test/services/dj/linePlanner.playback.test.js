import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { PassThrough } from 'stream';

// The real MusicPlayer → trackStart → musicManager → linePlanner chain. Unlike
// the fake player in linePlanner.test.js, the voice fake here behaves like
// @discordjs/voice 0.19: play() on a resource that has not produced data yet
// puts the player in Buffering, and it only moves to Playing once the stream is
// readable. trackStart fires during Buffering, so this is where a prepared line
// is overlaid.
vi.mock('@discordjs/voice', async () => {
  const { EventEmitter } = await import('events');
  const AudioPlayerStatus = {
    Idle: 'idle',
    Buffering: 'buffering',
    Playing: 'playing',
    Paused: 'paused',
    AutoPaused: 'autopaused'
  };
  class BufferingAudioPlayer extends EventEmitter {
    constructor() {
      super();
      this.state = { status: AudioPlayerStatus.Idle };
    }
    _set(status, extra = {}) {
      const old = this.state;
      this.state = { ...extra, status };
      this.emit('stateChange', old, this.state);
      if (old.status !== status) this.emit(status, old, this.state);
    }
    play(resource) {
      this._set(AudioPlayerStatus.Buffering, { resource });
      resource.stream.once('readable', () => {
        if (this.state.resource === resource && this.state.status === AudioPlayerStatus.Buffering) {
          this._set(AudioPlayerStatus.Playing, { resource });
        }
      });
    }
    pause() {
      this._set(AudioPlayerStatus.Paused, { resource: this.state.resource });
      return true;
    }
    unpause() {
      this._set(AudioPlayerStatus.Playing, { resource: this.state.resource });
      return true;
    }
    stop() {
      if (this.state.status !== AudioPlayerStatus.Idle) this._set(AudioPlayerStatus.Idle);
      return true;
    }
  }
  return {
    createAudioPlayer: () => new BufferingAudioPlayer(),
    createAudioResource: vi.fn((stream, opts) => ({ stream, opts })),
    AudioPlayerStatus,
    NoSubscriberBehavior: { Pause: 'pause' },
    StreamType: { Arbitrary: 'arbitrary', Raw: 'raw' }
  };
});

vi.mock('../../../src/integrations/youtube.js', () => ({
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

vi.mock('../../../src/integrations/spotify.js', () => ({
  parseSpotifyUrl: vi.fn(),
  getPublicTrack: vi.fn(),
  getPublicPlaylistTracks: vi.fn(),
  getPublicAlbumTracks: vi.fn(),
  MAX_PLAYLIST_TRACKS: 100,
  MAX_ALBUM_TRACKS: 100
}));

vi.mock('../../../src/services/resolutionManager.js', () => ({
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

vi.mock('../../../src/persistence/db.js', () => ({ db: { addToHistory: vi.fn() } }));

const connection = { subscribe: vi.fn() };
vi.mock('../../../src/transports/discord/voiceManager.js', () => ({
  getConnection: vi.fn(() => connection)
}));

vi.mock('../../../src/utils/logger.js', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() }
}));

import { AudioPlayerStatus, createAudioResource } from '@discordjs/voice';
import { musicManager } from '../../../src/core/musicManager.js';
import { getPlayer, getQueue } from '../../../src/services/playback.js';
import { createLinePlanner } from '../../../src/services/dj/linePlanner.js';
import { trackKey } from '../../../src/services/dj/context.js';

const track = (n) => ({
  id: `t${n}`,
  title: `Song ${n}`,
  url: `https://youtu.be/${n}`,
  duration: 200
});

function mixerOf(call) {
  return createAudioResource.mock.calls[call][0];
}

describe('linePlanner with the real MusicPlayer (US1/AC1, AC2)', () => {
  let player;
  let queue;
  let planner;
  let settings;
  let writeLine;
  const onChange = (t) => planner.onTrackChange(t);
  const onUpdate = () => planner.onQueueUpdate();

  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    player = getPlayer();
    queue = getQueue();
    player.stop();
    queue.clear();
    queue.loopMode = 'off';
    player.setMixingEnabled(true);
    musicManager.setGetChannelInfo(() => ({ connectedUsers: [{ id: 'A', username: 'alice' }] }));

    settings = { enabled: true, interval: 1 };
    let n = 0;
    writeLine = vi.fn(async (ctx) => ({
      forKey: ctx.forKey,
      text: `Line ${++n}.`,
      pcm: Buffer.alloc(3840, 1),
      factIds: ['f-next'],
      namedUserIds: [],
      preparedAt: Date.now()
    }));
    planner = createLinePlanner({
      getSettings: () => settings,
      getVoiceContext: () => musicManager.getVoiceContext(),
      getQueue: () => queue,
      getPlayer: () => player,
      writeLine,
      isBreakerOpen: () => false,
      isCapReached: () => false
    });
    musicManager.removeAllListeners('track:change');
    musicManager.removeAllListeners('queue:update');
    musicManager.on('track:change', onChange);
    musicManager.on('queue:update', onUpdate);
  });

  afterEach(() => {
    planner.shutdown();
    musicManager.removeAllListeners('track:change');
    musicManager.removeAllListeners('queue:update');
    vi.useRealTimers();
  });

  it('overlays a prepared line while the new track is still Buffering', async () => {
    for (let i = 1; i <= 3; i++) queue.add(track(i));
    await musicManager.ensurePlaying();
    await vi.advanceTimersByTimeAsync(200 * 1000); // line for track 2 prepared
    expect(writeLine).toHaveBeenCalledTimes(1);

    const overlay = vi.spyOn(player, 'overlay');
    await musicManager.skip();

    // trackStart fired before the mixer produced anything.
    expect(player.audioPlayer.state.status).toBe(AudioPlayerStatus.Buffering);
    expect(overlay).toHaveBeenCalledTimes(1);
    expect(overlay).toHaveReturnedWith(true);
    expect(planner.getStats()).toMatchObject({ due: 1, spoken: 1 });
    expect(planner.getCounter()).toBe(0);

    // The line comes out ducked over the music once data flows.
    const mixer = mixerOf(1);
    expect(mixer.mix(Buffer.alloc(16, 0))).not.toEqual(Buffer.alloc(16, 0));
  });

  it('speaks at every transition across three tracks with interval 1 (independent test)', async () => {
    for (let i = 1; i <= 3; i++) queue.add(track(i));
    await musicManager.ensurePlaying();
    for (let i = 0; i < 2; i++) {
      await vi.advanceTimersByTimeAsync(200 * 1000);
      await musicManager.skip();
      // Let the stream turn readable so the player reaches Playing.
      mixerOf(i + 1).write(Buffer.alloc(16));
      await vi.advanceTimersByTimeAsync(0);
      expect(player.isPlaying()).toBe(true);
    }
    expect(planner.getStats()).toMatchObject({ due: 2, spoken: 2 });
  });

  it('interval 3 over seven tracks speaks exactly twice (US1/AC2)', async () => {
    settings.interval = 3;
    for (let i = 1; i <= 7; i++) queue.add(track(i));
    await musicManager.ensurePlaying();
    for (let i = 0; i < 6; i++) {
      await vi.advanceTimersByTimeAsync(200 * 1000);
      await musicManager.skip();
    }
    expect(planner.getStats()).toMatchObject({ due: 2, spoken: 2 });
  });

  it('a line still in flight lands inside the 2 s window once the track is Playing', async () => {
    writeLine.mockImplementationOnce(
      (ctx) =>
        new Promise((resolve) =>
          setTimeout(
            () =>
              resolve({
                forKey: ctx.forKey,
                text: 'Late line.',
                pcm: Buffer.alloc(3840, 1),
                factIds: ['f-next'],
                namedUserIds: [],
                preparedAt: Date.now()
              }),
            31 * 1000
          )
        )
    );
    for (let i = 1; i <= 2; i++) queue.add(track(i));
    await musicManager.ensurePlaying();
    await vi.advanceTimersByTimeAsync(170 * 1000 + 30 * 1000); // in flight
    await musicManager.skip();
    mixerOf(1).write(Buffer.alloc(16));
    await vi.advanceTimersByTimeAsync(1000);
    expect(planner.getStats()).toMatchObject({ due: 1, spoken: 1 });
  });

  it('never overlays on a paused player', async () => {
    for (let i = 1; i <= 2; i++) queue.add(track(i));
    await musicManager.ensurePlaying();
    mixerOf(0).write(Buffer.alloc(16));
    await vi.advanceTimersByTimeAsync(0);
    expect(player.pause()).toBe(true);
    expect(player.overlay(Buffer.alloc(8))).toBe(false);
  });

  it('keys the prepared line by the track that starts', async () => {
    for (let i = 1; i <= 2; i++) queue.add(track(i));
    await musicManager.ensurePlaying();
    await vi.advanceTimersByTimeAsync(200 * 1000);
    expect(writeLine.mock.calls[0][0].forKey).toBe(trackKey(track(2)));
  });
});
