import { execFile, spawn } from 'child_process';
import { promisify } from 'util';
import { PassThrough } from 'stream';
import { existsSync } from 'fs';
import { StreamType } from '@discordjs/voice';
import { logger } from '../utils/logger.js';

const execFileAsync = promisify(execFile);

const SEARCH_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes
const searchCache = new Map(); // key -> { expiresAt, results }

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
    const cached = searchCache.get(cacheKey);
    if (cached && Date.now() < cached.expiresAt) {
      return cached.results;
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

    searchCache.set(cacheKey, { results, expiresAt: Date.now() + SEARCH_CACHE_TTL_MS });

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

  const args = [
    '-f',
    'bestaudio[ext=webm][acodec=opus]/bestaudio[ext=webm]/bestaudio/best',
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
  stream.on('error', (err) => {
    logger.debug('[Stream] PassThrough error (expected during cleanup):', err.message);
  });

  // Startup watchdog: if yt-dlp emits no data and hasn't exited within the
  // timeout, it is hung (e.g. waiting on a prompt) and would leak the process.
  // Kill it and surface an error so playback can fall back to the next track.
  let watchdog = setTimeout(() => {
    watchdog = null;
    logger.error(
      `[Stream] yt-dlp produced no output within ${STREAM_START_TIMEOUT_MS}ms for ${url}; killing process`
    );
    if (!ytdlp.killed) ytdlp.kill('SIGKILL');
    if (!stream.destroyed) stream.destroy(new Error('yt-dlp stream startup timed out'));
  }, STREAM_START_TIMEOUT_MS);

  const clearWatchdog = () => {
    if (watchdog) {
      clearTimeout(watchdog);
      watchdog = null;
    }
  };

  ytdlp.stdout.once('data', clearWatchdog);

  ytdlp.stdout.pipe(stream);

  // Debug: log stream lifecycle events
  stream.on('end', () => logger.debug('[Stream] PassThrough ended'));
  stream.on('close', () => logger.debug('[Stream] PassThrough closed'));
  stream.on('finish', () => logger.debug('[Stream] PassThrough finished'));
  ytdlp.stdout.on('end', () => logger.debug('[Stream] yt-dlp stdout ended'));
  ytdlp.stdout.on('close', () => logger.debug('[Stream] yt-dlp stdout closed'));

  ytdlp.stderr.on('data', (data) => {
    logger.error('yt-dlp stderr:', data.toString());
  });

  ytdlp.on('error', (error) => {
    clearWatchdog();
    logger.error('yt-dlp process error:', error);
    stream.destroy(error);
  });

  ytdlp.on('close', (code) => {
    clearWatchdog();
    if (code !== 0 && code !== null) {
      logger.error(`yt-dlp exited with code ${code}`);
    }
  });

  const cleanup = () => {
    clearWatchdog();
    if (!ytdlp.killed) {
      ytdlp.kill('SIGKILL');
      logger.debug('[Stream] yt-dlp process killed via cleanup');
    }
    if (!stream.destroyed) {
      stream.destroy();
      logger.debug('[Stream] PassThrough destroyed via cleanup');
    }
  };

  return {
    stream,
    type: StreamType.WebmOpus,
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
