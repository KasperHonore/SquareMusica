import { search } from '../integrations/youtube.js';
import { logger } from '../utils/logger.js';

// Cache configuration
const CACHE_TTL_MS = 4 * 60 * 60 * 1000; // 4 hours
// Hard cap on resolved/negative match entries. A few thousand keys keeps hot
// playlists fully cached while bounding memory in a long-lived process.
const CACHE_MAX_ENTRIES = 5000;

// Sentinels so getCached() can distinguish a true cache miss from a cached
// negative ("we searched and found nothing") result. Storing plain null for a
// negative result is ambiguous with a miss, which defeats the negative cache.
const MISS = Symbol('cache-miss');
const NEGATIVE = Symbol('cache-negative');

/**
 * Fixed-size, TTL-aware LRU cache backed by a single Map.
 *
 * Map preserves insertion order, so we use that ordering as the recency list:
 * the first key is the least-recently-used and the last is the most-recently-
 * used. On a hit we delete+re-insert to move the key to the MRU end; on an
 * insert beyond capacity we evict from the LRU front. Expired entries are
 * dropped lazily on access. `get()` returns the stored value or the MISS
 * sentinel so callers can cache negatives unambiguously.
 */
export class LruCache {
  /**
   * @param {Object} options
   * @param {number} options.maxEntries - Hard cap on retained entries.
   * @param {number} options.ttlMs - Time-to-live per entry in milliseconds.
   */
  constructor({ maxEntries, ttlMs }) {
    this.maxEntries = maxEntries;
    this.ttlMs = ttlMs;
    this.map = new Map();
  }

  /** @returns {number} Current number of live (un-evicted) entries. */
  get size() {
    return this.map.size;
  }

  /**
   * Presence check that respects TTL but does NOT touch recency ordering.
   * Intended for inspection/tests; the hot path uses get()/set().
   * @param {string} key
   * @returns {boolean}
   */
  has(key) {
    const entry = this.map.get(key);
    if (!entry) return false;
    if (Date.now() > entry.expiresAt) {
      this.map.delete(key);
      return false;
    }
    return true;
  }

  /**
   * @param {string} key
   * @returns {*} The cached value, or the MISS sentinel when absent/expired.
   */
  get(key) {
    const entry = this.map.get(key);
    if (!entry) return MISS;

    if (Date.now() > entry.expiresAt) {
      this.map.delete(key);
      return MISS;
    }

    // Refresh recency: move the key to the MRU end.
    this.map.delete(key);
    this.map.set(key, entry);

    return entry.value;
  }

  /**
   * @param {string} key
   * @param {*} value
   */
  set(key, value) {
    // Re-inserting moves the key to the MRU end; for a fresh key, evict the
    // least-recently-used entries first so we never exceed the cap.
    if (this.map.has(key)) {
      this.map.delete(key);
    } else {
      while (this.map.size >= this.maxEntries) {
        const lruKey = this.map.keys().next().value;
        if (lruKey === undefined) break;
        this.map.delete(lruKey);
      }
    }

    this.map.set(key, { value, expiresAt: Date.now() + this.ttlMs });
  }
}

// In-memory cache of resolved (and negative) YouTube matches, bounded by LRU.
const cache = new LruCache({ maxEntries: CACHE_MAX_ENTRIES, ttlMs: CACHE_TTL_MS });

/**
 * Generate cache key for a Spotify track
 * @param {Object} spotifyTrack - Spotify track object
 * @returns {string} Cache key
 */
function getCacheKey(spotifyTrack) {
  const artists = spotifyTrack.artists?.join(',') || '';
  const title = spotifyTrack.title || spotifyTrack.name || '';
  return `${artists}:${title}`.toLowerCase();
}

/**
 * Get cached result if valid.
 * @param {string} key - Cache key
 * @returns {Object|symbol} Cached value (an Object, or the NEGATIVE sentinel for
 *   a cached not-found), or the MISS sentinel when there is no valid entry.
 */
function getCached(key) {
  return cache.get(key);
}

/**
 * Set cache entry with LRU eviction.
 * @param {string} key - Cache key
 * @param {Object} value - Value to cache
 */
function setCache(key, value) {
  cache.set(key, value);
}

/**
 * Normalize string for comparison
 * @param {string} str - String to normalize
 * @returns {string} Normalized string
 */
