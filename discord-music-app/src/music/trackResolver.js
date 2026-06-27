import { search, getInfo, isValidUrl, isPlaylist, getPlaylist } from './youtube.js';
import {
  parseSpotifyUrl,
  getPublicTrack,
  getPublicPlaylistTracks,
  getPublicAlbumTracks
} from './spotify.js';
import { ResolutionManager } from './resolutionManager.js';

/**
 * Parse a query string and return tracks.
 * All Spotify types use lazy resolution (unresolved tracks resolved in background).
 *
 * @param {string} query - URL or search string
 * @param {{ username: string, id: string|null, avatar: string|null }} userInfo - Requesting user
 * @returns {Promise<{ tracks: Object[], error: string|null }>}
 */
export async function resolveQuery(query, userInfo) {
  const spotifyParsed = parseSpotifyUrl(query);

  if (spotifyParsed.type === 'playlist') {
    const spotifyTracks = await getPublicPlaylistTracks(spotifyParsed.id);
    if (spotifyTracks.length === 0) {
      return { tracks: [], error: 'SPOTIFY_PLAYLIST_EMPTY' };
    }
    const tracks = spotifyTracks.map((st) => ResolutionManager.createUnresolvedTrack(st, userInfo));
    return { tracks, error: null };
  }

  if (spotifyParsed.type === 'track') {
    const spotifyTrack = await getPublicTrack(spotifyParsed.id);
    if (!spotifyTrack) {
      return { tracks: [], error: 'SPOTIFY_TRACK_NOT_FOUND' };
    }
    const tracks = [ResolutionManager.createUnresolvedTrack(spotifyTrack, userInfo)];
    return { tracks, error: null };
  }

  if (spotifyParsed.type === 'album') {
    const albumTracks = await getPublicAlbumTracks(spotifyParsed.id);
    if (albumTracks.length === 0) {
      return { tracks: [], error: 'SPOTIFY_ALBUM_EMPTY' };
    }
    const tracks = albumTracks.map((st) => ResolutionManager.createUnresolvedTrack(st, userInfo));
    return { tracks, error: null };
  }

  if (isPlaylist(query)) {
    const tracks = await getPlaylist(query);
    if (tracks.length === 0) {
      return { tracks: [], error: 'PLAYLIST_EMPTY' };
    }
    return { tracks, error: null };
  }

  if (isValidUrl(query)) {
    const track = await getInfo(query);
    if (!track) {
      return { tracks: [], error: 'VIDEO_NOT_FOUND' };
    }
    return { tracks: [track], error: null };
  }

  // Search YouTube
  const results = await search(query, 1);
  if (results.length === 0) {
    return { tracks: [], error: 'NO_RESULTS' };
  }
  return { tracks: [results[0]], error: null };
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
      console.error('Lookahead resolution error:', err);
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
