import { execFile, spawn } from 'child_process';
import { promisify } from 'util';
import { PassThrough } from 'stream';
import { existsSync } from 'fs';
import { StreamType } from '@discordjs/voice';
import { logger } from '../utils/logger.js';

const execFileAsync = promisify(execFile);

const SEARCH_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes
// Hard cap on cached search queries. The cache is a plain Map used as a simple
// LRU (insertion order = recency): a hit deletes + re-inserts the key to mark it
// most-recently-used, and inserts past the cap evict the oldest key. This bounds
// memory regardless of how many distinct queries are issued.
const SEARCH_CACHE_MAX_ENTRIES = 200;
const searchCache = new Map(); // key -> { expiresAt, results }

/**
 * Read a still-valid entry from the search cache, applying LRU recency and TTL.
 * Expired or missing entries are removed and reported as a miss.
 * @param {string} key
 * @returns {Array|null} cached results, or null on miss
 */
function getCachedSearch(key) {
  const cached = searchCache.get(key);
  if (!cached) return null;
  if (Date.now() >= cached.expiresAt) {
    searchCache.delete(key);
    return null;
  }
  // Move to most-recently-used position.
  searchCache.delete(key);
  searchCache.set(key, cached);
  return cached.results;
}

/**
 * Store search results, enforcing the LRU cap. Re-inserting an existing key
 * refreshes its recency; overflow evicts the oldest entries.
 * @param {string} key
 * @param {Array} results
 */
function setCachedSearch(key, results) {
  if (searchCache.has(key)) searchCache.delete(key);
  searchCache.set(key, { results, expiresAt: Date.now() + SEARCH_CACHE_TTL_MS });
  while (searchCache.size > SEARCH_CACHE_MAX_ENTRIES) {
    const oldest = searchCache.keys().next().value;
    searchCache.delete(oldest);
  }
}

// Cap concurrent yt-dlp metadata processes (search / getInfo / getPlaylist) so a
// burst of requests can't spawn unbounded child processes. Long-lived playback
// streams (getStream) are intentionally excluded; they are guarded by a watchdog.
const MAX_METADATA_CONCURRENCY = (() => {
  const n = parseInt(process.env.YT_DLP_MAX_CONCURRENCY, 10);
  return Number.isNaN(n) || n < 1 ? 4 : n;
})();

// Watchdog timeout: kill a getStream yt-dlp that produces no output and never exits.
const STREAM_START_TIMEOUT_MS = (() => {
  const n = parseInt(process.env.YT_DLP_STREAM_TIMEOUT_MS, 10);
  return Number.isNaN(n) || n < 1 ? 15_000 : n;
})();

// Bound the queue of callers waiting for a metadata slot. Without this, a stall
// in yt-dlp could let waiters (and their pending requests/file descriptors) grow
// without limit. Past the cap, new acquires are rejected so the caller returns an
// error instead of piling up.
const MAX_METADATA_WAITERS = (() => {
  const n = parseInt(process.env.YT_DLP_MAX_QUEUE, 10);
  return Number.isNaN(n) || n < 1 ? 50 : n;
})();

let activeMetadata = 0;
const metadataWaiters = [];

function acquireMetadataSlot() {
  if (activeMetadata < MAX_METADATA_CONCURRENCY) {
    activeMetadata++;
    return Promise.resolve();
  }
  if (metadataWaiters.length >= MAX_METADATA_WAITERS) {
    return Promise.reject(new Error('yt-dlp metadata queue is full; try again later'));
  }
  return new Promise((resolve) => metadataWaiters.push(resolve));
}

function releaseMetadataSlot() {
  const next = metadataWaiters.shift();
  if (next) {
    // Hand the in-use slot directly to the next waiter.
    next();
  } else {
    activeMetadata--;
  }
}

/**
 * Run a yt-dlp metadata call while holding a concurrency slot.
 * @param {() => Promise<T>} fn
 * @returns {Promise<T>}
 * @template T
 */
async function withMetadataSlot(fn) {
  await acquireMetadataSlot();
  try {
    return await fn();
  } finally {
    releaseMetadataSlot();
  }
}

function isDebugEnabled() {
  return process.env.DEBUG_YTDLP === '1' || process.env.DEBUG_YTDLP === 'true';
}

/**
 * Get the yt-dlp binary path, auto-detecting Docker vs local environments
 */
function getYtDlpPath() {
  if (process.env.YT_DLP_PATH) return process.env.YT_DLP_PATH;
  // Docker path
  if (existsSync('/app/bin/yt-dlp')) return '/app/bin/yt-dlp';
  // Local development path
  if (existsSync('./bin/yt-dlp')) return './bin/yt-dlp';
  // System-installed fallback
  return 'yt-dlp';
}

const YT_DLP_PATH = getYtDlpPath();

/**
 * Check if URL is a valid YouTube link
 * @param {string} url - URL to check
 * @returns {boolean}
 */
export function isValidUrl(url) {
  try {
    const urlObj = new URL(url);
    const validHosts = [
      'youtube.com',
      'www.youtube.com',
      'youtu.be',
      'm.youtube.com',
      'music.youtube.com'
    ];
    return validHosts.some((host) => urlObj.hostname === host);
  } catch {
    return false;
  }
}

