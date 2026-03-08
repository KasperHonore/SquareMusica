import { useEffect, useState, useCallback } from 'react';
import { useSocket } from '../hooks/useSocket';
import { useBrowserMeta } from '../hooks/useBrowserMeta';
import { useAuth } from '../context/AuthContext';
import { AppLayout } from '../components/layout/AppLayout';
import { MiniPlayer } from '../components/layout/MiniPlayer';
import { RightPanel } from '../components/right/RightPanel';
import { CenterPanel } from '../components/center/CenterPanel';

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
    clearError,
    historyVersion
  } = useSocket();

  useBrowserMeta(botInfo, currentTrack);

  const [activeView, setActiveView] = useState('browse');
  const [selectedPlaylist, setSelectedPlaylist] = useState(null);

  const handleSelectPlaylist = useCallback((album) => {
    setSelectedPlaylist(album);
    setActiveView('playlists');
  }, []);

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
  const handleLoadAlbum = useCallback(async (album) => {
    if (!album.spotifyUrl) {
      if (album.tracks && album.tracks.length > 0) {
        album.tracks.forEach(track => {
          if (track.url) {
            addToQueue(track.url);
          }
        });
      }
      return;
    }

    playerControl('stop');
    await new Promise(resolve => setTimeout(resolve, 100));
    addToQueue(album.spotifyUrl);
  }, [addToQueue, playerControl]);

  const handleDeleteAlbum = useCallback((albumId) => {
    deletePlaylist(albumId);
  }, [deletePlaylist]);

  const handleCreateAlbum = useCallback((name, spotifyUrl, coverImage) => {
    createPlaylist(name, spotifyUrl, coverImage);
  }, [createPlaylist]);

  // Right panel: Now Playing + Controls + Queue
  const rightPanel = (
    <RightPanel
      currentTrack={currentTrack}
      playerState={playerState}
      onControl={playerControl}
      queue={upcomingTracks}
      onReorder={handleReorder}
      onRemove={handleRemove}
      onShuffle={handleShuffle}
      onClear={handleClearQueue}
      resolutionStats={resolutionStats}
    />
  );

  return (
    <>
      {/* Error Toast - Wave styling */}
      {error && (
        <div
          style={{
            position: 'fixed',
            top: '16px',
            right: '16px',
            zIndex: 100,
            background: 'var(--color-bg-surface3)',
            border: '1px solid var(--color-border-strong)',
            borderRadius: '8px',
            padding: '10px 16px',
            fontSize: '13px',
            color: 'var(--color-danger)',
            display: 'flex',
            alignItems: 'center',
            gap: '12px',
            animation: 'toastIn 0.2s ease',
          }}
        >
          <span>{error}</span>
          <button
            onClick={clearError}
            style={{
              background: 'none',
              border: 'none',
              color: 'var(--color-danger)',
              cursor: 'pointer',
              fontSize: '18px',
              lineHeight: 1,
              padding: '0 2px',
            }}
          >
            &times;
          </button>
        </div>
      )}

      <AppLayout
        rightPanel={rightPanel}
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
        botInfo={botInfo}
        albums={albums}
        onLoadAlbum={handleLoadAlbum}
        onDeleteAlbum={handleDeleteAlbum}
        onCreateAlbum={handleCreateAlbum}
        onAddToQueue={addToQueue}
        onSelectPlaylist={handleSelectPlaylist}
      >
        <CenterPanel
          activeView={activeView}
          onViewChange={setActiveView}
          onAdd={addToQueue}
          user={user}
          playerState={playerState}
          albums={albums}
          onCreateAlbum={handleCreateAlbum}
          onLoadAlbum={handleLoadAlbum}
          historyVersion={historyVersion}
          selectedPlaylist={selectedPlaylist}
          onSelectPlaylist={handleSelectPlaylist}
          onAddToQueue={addToQueue}
          onClearSelectedPlaylist={() => setSelectedPlaylist(null)}
        />
      </AppLayout>

      {/* MiniPlayer - Bottom bar transport strip */}
      <MiniPlayer
        currentTrack={currentTrack}
        playerState={playerState}
        onControl={playerControl}
        voiceContext={voiceContext}
        onJoinChannel={handleJoinChannel}
        onLeaveChannel={handleLeaveChannel}
      />

      <style>{`
        @keyframes toastIn {
          from { opacity: 0; transform: translateY(6px); }
          to { opacity: 1; transform: none; }
        }
      `}</style>
    </>
  );
}
