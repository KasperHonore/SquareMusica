import { EventEmitter } from 'events';
import { resolveSpotifyTrack } from './resolver.js';

/**
 * Track resolution status
 * @typedef {'resolved' | 'resolving' | 'pending' | 'unresolved' | 'failed'} ResolutionStatus
 */

/**
 * Manages lazy resolution of Spotify tracks to YouTube URLs
 * Uses a lookahead window to resolve tracks ahead of playback
 */
class ResolutionManager extends EventEmitter {
  constructor(options = {}) {
    super();
    this.queue = null;
    this.lookahead = options.lookahead || 5;
    this.isProcessing = false;
    this.processingTracks = new Set(); // Track IDs currently being resolved
    this.concurrency = options.concurrency || 2;
  }

  /**
   * Set the queue reference
   * @param {Object} queue - Queue instance
   */
  setQueue(queue) {
    this.queue = queue;
  }

  /**
   * Process tracks within the lookahead window
   * Called when queue changes or track advances
   * @param {number} currentIndex - Current playback position
   */
  async processLookahead(currentIndex = 0) {
    if (!this.queue || this.isProcessing) return;

    this.isProcessing = true;

    try {
      const tracks = this.queue.getAll();
      const windowStart = currentIndex;
      const windowEnd = Math.min(currentIndex + this.lookahead, tracks.length);

      // Collect tracks that need resolution within the window
      const tracksToResolve = [];

      for (let i = windowStart; i < windowEnd; i++) {
        const track = tracks[i];
        if (!track) continue;

        // Skip already resolved, failed, or currently resolving tracks
        if (track.status === 'resolved' || track.status === 'resolving' || track.status === 'failed') continue;
        if (track.url) continue;  // Already has URL
        if (this.processingTracks.has(this._getTrackId(track))) continue;

        // Skip if no Spotify data to resolve from
        if (!track.spotifyData) continue;

        // Mark as pending if in window and unresolved
        if (track.status === 'unresolved' || !track.status) {
          track.status = 'pending';
        }

        tracksToResolve.push({ track, index: i });
      }

      // Process tracks with controlled concurrency
      const chunks = this._chunkArray(tracksToResolve, this.concurrency);

      for (const chunk of chunks) {
        await Promise.all(chunk.map(({ track, index }) =>
          this._resolveTrack(track, index)
        ));
      }

    } finally {
      this.isProcessing = false;
    }

    // Emit progress event
    this.emit('resolution:progress', this._getResolutionStats());
  }

  /**
   * Ensure a track is resolved before playback
   * If not resolved, resolve synchronously (blocking)
   * @param {Object} track - Track to resolve
   * @returns {Promise<Object|null>} Resolved track or null if failed
   */
  async ensureResolved(track) {
    // Already resolved
    if (track.url && track.status !== 'failed') {
      return track;
    }

    // No Spotify data to resolve from
    if (!track.spotifyData) {
      console.error('Track has no URL and no Spotify data:', track.title);
      track.status = 'failed';
      return null;
    }

    // Resolve synchronously
    console.log(`Resolving track on-demand: ${track.title}`);
    console.log(`Spotify data:`, JSON.stringify(track.spotifyData, null, 2));
    track.status = 'resolving';
    this.emit('resolution:progress', this._getResolutionStats());

    try {
      const resolved = await resolveSpotifyTrack(track.spotifyData);
      console.log(`Resolution result for ${track.title}:`, resolved ? 'SUCCESS' : 'FAILED');

      if (resolved) {
        // Update track with resolved data
        track.url = resolved.url;
        track.channel = resolved.channel;
        track.thumbnail = track.thumbnail || resolved.thumbnail;
        track.status = 'resolved';

        this.emit('resolution:complete', track);
        return track;
      } else {
        track.status = 'failed';
        this.emit('resolution:failed', track);
        return null;
      }
    } catch (error) {
      console.error('Error resolving track on-demand:', error);
      track.status = 'failed';
      this.emit('resolution:failed', track);
      return null;
    }
  }

