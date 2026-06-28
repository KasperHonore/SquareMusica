import { useEffect, useState, useCallback } from 'react';
import { useSocketContext } from '../context/SocketContext';
import { useBrowserMeta } from '../hooks/useBrowserMeta';
import { AppLayout } from '../components/layout/AppLayout';
import { MiniPlayer } from '../components/layout/MiniPlayer';
import { RightPanel } from '../components/right/RightPanel';
import { CenterPanel } from '../components/center/CenterPanel';

export function Dashboard() {
  const { currentTrack, botInfo, error, clearError, notice, clearNotice, status } =
    useSocketContext();

  useBrowserMeta(botInfo, currentTrack);

  const [activeView, setActiveView] = useState('browse');
  const [selectedPlaylist, setSelectedPlaylist] = useState(null);

  const handleSelectPlaylist = useCallback((album) => {
    setSelectedPlaylist(album);
    setActiveView('playlists');
  }, []);

  // Auto-dismiss error after 5 seconds
  useEffect(() => {
    if (error) {
      const timer = setTimeout(() => clearError(), 5000);
      return () => clearTimeout(timer);
    }
  }, [error, clearError]);

  // Auto-dismiss notice after 5 seconds
  useEffect(() => {
    if (notice) {
      const timer = setTimeout(() => clearNotice(), 5000);
      return () => clearTimeout(timer);
    }
  }, [notice, clearNotice]);

  const isReconnecting = status === 'reconnecting' || status === 'disconnected';

  return (
    <>
      {/* Reconnecting indicator — socket dropped, data may be stale */}
      {isReconnecting && (
        <div
          style={{
            position: 'fixed',
            top: '16px',
            left: '50%',
            transform: 'translateX(-50%)',
            zIndex: 100,
            background: 'var(--color-bg-surface3)',
            border: '1px solid var(--color-border-strong)',
            borderRadius: '8px',
            padding: '8px 14px',
            fontSize: '12px',
            color: 'var(--color-text-secondary)',
            display: 'flex',
            alignItems: 'center',
            gap: '8px'
          }}
          role="status"
          aria-live="polite"
        >
          <span
            className="animate-pulse"
            style={{
              width: '7px',
              height: '7px',
              borderRadius: '50%',
              backgroundColor: 'var(--color-accent)',
              flexShrink: 0
            }}
          />
          Reconnecting&hellip;
        </div>
      )}

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
            animation: 'toastIn 0.2s ease'
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
              padding: '0 2px'
            }}
          >
            &times;
          </button>
        </div>
      )}

      {/* Notice Toast - neutral informational message (e.g. playlist capped) */}
      {notice && (
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
            color: 'var(--color-text-secondary)',
            display: 'flex',
            alignItems: 'center',
            gap: '12px',
            animation: 'toastIn 0.2s ease'
          }}
        >
          <span>{notice}</span>
          <button
            onClick={clearNotice}
            style={{
              background: 'none',
              border: 'none',
              color: 'var(--color-text-secondary)',
              cursor: 'pointer',
              fontSize: '18px',
              lineHeight: 1,
              padding: '0 2px'
            }}
          >
            &times;
          </button>
        </div>
      )}

      <AppLayout
        rightPanel={<RightPanel />}
        activeView={activeView}
        onViewChange={setActiveView}
        onSelectPlaylist={handleSelectPlaylist}
      >
        <CenterPanel
          activeView={activeView}
          onViewChange={setActiveView}
          selectedPlaylist={selectedPlaylist}
          onSelectPlaylist={handleSelectPlaylist}
          onClearSelectedPlaylist={() => setSelectedPlaylist(null)}
        />
      </AppLayout>

      {/* MiniPlayer - Bottom bar transport strip */}
      <MiniPlayer />

      <style>{`
        @keyframes toastIn {
          from { opacity: 0; transform: translateY(6px); }
          to { opacity: 1; transform: none; }
        }
      `}</style>
    </>
  );
}
