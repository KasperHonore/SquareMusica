import { SpotifyApi } from '@spotify/web-api-ts-sdk';
import { logger } from '../utils/logger.js';

// Spotify API client (initialized lazily)
let spotifyClient = null;

/**
 * Get or create Spotify client instance
 * @returns {SpotifyApi|null}
 */
function getClient() {
  if (spotifyClient) {
    return spotifyClient;
  }

  const clientId = process.env.SPOTIFY_CLIENT_ID;
  const clientSecret = process.env.SPOTIFY_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    logger.warn('Spotify credentials not configured - Spotify features disabled');
    return null;
  }

  spotifyClient = SpotifyApi.withClientCredentials(clientId, clientSecret);
  return spotifyClient;
}

/**
 * Retry wrapper for handling rate limits and transient errors
 * @param {Function} fn - Async function to retry
 * @param {number} maxRetries - Maximum retry attempts (default 3)
 * @returns {Promise<*>}
 */
async function withRetry(fn, maxRetries = 3) {
  let lastError;

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;

      // Check for rate limit (429)
      if (error.status === 429 || error.message?.includes('429')) {
        const retryAfter =
          error.headers?.get?.('retry-after') || error.retryAfter || Math.pow(2, attempt + 1);
        const waitMs = (parseInt(retryAfter, 10) || Math.pow(2, attempt + 1)) * 1000;

        logger.warn(
          `Spotify rate limited, waiting ${waitMs}ms before retry ${attempt + 1}/${maxRetries}`
        );
        await new Promise((resolve) => setTimeout(resolve, waitMs));
        continue;
      }

      // For other errors, use exponential backoff
      if (attempt < maxRetries - 1) {
        const waitMs = Math.pow(2, attempt + 1) * 1000;
        logger.warn(`Spotify API error, retrying in ${waitMs}ms: ${error.message}`);
        await new Promise((resolve) => setTimeout(resolve, waitMs));
        continue;
      }

      throw lastError;
    }
  }

  throw lastError;
}

/**
 * Parse Spotify URL or URI to extract type and ID
 * Supports:
 * - https://open.spotify.com/track/{id}
 * - https://open.spotify.com/playlist/{id}
 * - https://open.spotify.com/track/{id}?si={share_id}
 * - spotify:track:{id}
 * - spotify:playlist:{id}
 *
 * @param {string} input - URL or URI to parse
 * @returns {{ type: 'track'|'playlist'|null, id: string|null }}
 */
export function parseSpotifyUrl(input) {
  if (!input || typeof input !== 'string') {
    return { type: null, id: null };
  }

  const trimmed = input.trim();

  // Handle Spotify URI format (spotify:track:xxx, spotify:playlist:xxx, spotify:album:xxx)
  const uriMatch = trimmed.match(/^spotify:(track|playlist|album):([a-zA-Z0-9]+)$/);
  if (uriMatch) {
    return { type: uriMatch[1], id: uriMatch[2] };
  }

  // Handle URL format
  try {
    const url = new URL(trimmed);

    // Check if it's a Spotify URL
    if (!url.hostname.includes('spotify.com')) {
      return { type: null, id: null };
    }

    // Parse path: /track/{id}, /playlist/{id}, or /album/{id}
    const pathMatch = url.pathname.match(/^\/(track|playlist|album)\/([a-zA-Z0-9]+)/);
    if (pathMatch) {
      return { type: pathMatch[1], id: pathMatch[2] };
    }

    return { type: null, id: null };
  } catch {
    return { type: null, id: null };
  }
}

/**
 * Normalize a Spotify track to our standard format
 * @param {Object} track - Spotify track object
 * @returns {Object} Normalized track
 */
function normalizeTrack(track) {
  return {
    spotifyId: track.id,
    title: track.name,
    artists: track.artists?.map((a) => a.name) || [],
    durationMs: track.duration_ms,
    spotifyUrl: track.external_urls?.spotify || `https://open.spotify.com/track/${track.id}`
  };
}

/**
 * Get public album metadata
 * @param {string} albumId - Spotify album ID
 * @returns {Promise<{ name: string, images: Array, artists: string[], totalTracks: number }|null>}
 */
export async function getPublicAlbum(albumId) {
  const client = getClient();
  if (!client) {
    return null;
  }

  try {
    const album = await withRetry(() => client.albums.get(albumId));
    return {
      name: album.name,
      images: album.images || [],
      artists: album.artists?.map((a) => a.name) || [],
      totalTracks: album.total_tracks
    };
  } catch (error) {
    logger.error('Failed to get Spotify album:', error.message);
    return null;
  }
}

/**
 * Get public playlist metadata
 * @param {string} playlistId - Spotify playlist ID
 * @returns {Promise<{ name: string, owner: string, images: Array, totalTracks: number }|null>}
 */
export async function getPublicPlaylist(playlistId) {
  const client = getClient();
  if (!client) {
    return null;
  }

  try {
    const playlist = await withRetry(() =>
      client.playlists.getPlaylist(playlistId, undefined, 'name,owner,images,tracks.total')
    );

    return {
      name: playlist.name,
      owner: playlist.owner?.display_name || playlist.owner?.id || 'Unknown',
      images: playlist.images || [],
      totalTracks: playlist.tracks?.total || 0
    };
  } catch (error) {
    logger.error('Failed to get Spotify playlist:', error.message);
    return null;
  }
}

