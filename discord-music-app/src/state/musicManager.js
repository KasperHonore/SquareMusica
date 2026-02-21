import { EventEmitter } from 'events';
import { db } from '../database/db.js';
import { resolutionManager } from '../music/resolutionManager.js';
import { getChannelInfo } from '../bot/voiceManager.js';
import { getBotInfo } from '../bot/client.js';

class MusicManager extends EventEmitter {
  constructor() {
    super();
    this.player = null;
    this.queue = null;
    this.guildId = null;
    this.getConnection = null; // Will be set by playback.js
    this._resolutionListenersSetup = false;
  }

  // Inject dependencies from bot
  setPlayer(player) {
    this.player = player;

    // Forward player events
    if (player) {
      player.on('trackStart', (track) => this.onTrackChange(track));
      player.on('trackEnd', () => this.emitState());
      player.on('stateChange', () => this.emitState());
    }
  }

  setQueue(queue) {
    this.queue = queue;
    // Also set queue in resolution manager
    resolutionManager.setQueue(queue);
    resolutionManager.start();

    // Forward resolution events to clients (only set up once)
    if (!this._resolutionListenersSetup) {
      this._resolutionListenersSetup = true;
      resolutionManager.on('resolution:progress', (stats) => {
        this.emit('resolution:progress', stats);
      });
      resolutionManager.on('resolution:complete', (track) => {
        this.emitQueueUpdate();
      });
      resolutionManager.on('resolution:failed', (track) => {
        this.emitQueueUpdate();
      });
    }
  }

  setGuildId(guildId) {
    this.guildId = guildId;
  }

  setGetConnection(fn) {
    this.getConnection = fn;
  }

  // Helper to emit queue updates with currentIndex
  emitQueueUpdate() {
    this.emit('queue:update', {
      tracks: this.queue?.getAll() || [],
      currentIndex: this.queue?.currentIndex || 0
    });
  }

  // Queue operations (emit events for Socket.io)
  addToQueue(track) {
    if (!this.queue) return false;
    this.queue.add(track);
    this.emitQueueUpdate();
    return true;
  }

  removeFromQueue(index) {
    if (!this.queue) return false;
    const removed = this.queue.remove(index);
    if (removed) {
      this.emitQueueUpdate();
    }
    return removed;
  }

  reorderQueue(from, to) {
    if (!this.queue) return false;
    const success = this.queue.reorder(from, to);
    if (success) {
      this.emitQueueUpdate();
    }
    return success;
  }

  clearQueue() {
    if (!this.queue) return false;
    this.queue.clear();
    this.emitQueueUpdate();
    return true;
  }

  shuffleQueue() {
    if (!this.queue) return false;
    this.queue.shuffle();
    this.emitQueueUpdate();
    return true;
  }

  // Playback operations
  play() {
    if (!this.player) return false;
    this.player.resume();
    this.emitState();
    return true;
  }

  pause() {
    if (!this.player) return false;
    this.player.pause();
    this.emitState();
    return true;
  }

  async skip() {
    if (!this.player || !this.queue) return false;

    let next = this.queue.next();
    let playedSuccessfully = false;

    // Try to find a playable track (skip failed resolution tracks)
    while (next) {
      const connection = this.getConnection?.(this.guildId);
      if (connection) {
        const success = await this.player.play(next, connection);
        if (success) {
          playedSuccessfully = true;
          // Trigger lookahead resolution
          resolutionManager.processLookahead(this.queue.currentIndex).catch(err => {
            console.error('Lookahead resolution error:', err);
          });
          break;
        }
        // Track failed to resolve, try next
        next = this.queue.next();
      } else {
        break;
      }
    }

    if (!playedSuccessfully && !next) {
      this.player.stop();
    }

    this.emitQueueUpdate();
    return true;
  }

  stop() {
    if (!this.player) return false;
    this.player.stop();
    if (this.queue) {
      this.queue.clear();
      this.queue.currentIndex = 0;
    }
    this.emit('queue:update', { tracks: [], currentIndex: 0 });
    this.emit('track:change', null);
    this.emitState();
    return true;
  }

  setLoop(mode) {
    if (!this.queue) return false;
    this.queue.loopMode = mode;
    this.emitState();
    return true;
  }

  // State getters
  getQueue() {
    return this.queue?.getAll() || [];
  }

  getCurrentTrack() {
    return this.queue?.getCurrent() || null;
  }

  getCurrentIndex() {
    return this.queue?.currentIndex || 0;
  }

  getPlayerState() {
    const guildId = this.guildId || process.env.GUILD_ID;
    return {
      playing: this.player?.isPlaying() || false,
      paused: this.player?.isPaused() || false,
      loop: this.queue?.loopMode || 'off',
      position: this.player?.getPosition() || 0,
      connected: !!this.getConnection?.(guildId)
    };
  }

  emitState() {
    this.emit('player:state', this.getPlayerState());
  }

  // Called when track changes
  onTrackChange(track) {
    if (track) {
      db.addToHistory(track, this.guildId);
    }
    this.emit('track:change', track);
    this.emitQueueUpdate();
  }

  // Get voice context
  getVoiceContext() {
    const guildId = this.guildId || process.env.GUILD_ID;
    return getChannelInfo(guildId);
  }

  // Emit voice context update
  emitVoiceContext() {
    this.emit('voice:context', this.getVoiceContext());
  }

  // Get full state for initial sync
  getFullState() {
    return {
      queue: this.getQueue(),
      currentIndex: this.getCurrentIndex(),
      currentTrack: this.getCurrentTrack(),
      playerState: this.getPlayerState(),
      resolutionStats: this.queue?.getResolutionStats() || null,
      voiceContext: this.getVoiceContext(),
      botInfo: getBotInfo()
    };
  }
}

// Singleton
export const musicManager = new MusicManager();
