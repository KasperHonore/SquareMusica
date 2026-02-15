/**
 * Track object interface
 * @typedef {Object} Track
 * @property {string} title
 * @property {string} url
 * @property {number} duration - Duration in seconds
 * @property {string} thumbnail
 * @property {string} requestedBy - Discord user ID
 * @property {Date} addedAt
 */

class Queue {
  constructor() {
    this.tracks = [];
    this.currentIndex = 0;
    this.loopMode = 'off'; // 'off' | 'track' | 'queue'
  }

  /**
   * Add a track to the end of the queue
   * @param {Track} track
   */
  add(track) {
    this.tracks.push({
      ...track,
      addedAt: new Date()
    });
  }

  /**
   * Remove a track by index
   * @param {number} index
   * @returns {Track|null} Removed track or null
   */
  remove(index) {
    if (index < 0 || index >= this.tracks.length) {
      return null;
    }
    const [removed] = this.tracks.splice(index, 1);

    // Adjust currentIndex if needed
    if (index < this.currentIndex) {
      this.currentIndex--;
    } else if (index === this.currentIndex && this.currentIndex >= this.tracks.length) {
      this.currentIndex = Math.max(0, this.tracks.length - 1);
    }

    return removed;
  }

  /**
   * Clear all tracks
   */
  clear() {
    this.tracks = [];
    this.currentIndex = 0;
  }

  /**
   * Shuffle the queue (excluding current track)
   */
  shuffle() {
    if (this.tracks.length <= 1) return;

    // Keep current track in place, shuffle the rest
    const current = this.tracks[this.currentIndex];
    const before = this.tracks.slice(0, this.currentIndex);
    const after = this.tracks.slice(this.currentIndex + 1);

    // Fisher-Yates shuffle for tracks after current
    for (let i = after.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [after[i], after[j]] = [after[j], after[i]];
    }

    this.tracks = [...before, current, ...after];
  }

  /**
   * Get the next track based on loop mode
   * @returns {Track|null}
   */
  next() {
    if (this.tracks.length === 0) return null;

    if (this.loopMode === 'track') {
      return this.tracks[this.currentIndex];
    }

    if (this.currentIndex < this.tracks.length - 1) {
      this.currentIndex++;
      return this.tracks[this.currentIndex];
    }

    if (this.loopMode === 'queue') {
      this.currentIndex = 0;
      return this.tracks[this.currentIndex];
    }

    return null;
  }

  /**
   * Get the previous track
   * @returns {Track|null}
   */
  previous() {
    if (this.tracks.length === 0) return null;

    if (this.currentIndex > 0) {
      this.currentIndex--;
    } else if (this.loopMode === 'queue') {
      this.currentIndex = this.tracks.length - 1;
    }

    return this.tracks[this.currentIndex];
  }

  /**
   * Reorder a track from one position to another
   * @param {number} from
   * @param {number} to
   * @returns {boolean} Success
   */
  reorder(from, to) {
    if (from < 0 || from >= this.tracks.length ||
        to < 0 || to >= this.tracks.length ||
        from === to) {
      return false;
    }

    const [track] = this.tracks.splice(from, 1);
    this.tracks.splice(to, 0, track);

    // Adjust currentIndex
    if (from === this.currentIndex) {
      this.currentIndex = to;
    } else if (from < this.currentIndex && to >= this.currentIndex) {
      this.currentIndex--;
    } else if (from > this.currentIndex && to <= this.currentIndex) {
      this.currentIndex++;
    }

    return true;
  }

  /**
   * Get all tracks
   * @returns {Track[]}
   */
  getAll() {
    return [...this.tracks];
  }

  /**
   * Get current track
   * @returns {Track|null}
   */
  getCurrent() {
    return this.tracks[this.currentIndex] || null;
  }

  /**
   * Get queue length
   * @returns {number}
   */
  get length() {
    return this.tracks.length;
  }
}

export { Queue };
