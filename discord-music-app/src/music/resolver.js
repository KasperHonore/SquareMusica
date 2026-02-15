import { search } from './youtube.js';

// Cache configuration
const CACHE_TTL_MS = 4 * 60 * 60 * 1000; // 4 hours
const CACHE_MAX_ENTRIES = 5000;

// In-memory cache with TTL
const cache = new Map();
const cacheOrder = []; // FIFO eviction tracking

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
 * Get cached result if valid
 * @param {string} key - Cache key
 * @returns {Object|null} Cached result or null
 */
function getCached(key) {
  const entry = cache.get(key);
  if (!entry) return null;

  if (Date.now() > entry.expiresAt) {
    cache.delete(key);
    return null;
  }

  return entry.value;
}

/**
 * Set cache entry with FIFO eviction
 * @param {string} key - Cache key
 * @param {Object} value - Value to cache
 */
function setCache(key, value) {
  // Evict oldest entries if at capacity
  while (cache.size >= CACHE_MAX_ENTRIES && cacheOrder.length > 0) {
    const oldestKey = cacheOrder.shift();
    cache.delete(oldestKey);
  }

  cache.set(key, {
    value,
    expiresAt: Date.now() + CACHE_TTL_MS
  });
  cacheOrder.push(key);
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
  return new Set(normalize(str).split(' ').filter(w => w.length > 1));
}

/**
 * Check if channel name indicates official content
 * @param {string} channel - YouTube channel name
 * @returns {boolean}
 */
function isOfficialChannel(channel) {
  const lower = (channel || '').toLowerCase();
  return lower.includes('official') ||
         lower.includes(' - topic') ||
         lower.includes('vevo') ||
         lower.endsWith('topic');
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

  // Check cache first
  const cached = getCached(cacheKey);
  if (cached !== null) {
    return cached;
  }

  try {
    const artists = spotifyTrack.artists || [];
    const title = spotifyTrack.title || spotifyTrack.name || '';

    if (!title) {
      return null;
    }

    // Build search query
    const query = artists.length > 0
      ? `${artists.join(', ')} - ${title}`
      : title;

    console.log(`[Resolver] Searching YouTube for: "${query}"`);

    // Search YouTube (get top 5 results)
    const results = await search(query, 5);

    if (!results || results.length === 0) {
      console.log(`[Resolver] No YouTube results for: "${query}"`);
      setCache(cacheKey, null);
      return null;
    }

    console.log(`[Resolver] Found ${results.length} YouTube results for: "${query}"`);

    // Score each result and find best match
    let bestResult = null;
    let bestScore = 0;

    for (const result of results) {
      const score = scoreMatch(spotifyTrack, result);
      console.log(`[Resolver] Score ${score} for: "${result.title}" (duration: ${result.duration}s)`);
      if (score > bestScore) {
        bestScore = score;
        bestResult = result;
      }
    }

    // Require minimum score of 50 (>= 50 passes)
    if (bestScore < 50 || !bestResult) {
      console.log(`[Resolver] Best score ${bestScore} below threshold (50) for: "${query}"`);
      setCache(cacheKey, null);
      return null;
    }

    console.log(`[Resolver] Best match for "${query}": "${bestResult.title}" (score: ${bestScore})`)

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
    console.error('Error resolving Spotify track:', error);
    return null;
  }
}

/**
 * Create a promise pool for controlled concurrency
 * @param {Array} items - Items to process
 * @param {Function} fn - Async function to apply to each item
 * @param {number} concurrency - Max concurrent operations
 * @returns {Promise<Array>} Results in order
 */
async function promisePool(items, fn, concurrency) {
  const results = new Array(items.length);
  let nextIndex = 0;

  async function worker() {
    while (nextIndex < items.length) {
      const index = nextIndex++;
      try {
        results[index] = { success: true, value: await fn(items[index], index) };
      } catch (error) {
        results[index] = { success: false, error };
      }
    }
  }

  // Start workers
  const workers = [];
  for (let i = 0; i < Math.min(concurrency, items.length); i++) {
    workers.push(worker());
  }

  await Promise.all(workers);
  return results;
}

/**
 * Resolve multiple Spotify tracks to YouTube in batch
 * @param {Array} spotifyTracks - Array of Spotify track objects
 * @param {Object} options - Options
 * @param {number} options.concurrency - Max parallel searches (default 3)
 * @returns {Promise<Object>} { resolved: YouTubeTrack[], skipped: SkippedTrack[] }
 */
export async function resolveSpotifyTracks(spotifyTracks, { concurrency = 3 } = {}) {
  const resolved = [];
  const skipped = [];

  if (!spotifyTracks || spotifyTracks.length === 0) {
    return { resolved, skipped };
  }

  // Process tracks with controlled concurrency
  const results = await promisePool(
    spotifyTracks,
    async (track) => {
      // Check for local tracks before attempting resolution
      if (track.is_local) {
        return {
          type: 'skipped',
          track,
          reason: 'local_track'
        };
      }

      const youtubeTrack = await resolveSpotifyTrack(track);

      if (youtubeTrack) {
        return {
          type: 'resolved',
          track: youtubeTrack,
          spotifyTrack: track
        };
      } else {
        return {
          type: 'skipped',
          track,
          reason: 'not_found'
        };
      }
    },
    concurrency
  );

  // Collect results
  for (const result of results) {
    if (!result.success) {
      // Handle errors during resolution
      const track = result.error?.track || { title: 'Unknown', artists: [] };
      skipped.push({
        title: track.title || track.name || 'Unknown',
        artists: track.artists || [],
        reason: 'spotify_error'
      });
      continue;
    }

    const { type, track, spotifyTrack, reason } = result.value;

    if (type === 'resolved') {
      resolved.push(track);
    } else {
      skipped.push({
        title: track.title || track.name || 'Unknown',
        artists: track.artists || [],
        reason
      });
    }
  }

  return { resolved, skipped };
}

/**
 * Clear the resolver cache (useful for testing)
 */
export function clearCache() {
  cache.clear();
  cacheOrder.length = 0;
}

/**
 * Get cache statistics
 * @returns {Object} Cache stats
 */
export function getCacheStats() {
  return {
    size: cache.size,
    maxSize: CACHE_MAX_ENTRIES,
    ttlMs: CACHE_TTL_MS
  };
}
