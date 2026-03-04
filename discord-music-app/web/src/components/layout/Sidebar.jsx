import { AlbumSection } from '../albums';

/**
 * Sidebar — Wave design
 *
 * ┌────────────────────┐
 * │ wave.              │  ← Instrument Serif wordmark, gold dot
 * ├────────────────────┤
 * │ 🔍 Search          │
 * │ 🎵 Playlists       │  ← 3 nav items only
 * │ 🕐 History         │
 * ├────────────────────┤
 * │ MY PLAYLISTS       │
 * │ ┌──────────────┐   │
 * │ │ Compact list │   │  ← Scrollable pl-sidebar-items
 * │ └──────────────┘   │
 * ├────────────────────┤
 * │ 👤 User   [logout] │  ← Pinned to bottom
 * └────────────────────┘
 */

const NAV_ITEMS = [
  {
    id: 'search',
    label: 'Search',
    icon: (
      <svg width="15" height="15" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2">
        <circle cx="11" cy="11" r="8" />
        <path d="m21 21-4.35-4.35" />
      </svg>
    ),
  },
  {
    id: 'playlists',
    label: 'Playlists',
    icon: (
      <svg width="15" height="15" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2">
        <rect x="3" y="3" width="7" height="7" />
        <rect x="14" y="3" width="7" height="7" />
        <rect x="14" y="14" width="7" height="7" />
        <rect x="3" y="14" width="7" height="7" />
      </svg>
    ),
  },
  {
    id: 'history',
    label: 'History',
    icon: (
      <svg width="15" height="15" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2">
        <circle cx="12" cy="12" r="10" />
        <polyline points="12 6 12 12 16 14" />
      </svg>
    ),
  },
];

export function Sidebar({
  activeView = 'search',
  onViewChange,
  // Voice props passed through but NOT rendered here (moved to bottom bar)
  voiceContext,
  onJoinChannel,
  onLeaveChannel,
  onLogout,
  botInfo,
  user,
  // Album props
  albums = [],
  onLoadAlbum,
  onDeleteAlbum,
  onCreateAlbum,
  onAddToQueue,
}) {
  // Map old view IDs to new ones for backwards compat
  const resolvedView = activeView === 'nowplaying' ? 'search' : activeView === 'queue' ? 'playlists' : activeView;

  // Build Discord avatar URL
  const avatarUrl = user?.avatar && user?.discord_id
    ? `https://cdn.discordapp.com/avatars/${user.discord_id}/${user.avatar}.png?size=64`
    : null;

  const displayName = user?.global_name || user?.username || 'User';

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        height: '100%',
        padding: '24px 16px',
        gap: '24px',
        overflow: 'hidden',
        fontFamily: 'var(--font-body)',
      }}
    >
      {/* Bot identity */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: '10px',
          padding: '0 8px',
          flexShrink: 0,
        }}
      >
        {botInfo?.avatarUrl ? (
          <img
            src={botInfo.avatarUrl}
            alt={botInfo.name}
            style={{
              width: '28px',
              height: '28px',
              borderRadius: '50%',
              flexShrink: 0,
            }}
          />
        ) : (
          <div
            style={{
              width: '28px',
              height: '28px',
              borderRadius: '50%',
              backgroundColor: 'var(--color-bg-surface3)',
              flexShrink: 0,
            }}
          />
        )}
        <span
          style={{
            fontFamily: 'var(--font-heading)',
            fontSize: '20px',
            letterSpacing: '-0.3px',
            color: 'var(--color-text-primary)',
          }}
        >
          {botInfo?.name || 'wave'}
          <span style={{ color: 'var(--color-accent)' }}>.</span>
        </span>
      </div>

      {/* Navigation */}
      <nav style={{ display: 'flex', flexDirection: 'column', gap: '2px', flexShrink: 0 }}>
        {NAV_ITEMS.map(({ id, label, icon }) => {
          const isActive = resolvedView === id;
          return (
            <button
              key={id}
              onClick={() => onViewChange?.(id)}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: '10px',
                padding: '9px 10px',
                borderRadius: '8px',
                color: isActive ? 'var(--color-accent)' : 'var(--color-text-secondary)',
                backgroundColor: isActive ? 'var(--color-accent-muted)' : 'transparent',
                cursor: 'pointer',
                transition: 'all 0.12s',
                fontWeight: 400,
                fontSize: '14px',
                fontFamily: 'var(--font-body)',
                border: 'none',
                width: '100%',
                textAlign: 'left',
                userSelect: 'none',
              }}
              onMouseEnter={(e) => {
                if (!isActive) {
                  e.currentTarget.style.backgroundColor = 'var(--color-bg-elevated)';
                  e.currentTarget.style.color = 'var(--color-text-primary)';
                }
              }}
              onMouseLeave={(e) => {
                if (!isActive) {
                  e.currentTarget.style.backgroundColor = 'transparent';
                  e.currentTarget.style.color = 'var(--color-text-secondary)';
                }
              }}
            >
              <span style={{ flexShrink: 0, display: 'flex' }}>{icon}</span>
              {label}
            </button>
          );
        })}
      </nav>

      {/* Playlists section — fills remaining space */}
      <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
        <AlbumSection
          albums={albums}
          onLoadAlbum={onLoadAlbum}
          onDeleteAlbum={onDeleteAlbum}
          onCreateAlbum={onCreateAlbum}
          onAddToQueue={onAddToQueue}
        />
      </div>

      {/* User area — pinned to bottom */}
      <div
        style={{
          marginTop: 'auto',
          display: 'flex',
          alignItems: 'center',
          gap: '10px',
          padding: '10px',
          backgroundColor: 'var(--color-bg-elevated)',
          borderRadius: '10px',
          border: '1px solid var(--color-border)',
          flexShrink: 0,
        }}
      >
        {/* Avatar */}
        <div
          style={{
            width: '32px',
            height: '32px',
            borderRadius: '50%',
            flexShrink: 0,
            overflow: 'hidden',
            backgroundColor: 'var(--color-bg-surface3)',
          }}
        >
          {avatarUrl ? (
            <img
              src={avatarUrl}
              alt={displayName}
              style={{ width: '100%', height: '100%', objectFit: 'cover' }}
            />
          ) : (
            <div
              style={{
                width: '100%',
                height: '100%',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                color: 'var(--color-text-muted)',
                fontSize: '14px',
              }}
            >
              {displayName.charAt(0).toUpperCase()}
            </div>
          )}
        </div>

        {/* Display name */}
        <div
          style={{
            fontSize: '12px',
            fontWeight: 500,
            flex: 1,
            minWidth: 0,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
            color: 'var(--color-text-primary)',
          }}
        >
          {displayName}
        </div>

        {/* Logout button */}
        <button
          onClick={onLogout}
          title="Sign out"
          style={{
            background: 'none',
            border: 'none',
            color: 'var(--color-text-muted)',
            cursor: 'pointer',
            padding: '4px',
            borderRadius: '6px',
            transition: 'color 0.12s',
            display: 'flex',
            alignItems: 'center',
          }}
          onMouseEnter={(e) => { e.currentTarget.style.color = 'var(--color-danger)'; }}
          onMouseLeave={(e) => { e.currentTarget.style.color = 'var(--color-text-muted)'; }}
        >
          <svg width="14" height="14" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2">
            <path d="M9 21H5a2 2 0 01-2-2V5a2 2 0 012-2h4" />
            <polyline points="16 17 21 12 16 7" />
            <line x1="21" y1="12" x2="9" y2="12" />
          </svg>
        </button>
      </div>
    </div>
  );
}
