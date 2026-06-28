import { createContext, useContext, useMemo, useCallback } from 'react';
import { useSocket } from '../hooks/useSocket';

const SocketContext = createContext(null);

/**
 * SocketProvider — runs the useSocket() hook a single time and exposes its
 * value (plus a few derived helpers) to the whole tree. This removes the prop
 * chain that previously threaded socket state through AppLayout/Sidebar.
 *
 * Must live inside AuthProvider since useSocket() depends on useAuth().
 */
export function SocketProvider({ children }) {
  const socket = useSocket();
  const {
    playlists,
    queue,
    currentIndex,
    currentTrack,
    reorderQueue,
    removeFromQueue,
    addToQueue,
    playerControl
  } = socket;

  // Transform playlists from server format to component format (albums)
  const albums = useMemo(
    () =>
      playlists.map((p) => ({
        id: p.id,
        name: p.name,
        spotifyUrl: p.spotify_url,
        coverImage: p.cover_image,
        createdBy: p.created_by,
        createdAt: p.created_at
      })),
    [playlists]
  );

  // Filter queue to show only upcoming tracks (not the currently playing one)
  const upcomingTracks = useMemo(
    () => (currentTrack && currentIndex >= 0 ? queue.slice(currentIndex + 1) : []),
    [currentTrack, currentIndex, queue]
  );

  // Reorder/remove operate on the upcoming list, so adjust for the offset of
  // the currently playing track.
  const reorderUpcoming = useCallback(
    (from, to) => {
      const offset = currentTrack ? currentIndex + 1 : 0;
      reorderQueue(offset + from, offset + to);
    },
    [currentTrack, currentIndex, reorderQueue]
  );

  const removeUpcoming = useCallback(
    (position) => {
      const offset = currentTrack ? currentIndex + 1 : 0;
      removeFromQueue(offset + position);
    },
    [currentTrack, currentIndex, removeFromQueue]
  );

  // Load an album/playlist: queue its Spotify URL (or its individual tracks).
  const loadAlbum = useCallback(
    async (album) => {
      if (!album.spotifyUrl) {
        if (album.tracks && album.tracks.length > 0) {
          album.tracks.forEach((track) => {
            if (track.url) {
              addToQueue(track.url);
            }
          });
        }
        return;
      }

      playerControl('stop');
      await new Promise((resolve) => setTimeout(resolve, 100));
      addToQueue(album.spotifyUrl);
    },
    [addToQueue, playerControl]
  );

  const value = {
    ...socket,
    albums,
    upcomingTracks,
    reorderUpcoming,
    removeUpcoming,
    loadAlbum
  };

  return <SocketContext.Provider value={value}>{children}</SocketContext.Provider>;
}

export const useSocketContext = () => {
  const context = useContext(SocketContext);
  if (!context) {
    throw new Error('useSocketContext must be used within a SocketProvider');
  }
  return context;
};