function normalize(str) {
  return (str || '')
    .toLowerCase()
    .replace(/[^\w\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Extract words from a string
 * @param {string} str - String to extract words from
 * @returns {Set<string>} Set of words
 */
function getWords(str) {
  return new Set(
    normalize(str)
      .split(' ')
      .filter((w) => w.length > 1)
  );
}

/**
 * Check if channel name indicates official content
 * @param {string} channel - YouTube channel name
 * @returns {boolean}
 */
function isOfficialChannel(channel) {
  const lower = (channel || '').toLowerCase();
  return (
    lower.includes('official') ||
    lower.includes(' - topic') ||
    lower.includes('vevo') ||
    lower.endsWith('topic')
  );
}

/**
 * Score a YouTube result against a Spotify track
 * @param {Object} spotifyTrack - Spotify track with title, artists, durationMs
 * @param {Object} youtubeResult - YouTube result with title, channel, duration
 * @returns {number} Score 0-100
 */
function scoreMatch(spotifyTrack, youtubeResult) {
  let score = 0;

  // Duration matching (up to 40 points)
  const spotifyDuration = (spotifyTrack.durationMs || 0) / 1000;
  const youtubeDuration = youtubeResult.duration || 0;

  if (spotifyDuration > 0 && youtubeDuration > 0) {
    const durationDiff = Math.abs(spotifyDuration - youtubeDuration);
    if (durationDiff <= 15) {
      score += 40;
    } else if (durationDiff <= 30) {
      score += 20;
    }
  }

  // Title word matching (up to 30 points)
  const spotifyTitle = spotifyTrack.title || spotifyTrack.name || '';
  const spotifyWords = getWords(spotifyTitle);
  const youtubeWords = getWords(youtubeResult.title);

  if (spotifyWords.size > 0) {
    let matchCount = 0;
    for (const word of spotifyWords) {
      if (youtubeWords.has(word)) {
        matchCount++;
      }
    }
    const titleScore = (matchCount / spotifyWords.size) * 30;
    score += titleScore;
  }

  // Channel hints (up to 30 points)
  const channel = youtubeResult.channel || '';
  const artists = spotifyTrack.artists || [];

  // +20 for official/topic/vevo channels
  if (isOfficialChannel(channel)) {
    score += 20;
  }

  // +10 for artist name match in channel
  const channelNorm = normalize(channel);
  for (const artist of artists) {
    if (channelNorm.includes(normalize(artist))) {
      score += 10;
      break;
    }
  }

  return score;
}

/**
 * Resolve a single Spotify track to YouTube
 * @param {Object} spotifyTrack - Spotify track object
 *   - title/name: Track title
 *   - artists: Array of artist names
 *   - durationMs: Duration in milliseconds
 *   - is_local: Boolean indicating local track
 * @returns {Promise<Object|null>} YouTube track { url, title, channel, duration, thumbnail } or null
 */
export async function resolveSpotifyTrack(spotifyTrack) {
  // Handle local tracks
  if (spotifyTrack.is_local) {
    return null;
  }

  const cacheKey = getCacheKey(spotifyTrack);

  // Check cache first. A NEGATIVE sentinel means we previously searched and
  // found no acceptable match, so honor it instead of re-searching.
  const cached = getCached(cacheKey);
  if (cached !== MISS) {
    return cached === NEGATIVE ? null : cached;
  }

  try {
    const artists = spotifyTrack.artists || [];
    const title = spotifyTrack.title || spotifyTrack.name || '';

    if (!title) {
      return null;
    }

    // Build search query
    const query = artists.length > 0 ? `${artists.join(', ')} - ${title}` : title;

    logger.debug(`[Resolver] Searching YouTube for: "${query}"`);

    // Search YouTube (get top 5 results)
    const results = await search(query, 5);

    if (!results || results.length === 0) {
      logger.debug(`[Resolver] No YouTube results for: "${query}"`);
      setCache(cacheKey, NEGATIVE);
      return null;
    }

    logger.debug(`[Resolver] Found ${results.length} YouTube results for: "${query}"`);

    // Score each result and find best match
    let bestResult = null;
    let bestScore = 0;

    for (const result of results) {
      const score = scoreMatch(spotifyTrack, result);
      logger.debug(
        `[Resolver] Score ${score} for: "${result.title}" (duration: ${result.duration}s)`
      );
      if (score > bestScore) {
        bestScore = score;
        bestResult = result;
      }
    }

    // Require minimum score of 50 (>= 50 passes)
    if (bestScore < 50 || !bestResult) {
      logger.debug(`[Resolver] Best score ${bestScore} below threshold (50) for: "${query}"`);
      setCache(cacheKey, NEGATIVE);
      return null;
    }

    logger.debug(
      `[Resolver] Best match for "${query}": "${bestResult.title}" (score: ${bestScore})`
    );

    const resolved = {
      url: bestResult.url,
      title: bestResult.title,
      channel: bestResult.channel,
      duration: bestResult.duration,
      thumbnail: bestResult.thumbnail
    };

    setCache(cacheKey, resolved);
    return resolved;
  } catch (error) {
    logger.error('Error resolving Spotify track:', error);
    return null;
  }
}
