import {
  MusicNote,
  Queue,
  History,
  Leave,
} from '../icons/index.jsx';
import { AlbumSection } from '../albums';

/**
 * Sidebar component with navigation and albums section
 * Volume and Loop controls have been moved to the bottom dock (MiniPlayer)
 *
 * Wireframe:
 * ┌────────────────────┐
 * │ MusicNote Music Bot│
 * ├────────────────────┤
 * │ * Now Playing      │
 * │   Queue            │
 * │   History          │
 * ├─ ─ ─ ─ ─ ─ ─ ─ ─ ─┤  ← Gradient divider
 * │ Your Albums    [+] │
 * │ ┌──────────────┐   │
 * │ │ Album 1      │   │
 * │ │ Album 2      │   │  ← Scrollable
 * │ └──────────────┘   │
 * ├────────────────────┤
 * │ [JOIN CHANNEL] or  │
 * │ [I'm in a channel] │
 * └────────────────────┘
 */

const navItems = [
  { id: 'nowplaying', label: 'Now Playing', icon: MusicNote },
  { id: 'queue', label: 'Queue', icon: Queue },
  { id: 'history', label: 'History', icon: History },
];

export function Sidebar({
  activeView = 'nowplaying',
  onViewChange,
  voiceContext,
  onJoinChannel,
  onLeaveChannel,
  botInfo,
  // Album props
  albums = [],
  onLoadAlbum,
  onDeleteAlbum,
  onCreateAlbum,
}) {
  const isConnected = !!voiceContext?.channelName;
  return (
    <aside
      className="w-60 flex flex-col flex-shrink-0 border-r h-full"
      style={{
        backgroundColor: 'var(--color-bg)',
        borderColor: 'var(--color-border)',
      }}
    >
      {/* Logo section */}
      <div className="p-4 border-b" style={{ borderColor: 'var(--color-border)' }}>
        <div className="flex items-center gap-3">
          {botInfo?.avatarUrl ? (
            <img
              src={botInfo.avatarUrl}
              alt={botInfo.name}
              className="w-10 h-10 rounded-xl"
            />
          ) : (
            <div className="p-2.5 rounded-xl bg-accent/20">
              <MusicNote size={26} className="text-accent" />
            </div>
          )}
          <span className="text-lg font-bold tracking-tight" style={{ color: 'var(--color-text-primary)', fontFamily: 'var(--font-heading)' }}>
            {botInfo?.name || 'Music Bot'}
          </span>
        </div>
      </div>

      {/* Navigation */}
      <nav className="p-3">
        <ul className="space-y-1">
          {navItems.map(({ id, label, icon: Icon }) => {
            const isActive = activeView === id;
            return (
              <li key={id}>
                <button
                  onClick={() => onViewChange?.(id)}
                  className="w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-all duration-200 group"
                  style={{
                    backgroundColor: isActive ? 'var(--color-bg-elevated)' : 'transparent',
                    color: isActive ? 'var(--color-text-primary)' : 'var(--color-text-secondary)'
                  }}
                >
                  <Icon
                    size={20}
                    className={`transition-colors duration-200 ${isActive ? 'text-accent' : 'group-hover:text-accent'}`}
                    style={{ color: isActive ? undefined : 'var(--color-text-secondary)' }}
                  />
                  <span className={isActive ? '' : 'group-hover:text-primary'}>
                    {label}
                  </span>
                  {isActive && (
                    <div className="ml-auto w-1 h-4 rounded-full bg-accent" />
                  )}
                </button>
              </li>
            );
          })}
        </ul>
      </nav>

      {/* Gradient divider */}
      <div className="mx-3 h-px bg-gradient-to-r from-transparent via-white/10 to-transparent" />

      {/* Albums section */}
      <div className="flex-1 min-h-0 py-2">
        <AlbumSection
          albums={albums}
          onLoadAlbum={onLoadAlbum}
          onDeleteAlbum={onDeleteAlbum}
          onCreateAlbum={onCreateAlbum}
        />
      </div>

      {/* Voice channel button */}
      <div className="p-4 border-t mt-auto" style={{ borderColor: 'var(--color-border)' }}>
        {isConnected ? (
          <button
            onClick={onLeaveChannel}
            className="w-full flex items-center justify-center gap-2 px-3 py-2.5 rounded-lg text-sm font-medium text-red-400 hover:text-red-300 hover:bg-red-500/10 transition-all duration-200 border border-red-500/30 hover:border-red-500/50"
          >
            <Leave size={16} />
            I'm in a channel
          </button>
        ) : (
          <button
            onClick={onJoinChannel}
            className="w-full flex items-center justify-center gap-2 px-3 py-2.5 rounded-lg text-sm font-semibold uppercase tracking-wider transition-all duration-200 bg-accent hover:bg-accent/90 text-white"
          >
            JOIN CHANNEL
          </button>
        )}
      </div>
    </aside>
  );
}
