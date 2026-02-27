import { useEffect, useState, useCallback } from 'react';
import { useSocket } from '../hooks/useSocket';
import { useBrowserMeta } from '../hooks/useBrowserMeta';
import { useAuth } from '../context/AuthContext';
import { AppLayout } from '../components/layout/AppLayout';
import { MiniPlayer } from '../components/layout/MiniPlayer';
import { NowPlaying } from '../components/NowPlaying';
import { Queue } from '../components/Queue';
import { History } from './History';

export function Dashboard() {
  const { user, logout } = useAuth();
  const {
    connected,
    queue,
    currentIndex,
    currentTrack,
    playerState,
    resolutionStats,
    voiceContext,
    botInfo,
    playlists,
    error,
    addToQueue,
    removeFromQueue,
    reorderQueue,
    playerControl,
    voiceJoin,
    voiceLeave,
    createPlaylist,
    deletePlaylist,
    clearError
  } = useSocket();

  useBrowserMeta(botInfo, currentTrack);

  const [activeView, setActiveView] = useState('nowplaying');

  // Transform playlists from server format to component format (albums)
  const albums = playlists.map(p => ({
    id: p.id,
    name: p.name,
    spotifyUrl: p.spotify_url,
    coverImage: p.cover_image,
    createdBy: p.created_by,
    createdAt: p.created_at
  }));

  // Auto-dismiss error after 5 seconds
  useEffect(() => {
    if (error) {
      const timer = setTimeout(() => clearError(), 5000);
      return () => clearTimeout(timer);
    }
  }, [error, clearError]);

  // Filter queue to show only upcoming tracks (not the currently playing one)
  const upcomingTracks = currentTrack && currentIndex >= 0
    ? queue.slice(currentIndex + 1)
    : [];

  // Handlers that adjust indices to account for filtered display
  const handleReorder = (from, to) => {
    const offset = currentTrack ? currentIndex + 1 : 0;
    reorderQueue(offset + from, offset + to);
  };

  const handleRemove = (position) => {
    const offset = currentTrack ? currentIndex + 1 : 0;
    removeFromQueue(offset + position);
  };

  const handleShuffle = () => {
    playerControl('shuffle');
  };

  const handleClearQueue = () => {
    playerControl('clear');
  };

  const handleJoinChannel = () => {
    voiceJoin();
  };

  const handleLeaveChannel = () => {
    voiceLeave();
  };

  // Album handlers
  const handleLoadAlbum = useCallback((album) => {
    if (!album.spotifyUrl) {
      // Legacy support: if album has tracks array instead of spotifyUrl
      if (album.tracks && album.tracks.length > 0) {
        album.tracks.forEach(track => {
          if (track.url) {
            addToQueue(track.url);
          }
        });
      }
      return;
    }

    // Clear the current queue by stopping playback
    // playerControl('stop') calls musicManager.stop() which:
    // 1. Stops playback
    // 2. Clears the queue (queue.clear())
    // 3. Resets currentIndex to 0
    playerControl('stop');

    // Then add the Spotify URL (uses existing lazy resolution)
    addToQueue(album.spotifyUrl);
  }, [addToQueue, playerControl]);

  const handleDeleteAlbum = useCallback((albumId) => {
    deletePlaylist(albumId);
  }, [deletePlaylist]);

  const handleCreateAlbum = useCallback((name, spotifyUrl, coverImage) => {
    createPlaylist(name, spotifyUrl, coverImage);
  }, [createPlaylist]);

  // Render the main content based on active view
  const renderMainContent = () => {
    switch (activeView) {
      case 'nowplaying':
        return (
          <div className="h-full flex flex-col -mx-4 md:-mx-6 -mt-4 md:-mt-6">
            {/* Voice channel warning - positioned absolutely over the hero */}
            {!playerState.connected && (
              <div
                className="absolute top-4 left-1/2 -translate-x-1/2 z-20 max-w-lg px-4 py-3 rounded-lg"
                style={{
                  backgroundColor: 'rgba(234, 179, 8, 0.15)',
                  border: '1px solid rgba(234, 179, 8, 0.3)',
                  color: '#fcd34d',
                  backdropFilter: 'blur(8px)',
                }}
              >
                Bot is not connected to a voice channel. Use <code className="bg-black/20 px-1 rounded">/join</code> in Discord.
              </div>
            )}

            {/* Now Playing hero - anchored to top, full width */}
            <NowPlaying
              track={currentTrack}
              playerState={playerState}
            />
          </div>
        );

      case 'queue':
        return (
          <Queue
            tracks={upcomingTracks}
            onReorder={handleReorder}
            onRemove={handleRemove}
            onShuffle={handleShuffle}
            onClear={handleClearQueue}
            resolutionStats={resolutionStats}
          />
        );

      case 'history':
        return <History />;

      default:
        return null;
    }
  };

  // Queue component for sidebar panel - no extra wrapper needed
  const queuePanel = activeView !== 'queue' ? (
    <Queue
      tracks={upcomingTracks}
      onReorder={handleReorder}
      onRemove={handleRemove}
      onShuffle={handleShuffle}
      onClear={handleClearQueue}
      resolutionStats={resolutionStats}
    />
  ) : null;

  return (
    <>
      {/* Error Toast */}
      {error && (
        <div className="fixed top-4 right-4 z-[100] bg-red-600 text-white px-4 py-3 rounded-lg shadow-lg flex items-center gap-3 animate-slide-in">
          <span>{error}</span>
          <button
            onClick={clearError}
            className="text-white/80 hover:text-white text-xl leading-none"
          >
            &times;
          </button>
        </div>
      )}

      <AppLayout
        queueComponent={queuePanel}
        voiceContext={voiceContext}
        playerState={playerState}
        currentTrack={currentTrack}
        user={user}
        activeView={activeView}
        onViewChange={setActiveView}
        onJoinChannel={handleJoinChannel}
        onLeaveChannel={handleLeaveChannel}
        onLogout={logout}
        onAdd={addToQueue}
        connected={connected}
        showMiniPlayerPadding={!!currentTrack}
        botInfo={botInfo}
        albums={albums}
        onLoadAlbum={handleLoadAlbum}
        onDeleteAlbum={handleDeleteAlbum}
        onCreateAlbum={handleCreateAlbum}
      >
        {renderMainContent()}
      </AppLayout>

      {/* MiniPlayer - The ONLY playback control surface */}
      <MiniPlayer
        currentTrack={currentTrack}
        playerState={playerState}
        onControl={playerControl}
        activeView={activeView}
      />
    </>
  );
}
