import { search, getInfo, isValidUrl, isPlaylist, getPlaylist } from '../integrations/youtube.js';
import {
  parseSpotifyUrl,
  getPublicTrack,
  getPublicPlaylistTracks,
  getPublicAlbumTracks,
  MAX_PLAYLIST_TRACKS,
  MAX_ALBUM_TRACKS
} from '../integrations/spotify.js';
import { ResolutionManager } from './resolutionManager.js';
import { logger } from '../utils/logger.js';

/**
 * Parse a query string and return tracks.
 * All Spotify types use lazy resolution (unresolved tracks resolved in background).
 *
 * @param {string} query - URL or search string
 * @param {{ username: string, id: string|null, avatar: string|null }} userInfo - Requesting user
 * @returns {Promise<{ tracks: Object[], error: string|null, truncation: { total: number, returned: number, cap: number }|null }>}
 */
export async function resolveQuery(query, userInfo) {
  const spotifyParsed = parseSpotifyUrl(query);

  if (spotifyParsed.type === 'playlist') {
    const {
      tracks: spotifyTracks,
      total,
      truncated
    } = await getPublicPlaylistTracks(spotifyParsed.id);
    if (spotifyTracks.length === 0) {
      return { tracks: [], error: 'SPOTIFY_PLAYLIST_EMPTY', truncation: null };
    }
    const tracks = spotifyTracks.map((st) => ResolutionManager.createUnresolvedTrack(st, userInfo));
    const truncation = truncated
      ? { total, returned: tracks.length, cap: MAX_PLAYLIST_TRACKS }
      : null;
    return { tracks, error: null, truncation };
  }

  if (spotifyParsed.type === 'track') {
    const spotifyTrack = await getPublicTrack(spotifyParsed.id);
    if (!spotifyTrack) {
      return { tracks: [], error: 'SPOTIFY_TRACK_NOT_FOUND', truncation: null };
    }
    const tracks = [ResolutionManager.createUnresolvedTrack(spotifyTrack, userInfo)];
    return { tracks, error: null, truncation: null };
  }

  if (spotifyParsed.type === 'album') {
    const { tracks: albumTracks, total, truncated } = await getPublicAlbumTracks(spotifyParsed.id);
    if (albumTracks.length === 0) {
      return { tracks: [], error: 'SPOTIFY_ALBUM_EMPTY', truncation: null };
    }
    const tracks = albumTracks.map((st) => ResolutionManager.createUnresolvedTrack(st, userInfo));
    const truncation = truncated ? { total, returned: tracks.length, cap: MAX_ALBUM_TRACKS } : null;
    return { tracks, error: null, truncation };
  }

  if (isPlaylist(query)) {
    const tracks = await getPlaylist(query);
    if (tracks.length === 0) {
      return { tracks: [], error: 'PLAYLIST_EMPTY', truncation: null };
    }
    return { tracks, error: null, truncation: null };
  }

  if (isValidUrl(query)) {
    const track = await getInfo(query);
    if (!track) {
      return { tracks: [], error: 'VIDEO_NOT_FOUND', truncation: null };
    }
    return { tracks: [track], error: null, truncation: null };
  }

  // Search YouTube
  const results = await search(query, 1);
  if (results.length === 0) {
    return { tracks: [], error: 'NO_RESULTS', truncation: null };
  }
  return { tracks: [results[0]], error: null, truncation: null };
}

/**
 * Add user info fields to tracks.
 * @param {Object[]} tracks - Array of track objects
 * @param {{ username: string, id: string|null, avatar: string|null }} userInfo
 * @returns {Object[]} New array with user info added
 */
export function enrichWithUserInfo(tracks, userInfo) {
  return tracks.map((track) => ({
    ...track,
    requestedBy: userInfo.username,
    requestedById: userInfo.id,
    requestedByAvatar: userInfo.avatar
  }));
}

/**
 * Start lookahead resolution if there are unresolved tracks.
 * @param {Object[]} tracks - Recently added tracks
 * @param {Object} resMgr - ResolutionManager instance
 * @param {Object} queue - Queue instance
 * @param {number} currentIndex - Current playback index
 */
export function triggerLookaheadIfNeeded(tracks, resMgr, queue, currentIndex) {
  const hasUnresolved = tracks.some((t) => t.status === 'unresolved');
  if (hasUnresolved && queue) {
    resMgr.setQueue(queue);
    resMgr.start();
    resMgr.processLookahead(currentIndex).catch((err) => {
      logger.error('Lookahead resolution error:', err);
    });
  }
  return hasUnresolved;
}

/**
 * Try to play the current track; on failure, advance through the queue
 * until a track plays successfully or the queue is exhausted.
 *
 * @param {Object} player - MusicPlayer instance
 * @param {Object} queue - Queue instance
 * @param {Object} connection - Voice connection
 * @returns {Promise<{ played: boolean, track: Object|null }>}
 */
export async function tryPlayWithFallback(player, queue, connection, skipCurrent = false) {
  if (!connection) return { played: false, track: null };

  let track = skipCurrent ? queue.next() : queue.getCurrent();
  while (track) {
    const success = await player.play(track, connection);
    if (success) {
      return { played: true, track };
    }
    track = queue.next();
  }

  return { played: false, track: null };
}
