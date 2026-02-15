import {
  createAudioPlayer,
  createAudioResource,
  AudioPlayerStatus,
  NoSubscriberBehavior,
  StreamType
} from '@discordjs/voice';
import { EventEmitter } from 'events';
import { getStream } from './youtube.js';

class MusicPlayer extends EventEmitter {
  constructor() {
    super();
    this.audioPlayer = createAudioPlayer({
      behaviors: {
        noSubscriber: NoSubscriberBehavior.Pause
      }
    });
    this.volume = 100;
    this.currentTrack = null;
    this.startTime = null;
    this.pausedAt = null;

    this._setupListeners();
  }

  _setupListeners() {
    this.audioPlayer.on(AudioPlayerStatus.Idle, () => {
      if (this.currentTrack) {
        this.emit('trackEnd', this.currentTrack);
        this.currentTrack = null;
        this.startTime = null;
      }
    });

    this.audioPlayer.on(AudioPlayerStatus.Playing, () => {
      this.emit('stateChange', 'playing');
    });

    this.audioPlayer.on(AudioPlayerStatus.Paused, () => {
      this.emit('stateChange', 'paused');
    });

    this.audioPlayer.on('error', (error) => {
      console.error('Audio player error:', error);
      this.emit('error', error);
    });
  }

  /**
   * Play a track
   * @param {Object} track - Track object with url
   * @param {Object} connection - Voice connection
   */
  async play(track, connection) {
    try {
      console.log('Player.play() called with track:', JSON.stringify(track, null, 2));
      console.log('Track URL:', track?.url);
      const stream = await getStream(track.url);
      const resource = createAudioResource(stream.stream, {
        inputType: StreamType.Arbitrary,
        inlineVolume: true
      });

      resource.volume?.setVolume(this.volume / 100);

      this.currentTrack = track;
      this.startTime = Date.now();
      this.pausedAt = null;

      connection.subscribe(this.audioPlayer);
      this.audioPlayer.play(resource);

      this.emit('trackStart', track);
    } catch (error) {
      console.error('Play error:', error);
      this.emit('error', error);
      throw error;
    }
  }

  /**
   * Pause playback
   */
  pause() {
    if (this.audioPlayer.state.status === AudioPlayerStatus.Playing) {
      this.pausedAt = Date.now();
      this.audioPlayer.pause();
      return true;
    }
    return false;
  }

  /**
   * Resume playback
   */
  resume() {
    if (this.audioPlayer.state.status === AudioPlayerStatus.Paused) {
      if (this.pausedAt && this.startTime) {
        // Adjust start time to account for pause duration
        this.startTime += (Date.now() - this.pausedAt);
      }
      this.pausedAt = null;
      this.audioPlayer.unpause();
      return true;
    }
    return false;
  }

  /**
   * Stop playback
   */
  stop() {
    this.audioPlayer.stop();
    this.currentTrack = null;
    this.startTime = null;
    this.pausedAt = null;
  }

  /**
   * Set volume (0-100)
   * @param {number} level
   */
  setVolume(level) {
    this.volume = Math.max(0, Math.min(100, level));
    const resource = this.audioPlayer.state.resource;
    if (resource?.volume) {
      resource.volume.setVolume(this.volume / 100);
    }
  }

  /**
   * Get current playback position in seconds
   * @returns {number}
   */
  getPosition() {
    if (!this.startTime) return 0;

    if (this.pausedAt) {
      return Math.floor((this.pausedAt - this.startTime) / 1000);
    }

    return Math.floor((Date.now() - this.startTime) / 1000);
  }

  /**
   * Check if currently playing
   * @returns {boolean}
   */
  isPlaying() {
    return this.audioPlayer.state.status === AudioPlayerStatus.Playing;
  }

  /**
   * Check if paused
   * @returns {boolean}
   */
  isPaused() {
    return this.audioPlayer.state.status === AudioPlayerStatus.Paused;
  }

  /**
   * Get the underlying audio player for direct access
   * @returns {AudioPlayer}
   */
  getAudioPlayer() {
    return this.audioPlayer;
  }
}

export { MusicPlayer };