/**
 * Search YouTube for videos
 * @param {string} query - Search query
 * @param {number} limit - Max results (default 5)
 * @returns {Promise<Array>} Array of track objects
 */
export async function search(query, limit = 5) {
  try {
    const cacheKey = `${String(query)}::${Number(limit)}`;
    const cached = getCachedSearch(cacheKey);
    if (cached) {
      return cached;
    }

    if (isDebugEnabled()) {
      logger.debug('Searching YouTube for:', query);
    }

    const { stdout } = await withMetadataSlot(() =>
      execFileAsync(
        YT_DLP_PATH,
        [
          '--dump-json',
          '--flat-playlist',
          '--no-warnings',
          '--ignore-errors',
          // `--` ends option parsing so the search term can never be read as a flag.
          '--',
          `ytsearch${limit}:${query}`
        ],
        { maxBuffer: 10 * 1024 * 1024 }
      )
    );

    const results = stdout
      .trim()
      .split('\n')
      .filter((line) => line)
      .map((line) => {
        const data = JSON.parse(line);
        return {
          title: data.title || 'Unknown',
          url: `https://www.youtube.com/watch?v=${data.id}`,
          duration: data.duration || 0,
          thumbnail: data.thumbnail || data.thumbnails?.[0]?.url || null,
          channel: data.channel || data.uploader || 'Unknown'
        };
      });

    setCachedSearch(cacheKey, results);

    if (isDebugEnabled()) {
      logger.debug('Search results:', JSON.stringify(results, null, 2));
    }
    return results;
  } catch (error) {
    logger.error('YouTube search error:', error);
    return [];
  }
}

/**
 * Get video info from URL
 * @param {string} url - YouTube URL
 * @returns {Promise<Object|null>} Track object or null
 */
export async function getInfo(url) {
  try {
    if (!isValidUrl(url)) {
      return null;
    }

    const args = ['--dump-json', '--no-download', '--no-warnings', '--no-playlist'];

    // Add cookies support if configured
    if (process.env.YT_DLP_COOKIES) {
      args.push('--cookies', process.env.YT_DLP_COOKIES);
    }

    // `--` ends option parsing so the URL can never be read as a flag.
    args.push('--', url);

    const { stdout } = await withMetadataSlot(() =>
      execFileAsync(YT_DLP_PATH, args, { maxBuffer: 10 * 1024 * 1024 })
    );

    const data = JSON.parse(stdout);

    return {
      title: data.title,
      url: data.webpage_url || url,
      duration: data.duration || 0,
      thumbnail: data.thumbnail || data.thumbnails?.[0]?.url || null,
      channel: data.channel || data.uploader || 'Unknown'
    };
  } catch (error) {
    logger.error('YouTube info error:', error);
    return null;
  }
}

/**
 * Get audio stream for playback
 * @param {string} url - YouTube URL
 * @returns {Promise<Object>} Stream object for discord.js voice
 */