// Upper bound on how many tracks we import from a single Spotify playlist.
// Huge playlists would otherwise flood the queue and the background resolver;
// this mirrors the 50-track cap on YouTube playlist imports.
export const MAX_PLAYLIST_TRACKS = 500;

// Spotify's album endpoint only embeds the first 50 tracks. Albums with more
// than 50 tracks are rare, but we surface the cap the same way as playlists.
export const MAX_ALBUM_TRACKS = 50;

/**
 * @typedef {Object} SpotifyTrackResult
 * @property {Array} tracks - Normalized tracks actually imported (at most the cap).
 * @property {number} total - True number of tracks the source contains.
 * @property {boolean} truncated - Whether the source was larger than the cap and
 *   was therefore truncated.
 */

/**
 * Get tracks from a public playlist with pagination, capped at
 * MAX_PLAYLIST_TRACKS. When a playlist is larger than the cap, only the first
 * MAX_PLAYLIST_TRACKS are returned, the truncation is logged, and the result
 * reports the true total so callers can tell the user.
 * @param {string} playlistId - Spotify playlist ID
 * @returns {Promise<SpotifyTrackResult>}
 */
export async function getPublicPlaylistTracks(playlistId) {
  const client = getClient();
  if (!client) {
    return { tracks: [], total: 0, truncated: false };
  }

  const tracks = [];
  let offset = 0;
  const limit = 100;
  let capReached = false;
  let total = 0;

  try {
    while (true) {
      const response = await withRetry(() =>
        client.playlists.getPlaylistItems(
          playlistId,
          undefined,
          'items(track(id,name,artists,duration_ms,external_urls,is_local)),next,total',
          limit,
          offset
        )
      );

      // `total` is the playlist's full item count and is constant across pages.
      total = response.total ?? total;

      for (const item of response.items) {
        // Skip null tracks and local files
        if (!item.track || item.track.is_local) {
          continue;
        }

        tracks.push(normalizeTrack(item.track));

        // Stop collecting once the cap is reached.
        if (tracks.length >= MAX_PLAYLIST_TRACKS) {
          capReached = true;
          break;
        }
      }

      // Stop once the cap is hit or there are no more pages.
      if (capReached || !response.next) {
        break;
      }

      offset += limit;
    }

    // Only flag truncation when the cap was hit AND there were genuinely more
    // tracks than we imported (avoids a false positive on an exactly-cap-sized
    // playlist).
    if (total < tracks.length) {
      total = tracks.length;
    }
    const truncated = capReached && total > tracks.length;

    if (truncated) {
      logger.warn(
        `Spotify playlist has ${total} tracks; importing only the first ${MAX_PLAYLIST_TRACKS}.`
      );
    }

    return { tracks, total, truncated };
  } catch (error) {
    logger.error('Failed to get Spotify playlist tracks:', error.message);
    return { tracks: [], total: 0, truncated: false };
  }
}

/**
 * Get tracks from a public album. Spotify embeds up to MAX_ALBUM_TRACKS tracks;
 * larger albums are truncated and the result reports the true total.
 * @param {string} albumId - Spotify album ID
 * @returns {Promise<SpotifyTrackResult>}
 */
export async function getPublicAlbumTracks(albumId) {
  const client = getClient();
  if (!client) {
    return { tracks: [], total: 0, truncated: false };
  }

  try {
    // Get album with tracks (API returns up to MAX_ALBUM_TRACKS tracks embedded)
    const response = await withRetry(() => client.albums.get(albumId));

    const tracks = response.tracks.items.map((track) => ({
      spotifyId: track.id,
      title: track.name,
      artists: track.artists?.map((a) => a.name) || [],
      durationMs: track.duration_ms,
      spotifyUrl: track.external_urls?.spotify || `https://open.spotify.com/track/${track.id}`
    }));

    const total = response.total_tracks ?? tracks.length;
    const truncated = total > tracks.length;

    if (truncated) {
      logger.warn(
        `Spotify album has ${total} tracks; importing only the first ${MAX_ALBUM_TRACKS}.`
      );
    }

    return { tracks, total, truncated };
  } catch (error) {
    logger.error('Failed to get Spotify album tracks:', error.message);
    return { tracks: [], total: 0, truncated: false };
  }
}

/**
 * Get a single track by ID
 * @param {string} trackId - Spotify track ID
 * @returns {Promise<Object|null>} Normalized track or null
 */
export async function getPublicTrack(trackId) {
  const client = getClient();
  if (!client) {
    return null;
  }

  try {
    const track = await withRetry(() => client.tracks.get(trackId));
    return normalizeTrack(track);
  } catch (error) {
    logger.error('Failed to get Spotify track:', error.message);
    return null;
  }
}

/**
 * Check if Spotify integration is available
 * @returns {boolean}
 */
export function isSpotifyConfigured() {
  return !!(process.env.SPOTIFY_CLIENT_ID && process.env.SPOTIFY_CLIENT_SECRET);
}
