import { execFile, spawn } from 'child_process';
import { promisify } from 'util';
import { PassThrough } from 'stream';
import { existsSync } from 'fs';

const execFileAsync = promisify(execFile);

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
    return validHosts.some(host => urlObj.hostname === host);
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
    console.log('Searching YouTube for:', query);

    const { stdout } = await execFileAsync(YT_DLP_PATH, [
      `ytsearch${limit}:${query}`,
      '--dump-json',
      '--flat-playlist',
      '--no-warnings',
      '--ignore-errors'
    ], { maxBuffer: 10 * 1024 * 1024 });

    const results = stdout
      .trim()
      .split('\n')
      .filter(line => line)
      .map(line => {
        const data = JSON.parse(line);
        return {
          title: data.title || 'Unknown',
          url: `https://www.youtube.com/watch?v=${data.id}`,
          duration: data.duration || 0,
          thumbnail: data.thumbnail || data.thumbnails?.[0]?.url || null,
          channel: data.channel || data.uploader || 'Unknown'
        };
      });

    console.log('Search results:', JSON.stringify(results, null, 2));
    return results;
  } catch (error) {
    console.error('YouTube search error:', error);
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

    const args = [
      url,
      '--dump-json',
      '--no-download',
      '--no-warnings',
      '--no-playlist'
    ];

    // Add cookies support if configured
    if (process.env.YT_DLP_COOKIES) {
      args.push('--cookies', process.env.YT_DLP_COOKIES);
    }

    const { stdout } = await execFileAsync(YT_DLP_PATH, args, { maxBuffer: 10 * 1024 * 1024 });

    const data = JSON.parse(stdout);

    return {
      title: data.title,
      url: data.webpage_url || url,
      duration: data.duration || 0,
      thumbnail: data.thumbnail || data.thumbnails?.[0]?.url || null,
      channel: data.channel || data.uploader || 'Unknown'
    };
  } catch (error) {
    console.error('YouTube info error:', error);
    return null;
  }
}

/**
 * Get audio stream for playback
 * @param {string} url - YouTube URL
 * @returns {Promise<Object>} Stream object for discord.js voice
 */
export async function getStream(url) {
  console.log('Getting stream for URL:', url);

  const args = [
    url,
    '-f', 'bestaudio[ext=webm]/bestaudio/best',
    '-o', '-',
    '--no-warnings',
    '--no-playlist',
    '--quiet'
  ];

  // Add cookies support if configured
  if (process.env.YT_DLP_COOKIES) {
    args.push('--cookies', process.env.YT_DLP_COOKIES);
  }

  const ytdlp = spawn(YT_DLP_PATH, args);

  const stream = new PassThrough();

  ytdlp.stdout.pipe(stream);

  ytdlp.stderr.on('data', (data) => {
    console.error('yt-dlp stderr:', data.toString());
  });

  ytdlp.on('error', (error) => {
    console.error('yt-dlp process error:', error);
    stream.destroy(error);
  });

  ytdlp.on('close', (code) => {
    if (code !== 0 && code !== null) {
      console.error(`yt-dlp exited with code ${code}`);
    }
  });

  return {
    stream,
    type: 'arbitrary'
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
      url,
      '--dump-json',
      '--flat-playlist',
      '--no-warnings',
      '--ignore-errors',
      '--playlist-end', String(limit)
    ];

    // Add cookies support if configured
    if (process.env.YT_DLP_COOKIES) {
      args.push('--cookies', process.env.YT_DLP_COOKIES);
    }

    const { stdout } = await execFileAsync(YT_DLP_PATH, args, { maxBuffer: 10 * 1024 * 1024 });

    const results = stdout
      .trim()
      .split('\n')
      .filter(line => line)
      .map(line => {
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
    console.error('YouTube playlist error:', error);
    return [];
  }
}
