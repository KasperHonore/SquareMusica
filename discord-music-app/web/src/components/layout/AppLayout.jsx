import { useState } from 'react';
import { Sidebar } from './Sidebar';
import { MusicNote } from '../icons';

/**
 * Main application layout - Wave design CSS Grid
 *
 * Grid structure:
 * ┌──────────┬─────────────────┬──────────┐
 * │ Sidebar  │   Center Panel  │  Right   │
 * │ (220px)  │     (1fr)       │  Panel   │
 * │          │                 │  (300px) │
 * ├──────────┴─────────────────┴──────────┤
 * │            Bottom Bar (72px)          │
 * └───────────────────────────────────────┘
 *
 * Responsive:
 * - Desktop (≥1024px): Full 3-column grid
 * - Tablet (768-1023px): Collapsed sidebar, right panel slide-out
 * - Mobile (<768px): No sidebar, right panel slide-out
 */
export function AppLayout({
  children,
  rightPanel,
  voiceContext,
  playerState,
  currentTrack,
  user,
  activeView,
  onViewChange,
  onJoinChannel,
  onLeaveChannel,
  onLogout,
  onAdd,
  connected,
  botInfo,
  // Album props
  albums = [],
  onLoadAlbum,
  onDeleteAlbum,
  onCreateAlbum,
  onAddToQueue,
}) {
  const [rightPanelOpen, setRightPanelOpen] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(false);

  return (
    <div
      className="h-screen overflow-hidden"
      style={{ backgroundColor: 'var(--color-bg)' }}
    >
      {/* CSS Grid layout */}
      <div className="h-full grid grid-rows-[1fr_72px] lg:grid-cols-[220px_1fr_300px] grid-cols-1">
        {/* Sidebar - hidden on mobile, visible on desktop */}
        <aside className="hidden lg:flex lg:flex-col row-start-1 row-end-2 border-r overflow-hidden"
          style={{
            backgroundColor: 'var(--color-bg-raised)',
            borderColor: 'var(--color-border)',
          }}
        >
          <Sidebar
            activeView={activeView}
            onViewChange={onViewChange}
            voiceContext={voiceContext}
            onJoinChannel={onJoinChannel}
            onLeaveChannel={onLeaveChannel}
            onLogout={onLogout}
            botInfo={botInfo}
            user={user}
            albums={albums}
            onLoadAlbum={onLoadAlbum}
            onDeleteAlbum={onDeleteAlbum}
            onCreateAlbum={onCreateAlbum}
            onAddToQueue={onAddToQueue}
          />
        </aside>

        {/* Center panel */}
        <main className="row-start-1 row-end-2 overflow-hidden flex flex-col min-w-0">
          {/* Mobile header with menu and right panel buttons */}
          <div className="flex items-center justify-between px-4 py-3 lg:hidden">
            <button
              onClick={() => setSidebarOpen(true)}
              className="p-2 rounded-lg hover:bg-white/10 transition-colors"
              aria-label="Open menu"
            >
              <svg width="20" height="20" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2">
                <path d="M3 12h18M3 6h18M3 18h18" />
              </svg>
            </button>

            <span className="font-heading text-lg" style={{ color: 'var(--color-text-primary)' }}>
              wave<span style={{ color: 'var(--color-accent)' }}>.</span>
            </span>

            {rightPanel && (
              <button
                onClick={() => setRightPanelOpen(true)}
                className="p-2 rounded-lg hover:bg-white/10 transition-colors"
                aria-label="Open now playing"
              >
                <MusicNote size={20} style={{ color: 'var(--color-accent)' }} />
              </button>
            )}
          </div>

          {children}
        </main>

        {/* Right panel - always visible on desktop */}
        {rightPanel && (
          <aside
            className="hidden lg:flex lg:flex-col row-start-1 row-end-2 border-l overflow-hidden"
            style={{
              backgroundColor: 'var(--color-bg-raised)',
              borderColor: 'var(--color-border)',
            }}
          >
            {rightPanel}
          </aside>
        )}

        {/* Bottom bar slot - spans all columns */}
        <div
          className="row-start-2 row-end-3 lg:col-span-3 border-t"
          style={{
            backgroundColor: 'var(--color-bg-raised)',
            borderColor: 'var(--color-border)',
          }}
          id="bottom-bar-slot"
        />
      </div>

      {/* Mobile sidebar overlay */}
      {sidebarOpen && (
        <div
          className="fixed inset-0 bg-black/50 z-40 lg:hidden"
          onClick={() => setSidebarOpen(false)}
        />
      )}

      {/* Mobile sidebar slide-out */}
      <div
        className={`
          fixed left-0 top-0 h-full w-[220px] z-50 lg:hidden
          transform transition-transform duration-300 ease-in-out
          ${sidebarOpen ? 'translate-x-0' : '-translate-x-full'}
        `}
        style={{ backgroundColor: 'var(--color-bg-raised)' }}
      >
        <Sidebar
          activeView={activeView}
          onViewChange={(view) => {
            onViewChange?.(view);
            setSidebarOpen(false);
          }}
          voiceContext={voiceContext}
          onJoinChannel={onJoinChannel}
          onLeaveChannel={onLeaveChannel}
          onLogout={onLogout}
          botInfo={botInfo}
          user={user}
          albums={albums}
          onLoadAlbum={onLoadAlbum}
          onDeleteAlbum={onDeleteAlbum}
          onCreateAlbum={onCreateAlbum}
          onAddToQueue={onAddToQueue}
        />
      </div>

      {/* Mobile right panel overlay */}
      {rightPanelOpen && (
        <div
          className="fixed inset-0 bg-black/50 z-40 lg:hidden"
          onClick={() => setRightPanelOpen(false)}
        />
      )}

      {/* Mobile right panel slide-out */}
      {rightPanel && (
        <div
          className={`
            fixed right-0 top-0 h-full w-[300px] max-w-[85vw] z-50 lg:hidden
            transform transition-transform duration-300 ease-in-out flex flex-col
            ${rightPanelOpen ? 'translate-x-0' : 'translate-x-full'}
          `}
          style={{ backgroundColor: 'var(--color-bg-raised)' }}
        >
          <div className="flex-shrink-0 p-4 border-b flex items-center justify-between"
            style={{ borderColor: 'var(--color-border)' }}
          >
            <span className="font-heading text-lg">Now Playing</span>
            <button
              onClick={() => setRightPanelOpen(false)}
              className="p-2 rounded-lg hover:bg-white/10 transition-colors"
              aria-label="Close panel"
            >
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>
          <div className="flex-1 overflow-hidden flex flex-col min-h-0">
            {rightPanel}
          </div>
        </div>
      )}
    </div>
  );
}
