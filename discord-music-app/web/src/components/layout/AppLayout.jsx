import { useState } from 'react';
import { TopBar } from './TopBar';
import { Sidebar } from './Sidebar';
import { Queue as QueueIcon, MusicNote } from '../icons';

/**
 * Main application layout with 3-column Spotify-style grid
 *
 * Following UI-REWORK.md single-control-surface architecture:
 * - TopBar: Search + Server/User info
 * - Sidebar: Navigation + Voice channel controls only
 * - Center: Immersive Now Playing (no controls)
 * - Bottom Dock: ALL playback controls (handled by MiniPlayer)
 *
 * Responsive behavior:
 * - Desktop (≥1024px): Full 3-column layout
 * - Tablet (768-1023px): Collapsed sidebar (icons only), queue slide-out
 * - Mobile (<768px): No sidebar, queue slide-out, stacked layout
 */
export function AppLayout({
  children,
  queueComponent,
  voiceContext,
  playerState,
  currentTrack,
  user,
  activeView,
  onViewChange,
  onLeaveChannel,
  onLogout,
  onAdd,
  connected,
  showMiniPlayerPadding = false,
}) {
  const [queueOpen, setQueueOpen] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(false);

  return (
    <div
      className="h-screen flex flex-col overflow-hidden"
      style={{ backgroundColor: 'var(--color-bg)' }}
    >
      {/* TopBar with integrated search */}
      <div className="flex-shrink-0">
        <TopBar
          voiceContext={voiceContext}
          connected={connected}
          user={user}
          onLogout={onLogout}
          onAdd={onAdd}
          searchDisabled={!connected}
        />
      </div>

      {/* Main content area */}
      <div className="flex-1 flex overflow-hidden relative">
        {/* Mobile sidebar overlay */}
        {sidebarOpen && (
          <div
            className="fixed inset-0 bg-black/50 z-40 lg:hidden"
            onClick={() => setSidebarOpen(false)}
          />
        )}

        {/* Sidebar - hidden on mobile, collapsed on tablet, full on desktop */}
        <div
          className={`
            fixed lg:relative z-50 lg:z-auto
            transform transition-transform duration-300 ease-in-out
            ${sidebarOpen ? 'translate-x-0' : '-translate-x-full lg:translate-x-0'}
            h-full
          `}
        >
          <Sidebar
            activeView={activeView}
            onViewChange={(view) => {
              onViewChange?.(view);
              setSidebarOpen(false);
            }}
            voiceContext={voiceContext}
            onLeaveChannel={onLeaveChannel}
          />
        </div>

        {/* Main content */}
        <main
          className="flex-1 overflow-y-auto p-4 md:p-6"
          style={{ paddingBottom: showMiniPlayerPadding ? '96px' : '24px' }}
        >
          {/* Mobile header with menu and queue buttons */}
          <div className="flex items-center justify-between mb-4 lg:hidden">
            <button
              onClick={() => setSidebarOpen(true)}
              className="p-2 rounded-lg hover:bg-white/10 transition-colors"
              aria-label="Open menu"
            >
              <MusicNote size={24} className="text-accent" />
            </button>

            {queueComponent && (
              <button
                onClick={() => setQueueOpen(true)}
                className="p-2 rounded-lg hover:bg-white/10 transition-colors"
                aria-label="Open queue"
              >
                <QueueIcon size={24} className="text-gray-400" />
              </button>
            )}
          </div>

          {children}
        </main>

        {/* Queue panel - slide out on tablet/mobile */}
        {queueComponent && (
          <>
            {/* Desktop queue panel - fills height, has internal padding */}
            <aside
              className="hidden lg:flex lg:flex-col w-80 border-l flex-shrink-0"
              style={{
                backgroundColor: 'var(--color-bg-raised)',
                borderColor: 'var(--color-border)',
                paddingBottom: showMiniPlayerPadding ? '80px' : '0'
              }}
            >
              <div className="flex-1 p-4 overflow-hidden flex flex-col">
                {queueComponent}
              </div>
            </aside>

            {/* Mobile/Tablet queue overlay */}
            {queueOpen && (
              <div
                className="fixed inset-0 bg-black/50 z-40 lg:hidden"
                onClick={() => setQueueOpen(false)}
              />
            )}

            {/* Mobile/Tablet queue slide-out */}
            <aside
              className={`
                fixed right-0 top-0 h-full w-80 max-w-[85vw] z-50 lg:hidden
                transform transition-transform duration-300 ease-in-out flex flex-col
                ${queueOpen ? 'translate-x-0' : 'translate-x-full'}
              `}
              style={{
                backgroundColor: 'var(--color-bg-raised)',
                paddingBottom: showMiniPlayerPadding ? '80px' : '0'
              }}
            >
              <div className="flex-shrink-0 p-4 border-b flex items-center justify-between"
                style={{
                  backgroundColor: 'var(--color-bg-raised)',
                  borderColor: 'var(--color-border)'
                }}
              >
                <span className="font-semibold" style={{ fontFamily: 'var(--font-heading)' }}>Queue</span>
                <button
                  onClick={() => setQueueOpen(false)}
                  className="p-2 rounded-lg hover:bg-white/10 transition-colors"
                  aria-label="Close queue"
                >
                  <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                  </svg>
                </button>
              </div>
              <div className="flex-1 p-4 overflow-hidden flex flex-col">
                {queueComponent}
              </div>
            </aside>
          </>
        )}
      </div>
    </div>
  );
}
