import { useEffect, useState, useCallback } from 'react';
import { useSocket } from '../hooks/useSocket';
import { useAuth } from '../context/AuthContext';
import { AppLayout } from '../components/layout/AppLayout';
import { MiniPlayer } from '../components/layout/MiniPlayer';
import { NowPlaying } from '../components/NowPlaying';
import { Queue } from '../components/Queue';
import { History } from './History';

// Storage key for albums persistence
const ALBUMS_STORAGE_KEY = 'music-bot-albums';

// Generate a simple UUID for album IDs
function generateId() {
  return 'album_' + Date.now().toString(36) + Math.random().toString(36).substr(2, 9);
}

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
    error,
    addToQueue,
    removeFromQueue,
    reorderQueue,
    playerControl,
    voiceJoin,
    voiceLeave,
    clearError
  } = useSocket();

  const [activeView, setActiveView] = useState('nowplaying');

  // Albums state with localStorage persistence
  const [albums, setAlbums] = useState(() => {
    try {
      const saved = localStorage.getItem(ALBUMS_STORAGE_KEY);
      return saved ? JSON.parse(saved) : [];
    } catch {
      return [];
    }
  });

  // Persist albums to localStorage when changed
  useEffect(() => {
    try {
      localStorage.setItem(ALBUMS_STORAGE_KEY, JSON.stringify(albums));
    } catch (e) {
      console.error('Failed to save albums to localStorage:', e);
    }
  }, [albums]);

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
    : queue;

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

  const handleJoinChannel = () => {
    voiceJoin();
  };

  const handleLeaveChannel = () => {
    voiceLeave();
  };

  // Album handlers
  const handleLoadAlbum = useCallback((album) => {
    if (!album.tracks || album.tracks.length === 0) {
      return;
    }
    // Add each track from the album to the queue
    album.tracks.forEach(track => {
      if (track.url) {
        addToQueue(track.url);
      }
    });
  }, [addToQueue]);

  const handleDeleteAlbum = useCallback((albumId) => {
    setAlbums(prev => prev.filter(album => album.id !== albumId));
  }, []);

  const handleCreateAlbum = useCallback((name, tracks) => {
    const newAlbum = {
      id: generateId(),
      name,
      createdAt: new Date().toISOString(),
      tracks: tracks.map(track => ({
        url: track.url,
        title: track.title,
        thumbnail: track.thumbnail,
        duration: track.duration,
      })),
    };
    setAlbums(prev => [...prev, newAlbum]);
  }, []);

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
        currentQueue={upcomingTracks}
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