  /**
   * Resolve a single track (internal)
   * @param {Object} track - Track to resolve
   * @param {number} index - Track index in queue
   */
  async _resolveTrack(track, index) {
    const trackId = this._getTrackId(track);

    if (this.processingTracks.has(trackId)) return;
    this.processingTracks.add(trackId);

    track.status = 'resolving';
    this.emit('resolution:progress', this._getResolutionStats());

    try {
      if (!track.spotifyData) {
        track.status = 'failed';
        this.emit('resolution:failed', track);
        return;
      }

      const resolved = await resolveSpotifyTrack(track.spotifyData);

      if (resolved) {
        track.url = resolved.url;
        track.channel = resolved.channel;
        track.thumbnail = track.thumbnail || resolved.thumbnail;
        track.status = 'resolved';

        this.emit('resolution:complete', track);
        console.log(`Resolved track: ${track.title} -> ${track.url}`);
      } else {
        track.status = 'failed';
        this.emit('resolution:failed', track);
        console.warn(`Failed to resolve track: ${track.title}`);
      }
    } catch (error) {
      console.error(`Error resolving track ${track.title}:`, error);
      track.status = 'failed';
      this.emit('resolution:failed', track);
    } finally {
      this.processingTracks.delete(trackId);
    }
  }

  /**
   * Get unique identifier for a track
   * @param {Object} track - Track object
   * @returns {string} Track identifier
   */
  _getTrackId(track) {
    if (track.spotifyData?.spotifyId) {
      return `spotify:${track.spotifyData.spotifyId}`;
    }
    if (track.url) {
      return `url:${track.url}`;
    }
    return `title:${track.title}:${track.addedAt?.getTime() || Date.now()}`;
  }

  /**
   * Split array into chunks
   * @param {Array} arr - Array to chunk
   * @param {number} size - Chunk size
   * @returns {Array<Array>} Chunked array
   */
  _chunkArray(arr, size) {
    const chunks = [];
    for (let i = 0; i < arr.length; i += size) {
      chunks.push(arr.slice(i, i + size));
    }
    return chunks;
  }

  /**
   * Get resolution statistics
   * @returns {Object} Stats object
   */
  _getResolutionStats() {
    if (!this.queue) {
      return { resolved: 0, resolving: 0, pending: 0, unresolved: 0, failed: 0, total: 0 };
    }

    const tracks = this.queue.getAll();
    const stats = {
      resolved: 0,
      resolving: 0,
      pending: 0,
      unresolved: 0,
      failed: 0,
      total: tracks.length
    };

    for (const track of tracks) {
      const status = track.status || (track.url ? 'resolved' : 'unresolved');
      if (stats.hasOwnProperty(status)) {
        stats[status]++;
      }
    }

    return stats;
  }

  /**
   * Start background processing loop
   * Periodically checks and resolves tracks in the lookahead window
   */
  start() {
    if (this._intervalId) return;

    this._intervalId = setInterval(() => {
      if (this.queue) {
        this.processLookahead(this.queue.currentIndex);
      }
    }, 2000); // Check every 2 seconds
  }

  /**
   * Stop background processing
   */
  stop() {
    if (this._intervalId) {
      clearInterval(this._intervalId);
      this._intervalId = null;
    }
  }

  /**
   * Check if a track needs resolution (unresolved Spotify track)
   * @param {Object} track - Track to check
   * @returns {boolean}
   */
  static needsResolution(track) {
    return !track.url && track.spotifyData && track.status !== 'failed';
  }

  /**
   * Create an unresolved track from Spotify data
   * @param {Object} spotifyTrack - Spotify track data
   * @param {Object|string} userInfo - User who requested the track (object with username/id/avatar or just username string)
   * @returns {Object} Unresolved queue track
   */
  static createUnresolvedTrack(spotifyTrack, userInfo) {
    // Handle both string (legacy) and object formats
    const user = typeof userInfo === 'string'
      ? { username: userInfo, id: null, avatar: null }
      : userInfo;

    return {
      title: spotifyTrack.title,
      duration: Math.floor(spotifyTrack.durationMs / 1000),
      thumbnail: null,
      requestedBy: user.username,
      requestedById: user.id,
      requestedByAvatar: user.avatar,
      url: null,
      channel: null,
      spotifyData: {
        spotifyId: spotifyTrack.spotifyId,
        title: spotifyTrack.title,  // Required for resolver search query
        artists: spotifyTrack.artists,
        durationMs: spotifyTrack.durationMs,
        spotifyUrl: spotifyTrack.spotifyUrl
      },
      status: 'unresolved'
    };
  }
}

// Singleton instance
export const resolutionManager = new ResolutionManager();

export { ResolutionManager };