export async function getStream(url) {
  logger.debug('Getting stream for URL:', url);

  // Prefer Opus (smallest download) but accept any container/codec. The stream is
  // transcoded by ffmpeg below (StreamType.Arbitrary), so we are no longer tied to
  // the webm/opus container — this avoids the "Did not find the EBML tag" demuxer
  // error that occurred when YouTube served a non-webm format (e.g. m4a/AAC) but we
  // hardcoded StreamType.WebmOpus.
  const args = [
    '-f',
    'bestaudio[acodec=opus]/bestaudio/best',
    '-o',
    '-',
    '--no-warnings',
    '--no-playlist',
    '--quiet'
  ];

  // Add cookies support if configured
  if (process.env.YT_DLP_COOKIES) {
    args.push('--cookies', process.env.YT_DLP_COOKIES);
  }

  // `--` ends option parsing so the URL can never be read as a flag.
  args.push('--', url);

  const ytdlp = spawn(YT_DLP_PATH, args);
  const stream = new PassThrough();

  // Single idempotent teardown. Safe to call any number of times and from any
  // terminal path (watchdog, process error, stream error, consumer
  // close/abort, setup throw, or external cleanup). It clears the watchdog,
  // detaches the terminal listeners so they can't re-enter, kills the child if
  // it is still running, and destroys the stream if it is still open.
  let watchdog = null;
  let cleanedUp = false;

  const cleanup = (err) => {
    if (cleanedUp) return;
    cleanedUp = true;

    if (watchdog) {
      clearTimeout(watchdog);
      watchdog = null;
    }

    // Detach terminal listeners first so a destroy()/kill() side effect below
    // can't re-trigger cleanup before the guard above takes effect.
    ytdlp.removeListener('error', onProcessError);
    ytdlp.removeListener('close', onProcessClose);
    stream.removeListener('error', onStreamError);
    stream.removeListener('close', onStreamClose);

    if (!ytdlp.killed) {
      try {
        ytdlp.kill('SIGKILL');
        logger.debug('[Stream] yt-dlp process killed via cleanup');
      } catch (killErr) {
        logger.debug('[Stream] yt-dlp kill skipped (already exited):', killErr.message);
      }
    }

    if (!stream.destroyed) {
      stream.destroy(err || undefined);
      logger.debug('[Stream] PassThrough destroyed via cleanup');
    }
  };

  function onProcessError(error) {
    logger.error('yt-dlp process error:', error);
    cleanup(error);
  }

  function onProcessClose(code) {
    if (watchdog) {
      clearTimeout(watchdog);
      watchdog = null;
    }
    if (code !== 0 && code !== null) {
      logger.error(`yt-dlp exited with code ${code}`);
    }
    // Normal exit: do NOT destroy the stream here — let buffered audio drain so
    // the consumer reads the final bytes. The process has already exited, so the
    // child is reaped. The stream's own 'close' (after drain) runs cleanup to
    // remove listeners and is a no-op kill on the already-exited child.
  }

  function onStreamError(err) {
    logger.debug('[Stream] PassThrough error (expected during cleanup):', err.message);
    cleanup(err);
  }

  function onStreamClose() {
    logger.debug('[Stream] PassThrough closed');
    // Fires on natural drain AND on consumer destroy/abort. In the abort case
    // yt-dlp may still be running, so this guarantees the child is killed.
    cleanup();
  }

  try {
    // Startup watchdog: if yt-dlp emits no data and hasn't exited within the
    // timeout, it is hung (e.g. waiting on a prompt) and would leak the process.
    // Kill it and surface an error so playback can fall back to the next track.
    watchdog = setTimeout(() => {
      watchdog = null;
      logger.error(
        `[Stream] yt-dlp produced no output within ${STREAM_START_TIMEOUT_MS}ms for ${url}; killing process`
      );
      cleanup(new Error('yt-dlp stream startup timed out'));
    }, STREAM_START_TIMEOUT_MS);

    // First byte means yt-dlp is healthy; stand the watchdog down.
    ytdlp.stdout.once('data', () => {
      if (watchdog) {
        clearTimeout(watchdog);
        watchdog = null;
      }
    });

    ytdlp.stdout.pipe(stream);

    // Debug: log remaining stream lifecycle events (close is handled above).
    stream.on('end', () => logger.debug('[Stream] PassThrough ended'));
    stream.on('finish', () => logger.debug('[Stream] PassThrough finished'));
    ytdlp.stdout.on('end', () => logger.debug('[Stream] yt-dlp stdout ended'));
    ytdlp.stdout.on('close', () => logger.debug('[Stream] yt-dlp stdout closed'));

    ytdlp.stderr.on('data', (data) => {
      logger.error('yt-dlp stderr:', data.toString());
    });

    ytdlp.on('error', onProcessError);
    ytdlp.on('close', onProcessClose);
    stream.on('error', onStreamError);
    stream.on('close', onStreamClose);
  } catch (setupError) {
    // Any synchronous failure while wiring up the pipeline must not leak the
    // spawned child.
    logger.error('[Stream] setup failed; tearing down yt-dlp:', setupError);
    cleanup(setupError);
    throw setupError;
  }

  return {
    stream,
    // Arbitrary => @discordjs/voice pipes the stream through ffmpeg and re-encodes
    // to Opus, normalizing whatever container yt-dlp produced. Do not switch this
    // back to WebmOpus without restricting the format selector to webm/opus only.
    type: StreamType.Arbitrary,
    cleanup
  };
}

/**
 * Check if URL is a YouTube playlist
 * @param {string} url - URL to check
 * @returns {boolean}
 */
export function isPlaylist(url) {
  try {
    const urlObj = new URL(url);
    return urlObj.searchParams.has('list') && !urlObj.searchParams.has('v');
  } catch {
    return false;
  }
}

/**
 * Get all videos from a playlist
 * @param {string} url - Playlist URL
 * @param {number} limit - Max videos (default 50)
 * @returns {Promise<Array>} Array of track objects
 */
export async function getPlaylist(url, limit = 50) {
  try {
    const args = [
      '--dump-json',
      '--flat-playlist',
      '--no-warnings',
      '--ignore-errors',
      '--playlist-end',
      String(limit)
    ];

    // Add cookies support if configured
    if (process.env.YT_DLP_COOKIES) {
      args.push('--cookies', process.env.YT_DLP_COOKIES);
    }

    // `--` ends option parsing so the URL can never be read as a flag.
    args.push('--', url);

    const { stdout } = await withMetadataSlot(() =>
      execFileAsync(YT_DLP_PATH, args, { maxBuffer: 10 * 1024 * 1024 })
    );

    const results = stdout
      .trim()
      .split('\n')
      .filter((line) => line)
      .map((line) => {
        const data = JSON.parse(line);
        return {
          title: data.title || 'Unknown',
          url: `https://www.youtube.com/watch?v=${data.id}`,
          duration: data.duration || 0,
          thumbnail: data.thumbnail || data.thumbnails?.[0]?.url || null,
          channel: data.channel || data.uploader || 'Unknown'
        };
      });

    return results;
  } catch (error) {
    logger.error('YouTube playlist error:', error);
    return [];
  }
}
