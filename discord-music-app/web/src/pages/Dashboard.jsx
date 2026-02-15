import { useEffect, useState } from 'react';
import { useSocket } from '../hooks/useSocket';
import { useAuth } from '../context/AuthContext';
import { AppLayout } from '../components/layout/AppLayout';
import { MiniPlayer } from '../components/layout/MiniPlayer';
import { NowPlaying } from '../components/NowPlaying';
import { Queue } from '../components/Queue';
import { SearchBar } from '../components/SearchBar';
import { History } from './History';
import { Settings } from './Settings';

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
    error,
    addToQueue,
    removeFromQueue,
    reorderQueue,
    playerControl,
    clearError
  } = useSocket();

  const [activeView, setActiveView] = useState('nowplaying');

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

  const handleVolumeChange = (volume) => {
    playerControl('volume', volume);
  };

  const handleLoopChange = (mode) => {
    playerControl('loop', mode);
  };

  const handleLeaveChannel = () => {
    playerControl('leave');
  };

  // Render the main content based on active view
  const renderMainContent = () => {
    switch (activeView) {
      case 'nowplaying':
        return (
          <div className="space-y-6">
            {/* Search bar at top */}
            <SearchBar
              onAdd={addToQueue}
              disabled={!connected}
            />

            {/* Voice channel warning */}
            {!playerState.connected && (
              <div
                className="px-4 py-3 rounded-lg"
                style={{
                  backgroundColor: 'rgba(234, 179, 8, 0.1)',
                  border: '1px solid rgba(234, 179, 8, 0.3)',
                  color: '#fcd34d'
                }}
              >
                Bot is not connected to a voice channel. Use <code className="bg-black/20 px-1 rounded">/join</code> in Discord.
              </div>
            )}

            {/* Now Playing hero */}
            <NowPlaying
              track={currentTrack}
              playerState={playerState}
              onControl={playerControl}
            />
          </div>
        );

      case 'queue':
        return (
          <div className="max-w-2xl mx-auto">
            <h1 className="text-2xl font-bold mb-6">Queue</h1>
            <Queue
              tracks={upcomingTracks}
              onReorder={handleReorder}
              onRemove={handleRemove}
              onShuffle={handleShuffle}
              resolutionStats={resolutionStats}
            />
          </div>
        );

      case 'history':
        return <History />;

      case 'settings':
        return <Settings />;

      default:
        return null;
    }
  };

  // Queue component for sidebar panel
  const queuePanel = activeView !== 'queue' ? (
    <div className="p-4">
      <Queue
        tracks={upcomingTracks}
        onReorder={handleReorder}
        onRemove={handleRemove}
        onShuffle={handleShuffle}
        resolutionStats={resolutionStats}
      />
    </div>
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
        onVolumeChange={handleVolumeChange}
        onLoopChange={handleLoopChange}
        onLeaveChannel={handleLeaveChannel}
        onLogout={logout}
        showMiniPlayerPadding={!!currentTrack}
      >
        {renderMainContent()}
      </AppLayout>

      {/* MiniPlayer (fixed position) */}
      <MiniPlayer
        currentTrack={currentTrack}
        playerState={playerState}
        onControl={playerControl}
      />
    </>
  );
}
