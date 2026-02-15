import { useEffect, useState } from 'react';
import { useSocket } from '../hooks/useSocket';
import { useAuth } from '../context/AuthContext';
import { AppLayout } from '../components/layout/AppLayout';
import { MiniPlayer } from '../components/layout/MiniPlayer';
import { NowPlaying } from '../components/NowPlaying';
import { Queue } from '../components/Queue';
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

  const handleLeaveChannel = () => {
    playerControl('leave');
  };

  // Render the main content based on active view
  const renderMainContent = () => {
    switch (activeView) {
      case 'nowplaying':
        return (
          <div className="h-full flex flex-col">
            {/* Voice channel warning */}
            {!playerState.connected && (
              <div
                className="mx-auto max-w-lg px-4 py-3 rounded-lg mb-4"
                style={{
                  backgroundColor: 'rgba(234, 179, 8, 0.1)',
                  border: '1px solid rgba(234, 179, 8, 0.3)',
                  color: '#fcd34d'
                }}
              >
                Bot is not connected to a voice channel. Use <code className="bg-black/20 px-1 rounded">/join</code> in Discord.
              </div>
            )}

            {/* Now Playing hero - purely informational, no controls */}
            <div className="flex-1 flex items-center justify-center">
              <NowPlaying
                track={currentTrack}
                playerState={playerState}
              />
            </div>
          </div>
        );

      case 'queue':
        return (
          <div className="max-w-2xl mx-auto">
            <h1 className="text-2xl font-bold mb-6" style={{ fontFamily: 'var(--font-heading)' }}>Queue</h1>
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
        onLeaveChannel={handleLeaveChannel}
        onLogout={logout}
        onAdd={addToQueue}
        connected={connected}
        showMiniPlayerPadding={!!currentTrack}
      >
        {renderMainContent()}
      </AppLayout>

      {/* MiniPlayer - The ONLY playback control surface */}
      <MiniPlayer
        currentTrack={currentTrack}
        playerState={playerState}
        onControl={playerControl}
      />
    </>
  );
}
