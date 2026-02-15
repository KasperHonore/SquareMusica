import { SpotifyApi } from '@spotify/web-api-ts-sdk';

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
    console.warn('Spotify credentials not configured - Spotify features disabled');
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
        const retryAfter = error.headers?.get?.('retry-after') ||
                          error.retryAfter ||
                          Math.pow(2, attempt + 1);
        const waitMs = (parseInt(retryAfter, 10) || Math.pow(2, attempt + 1)) * 1000;

        console.warn(`Spotify rate limited, waiting ${waitMs}ms before retry ${attempt + 1}/${maxRetries}`);
        await new Promise(resolve => setTimeout(resolve, waitMs));
        continue;
      }

      // For other errors, use exponential backoff
      if (attempt < maxRetries - 1) {
        const waitMs = Math.pow(2, attempt + 1) * 1000;
        console.warn(`Spotify API error, retrying in ${waitMs}ms: ${error.message}`);
        await new Promise(resolve => setTimeout(resolve, waitMs));
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

  // Handle Spotify URI format (spotify:track:xxx, spotify:playlist:xxx)
  const uriMatch = trimmed.match(/^spotify:(track|playlist):([a-zA-Z0-9]+)$/);
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

    // Parse path: /track/{id} or /playlist/{id}
    const pathMatch = url.pathname.match(/^\/(track|playlist)\/([a-zA-Z0-9]+)/);
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
    artists: track.artists?.map(a => a.name) || [],
    durationMs: track.duration_ms,
    spotifyUrl: track.external_urls?.spotify || `https://open.spotify.com/track/${track.id}`
  };
}

/**
 * Get public playlist metadata
 * @param {string} playlistId - Spotify playlist ID
 * @returns {Promise<{ name: string, owner: string, images: Array }|null>}
 */
export async function getPublicPlaylist(playlistId) {
  const client = getClient();
  if (!client) {
    return null;
  }

  try {
    const playlist = await withRetry(() =>
      client.playlists.getPlaylist(playlistId, undefined, 'name,owner,images')
    );

    return {
      name: playlist.name,
      owner: playlist.owner?.display_name || playlist.owner?.id || 'Unknown',
      images: playlist.images || []
    };
  } catch (error) {
    console.error('Failed to get Spotify playlist:', error.message);
    return null;
  }
}

/**
 * Get all tracks from a public playlist with pagination
 * @param {string} playlistId - Spotify playlist ID
 * @returns {Promise<Array>} Array of normalized tracks
 */
export async function getPublicPlaylistTracks(playlistId) {
  const client = getClient();
  if (!client) {
    return [];
  }

  const tracks = [];
  let offset = 0;
  const limit = 100;

  try {
    while (true) {
      const response = await withRetry(() =>
        client.playlists.getPlaylistItems(
          playlistId,
          undefined,
          'items(track(id,name,artists,duration_ms,external_urls,is_local)),next',
          limit,
          offset
        )
      );

      for (const item of response.items) {
        // Skip null tracks and local files
        if (!item.track || item.track.is_local) {
          continue;
        }

        tracks.push(normalizeTrack(item.track));
      }

      // Check if there are more pages
      if (!response.next) {
        break;
      }

      offset += limit;
    }

    return tracks;
  } catch (error) {
    console.error('Failed to get Spotify playlist tracks:', error.message);
    return [];
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
    console.error('Failed to get Spotify track:', error.message);
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
