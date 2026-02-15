import {
  MusicNote,
  Queue,
  History,
  Settings,
  Speaker,
  Leave,
} from '../icons/index.jsx';

/**
 * Sidebar component with navigation only
 * Volume and Loop controls have been moved to the bottom dock (MiniPlayer)
 *
 * Wireframe:
 * ┌────────────────────┐
 * │ MusicNote Music Bot│
 * ├────────────────────┤
 * │ * Now Playing      │
 * │   Queue            │
 * │   History          │
 * │   Settings         │
 * ├────────────────────┤
 * │ Voice Channel      │
 * │ # Music Lounge     │
 * │ [Leave Channel]    │
 * └────────────────────┘
 */

const navItems = [
  { id: 'nowplaying', label: 'Now Playing', icon: MusicNote },
  { id: 'queue', label: 'Queue', icon: Queue },
  { id: 'history', label: 'History', icon: History },
  { id: 'settings', label: 'Settings', icon: Settings },
];

export function Sidebar({
  activeView = 'nowplaying',
  onViewChange,
  voiceContext,
  onLeaveChannel,
  bottomPadding = 0,
}) {
  return (
    <aside
      className="w-60 flex flex-col flex-shrink-0 border-r h-full"
      style={{
        backgroundColor: 'var(--color-bg)',
        borderColor: 'var(--color-border)',
        paddingBottom: bottomPadding ? `${bottomPadding}px` : undefined,
      }}
    >
      {/* Logo section */}
      <div className="p-4 border-b" style={{ borderColor: 'var(--color-border)' }}>
        <div className="flex items-center gap-3">
          <div className="p-2.5 rounded-xl bg-accent/20">
            <MusicNote size={26} className="text-accent" />
          </div>
          <span className="text-lg font-bold tracking-tight" style={{ color: 'var(--color-text-primary)', fontFamily: 'var(--font-heading)' }}>
            Music Bot
          </span>
        </div>
      </div>

      {/* Navigation */}
      <nav className="flex-1 p-3">
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

      {/* Voice channel section */}
      {voiceContext?.channelName && (
        <div className="p-4 border-t mt-auto" style={{ borderColor: 'var(--color-border)' }}>
          <div
            className="text-xs font-semibold uppercase tracking-wider mb-3"
            style={{ color: 'var(--color-text-muted)', letterSpacing: '0.1em' }}
          >
            Voice Channel
          </div>
          <div className="flex items-center gap-2.5 mb-3 px-2 py-2 rounded-lg bg-surface-elevated/50" style={{ color: 'var(--color-text-secondary)' }}>
            <div className="w-2 h-2 rounded-full bg-accent animate-pulse" />
            <Speaker size={16} className="text-accent/70" />
            <span className="text-sm truncate font-medium">{voiceContext.channelName}</span>
          </div>
          <button
            onClick={onLeaveChannel}
            className="w-full flex items-center justify-center gap-2 px-3 py-2.5 rounded-lg text-sm font-medium text-red-400 hover:text-red-300 hover:bg-red-500/10 transition-all duration-200 border border-transparent hover:border-red-500/20"
          >
            <Leave size={16} />
            Leave Channel
          </button>
        </div>
      )}
    </aside>
  );
}
