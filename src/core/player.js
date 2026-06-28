import {
  createAudioPlayer,
  createAudioResource,
  AudioPlayerStatus,
  NoSubscriberBehavior
} from '@discordjs/voice';
import { EventEmitter } from 'events';
import { getStream } from '../integrations/youtube.js';
import { resolutionManager, ResolutionManager } from '../services/resolutionManager.js';
import { logger } from '../utils/logger.js';

class MusicPlayer extends EventEmitter {
  constructor() {
    super();
    this.audioPlayer = createAudioPlayer({
      behaviors: {
        noSubscriber: NoSubscriberBehavior.Pause
      }
    });
    this.currentTrack = null;
    this.startTime = null;
    this.pausedAt = null;
    this._currentCleanup = null;
    this._switching = false;

    this._setupListeners();
  }

  _setupListeners() {
    // Debug: log all AudioPlayer state transitions
    this.audioPlayer.on('stateChange', (oldState, newState) => {
      logger.info(
        `[Player] State: ${oldState.status} -> ${newState.status}`,
        `resource=${!!newState.resource}`,
        `missedFrames=${newState.missedFrames ?? 'n/a'}`
      );
    });

    this.audioPlayer.on(AudioPlayerStatus.Idle, () => {
      this._cleanupCurrentStream();
      if (this._switching) return;
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
      logger.error('Audio player error:', error);
      this._cleanupCurrentStream();
      if (this._switching) return;
      this.emit('error', error);
    });
  }

  _cleanupCurrentStream() {
    if (this._currentCleanup) {
      try {
        this._currentCleanup();
      } catch (err) {
        logger.error('[Player] Error during stream cleanup:', err);
      }
      this._currentCleanup = null;
    }
  }

  /**
   * Play a track
   * @param {Object} track - Track object with url (or unresolved Spotify track)
   * @param {Object} connection - Voice connection
   * @returns {Promise<boolean>} True if playback started, false if track failed
   */
  async play(track, connection) {
    try {
      logger.info('Player.play() called with track:', track?.title);

      // Stop player and clean up previous stream before switching tracks
      this._switching = true;
      this.audioPlayer.stop();
      this._cleanupCurrentStream();

      // Check if track needs resolution
      if (!track.url || ResolutionManager.needsResolution(track)) {
        logger.info('Track needs resolution, resolving on-demand:', track.title);
        const resolved = await resolutionManager.ensureResolved(track);

        if (!resolved) {
          logger.warn('Failed to resolve track, skipping:', track.title);
          this.emit('trackFailed', track);
          return false;
        }

        // Track object is mutated by ensureResolved
        track = resolved;
      }

      logger.info('Playing track URL:', track.url);
      const streamResult = await getStream(track.url);
      this._currentCleanup = streamResult.cleanup || null;

      const resource = createAudioResource(streamResult.stream, {
        inputType: streamResult.type
      });

      this.currentTrack = track;
      this.startTime = Date.now();
      this.pausedAt = null;

      connection.subscribe(this.audioPlayer);
      this.audioPlayer.play(resource);
      this._switching = false;

      this.emit('trackStart', track);
      return true;
    } catch (error) {
      logger.error('Play error:', error);
      this._switching = false;
      this._cleanupCurrentStream();
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
        this.startTime += Date.now() - this.pausedAt;
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
    this._switching = true;
    this.audioPlayer.stop();
    this._cleanupCurrentStream();
    this._switching = false;
    this.currentTrack = null;
    this.startTime = null;
    this.pausedAt = null;
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
}

export { MusicPlayer };
