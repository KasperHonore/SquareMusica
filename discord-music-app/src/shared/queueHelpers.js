import { enrichWithUserInfo, triggerLookaheadIfNeeded, tryPlayWithFallback } from '../music/trackResolver.js';

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

export function ensureVoiceConnected({ guildId, isConnected, onNotConnected }) {
  if (!isConnected(guildId)) {
    onNotConnected?.();
    return false;
  }
  return true;
}

export function addTracksToQueue({ musicManager, resolutionManager, queue, currentIndex, rawTracks, userInfo }) {
  const tracks = enrichWithUserInfo(rawTracks, userInfo);
  tracks.forEach(track => musicManager.addToQueue(track));

  const lazyResolution = triggerLookaheadIfNeeded(
    tracks,
    resolutionManager,
    queue,
    currentIndex
  );

  return { tracks, lazyResolution };
}

export async function autoplayIfIdle({ player, queue, connection, skipCurrent = false }) {
  if (!player || !queue || !connection) return { played: false, track: null };
  if (player.isPlaying?.() || player.isPaused?.()) return { played: false, track: null };
  return await tryPlayWithFallback(player, queue, connection, skipCurrent);
}

