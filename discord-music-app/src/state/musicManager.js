import { EventEmitter } from 'events';
import { db } from '../database/db.js';

class MusicManager extends EventEmitter {
  constructor() {
    super();
    this.player = null;
    this.queue = null;
    this.voiceManager = null;
    this.guildId = null;
    this.getConnection = null; // Will be set by playback.js
  }

  // Inject dependencies from bot
  setPlayer(player) {
    this.player = player;

    // Forward player events
    if (player) {
      player.on('trackStart', (track) => this.onTrackChange(track));
      player.on('trackEnd', () => this.emit('track:end'));
      player.on('stateChange', () => this.emitState());
    }
  }

  setQueue(queue) {
    this.queue = queue;
  }

  setVoiceManager(voiceManager) {
    this.voiceManager = voiceManager;
  }

  setGuildId(guildId) {
    this.guildId = guildId;
  }

  setGetConnection(fn) {
    this.getConnection = fn;
  }

  // Queue operations (emit events for Socket.io)
  addToQueue(track) {
    if (!this.queue) return false;
    this.queue.add(track);
    this.emit('queue:update', this.queue.getAll());
    return true;
  }

  removeFromQueue(index) {
    if (!this.queue) return false;
    const removed = this.queue.remove(index);
    if (removed) {
      this.emit('queue:update', this.queue.getAll());
    }
    return removed;
  }

  reorderQueue(from, to) {
    if (!this.queue) return false;
    const success = this.queue.reorder(from, to);
    if (success) {
      this.emit('queue:update', this.queue.getAll());
    }
    return success;
  }

  clearQueue() {
    if (!this.queue) return false;
    this.queue.clear();
    this.emit('queue:update', this.queue.getAll());
    return true;
  }

  shuffleQueue() {
    if (!this.queue) return false;
    this.queue.shuffle();
    this.emit('queue:update', this.queue.getAll());
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
    const next = this.queue.next();
    if (next) {
      const connection = this.getConnection?.(this.guildId);
      if (connection) {
        await this.player.play(next, connection);
      }
    } else {
      this.player.stop();
    }
    this.emit('queue:update', this.queue.getAll());
    return true;
  }

  stop() {
    if (!this.player) return false;
    this.player.stop();
    if (this.queue) {
      this.queue.clear();
      this.queue.currentIndex = 0;
    }
    this.emit('queue:update', []);
    this.emit('track:change', null);
    this.emitState();
    return true;
  }

  setVolume(level) {
    if (!this.player) return false;
    this.player.setVolume(level);
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
      volume: this.player?.volume ?? 100,
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
      db.addToHistory(track);
    }
    this.emit('track:change', track);
    this.emit('queue:update', this.queue?.getAll() || []);
  }

  // Get full state for initial sync
  getFullState() {
    return {
      queue: this.getQueue(),
      currentIndex: this.getCurrentIndex(),
      currentTrack: this.getCurrentTrack(),
      playerState: this.getPlayerState()
    };
  }
}

// Singleton
export const musicManager = new MusicManager();
