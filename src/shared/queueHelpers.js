import { enrichWithUserInfo, triggerLookaheadIfNeeded } from '../services/trackResolver.js';

// Upper bound on a user-supplied search/URL query. Anything longer is rejected
// before it reaches yt-dlp, since legitimate queries and URLs are well under this.
export const MAX_QUERY_LENGTH = 500;

const RESOLVE_QUERY_ERROR_MESSAGES = {
  SPOTIFY_PLAYLIST_EMPTY: 'Spotify playlist not found or empty',
  SPOTIFY_TRACK_NOT_FOUND: 'Spotify track not found',
  SPOTIFY_ALBUM_EMPTY: 'Spotify album not found or empty',
  PLAYLIST_EMPTY: 'Playlist not found or empty',
  VIDEO_NOT_FOUND: 'Video not found',
  NO_RESULTS: 'No results found'
};

export function resolveQueryErrorToMessage(errorCode, fallback = 'Failed to process query') {
  return RESOLVE_QUERY_ERROR_MESSAGES[errorCode] || fallback;
}

/**
 * Build a user-facing notice when a Spotify source was truncated at the cap.
 * @param {{ total: number, returned: number, cap: number }|null} truncation
 * @returns {string|null} Message, or null when nothing was truncated.
 */
export function formatTruncationNotice(truncation) {
  if (!truncation) {
    return null;
  }
  return `Added ${truncation.returned} of ${truncation.total} tracks (playlist capped at ${truncation.cap}).`;
}

export function ensureVoiceConnected({ guildId, isConnected, onNotConnected }) {
  if (!isConnected(guildId)) {
    onNotConnected?.();
    return false;
  }
  return true;
}

export function addTracksToQueue({
  musicManager,
  resolutionManager,
  queue,
  currentIndex,
  rawTracks,
  userInfo
}) {
  const tracks = enrichWithUserInfo(rawTracks, userInfo);
  tracks.forEach((track) => musicManager.addToQueue(track));

  const lazyResolution = triggerLookaheadIfNeeded(tracks, resolutionManager, queue, currentIndex);

  return { tracks, lazyResolution };
}
