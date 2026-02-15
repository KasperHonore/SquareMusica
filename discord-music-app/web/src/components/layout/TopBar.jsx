import { Speaker } from '../icons/index.jsx';

/**
 * TopBar component showing Discord session context
 *
 * Wireframe:
 * ┌─────────────────────────────────────────────────────────────────┐
 * │ [Icon] My Discord Server │ Speaker Music Lounge │ Connected │ [Avatar] │
 * └─────────────────────────────────────────────────────────────────┘
 */
export function TopBar({ voiceContext, connected, user, onLogout }) {
  const getAvatarUrl = () => {
    if (!user?.avatar || !user?.discord_id) {
      return null;
    }
    return `https://cdn.discordapp.com/avatars/${user.discord_id}/${user.avatar}.png`;
  };

  const avatarUrl = getAvatarUrl();

  return (
    <header
      className="h-14 flex items-center justify-between px-4 flex-shrink-0 border-b"
      style={{
        backgroundColor: 'var(--color-bg-elevated)',
        borderColor: 'var(--color-border)'
      }}
    >
      {/* Left section: Server and channel info */}
      <div className="flex items-center gap-4">
        {voiceContext ? (
          <>
            {/* Server info */}
            <div className="flex items-center gap-2">
              {voiceContext.guildIcon ? (
                <img
                  src={voiceContext.guildIcon}
                  alt={voiceContext.guildName}
                  className="w-6 h-6 rounded-full"
                />
              ) : (
                <div
                  className="w-6 h-6 rounded-full flex items-center justify-center text-xs font-medium"
                  style={{ backgroundColor: 'var(--color-bg)', color: 'var(--color-text-secondary)' }}
                >
                  {voiceContext.guildName?.charAt(0) || '?'}
                </div>
              )}
              <span className="text-sm font-medium" style={{ color: 'var(--color-text-primary)' }}>
                {voiceContext.guildName || 'Unknown Server'}
              </span>
            </div>

            {/* Separator */}
            <div className="w-px h-5" style={{ backgroundColor: 'var(--color-border)' }} />

            {/* Voice channel info */}
            <div className="flex items-center gap-2" style={{ color: 'var(--color-text-secondary)' }}>
              <Speaker size={18} />
              <span className="text-sm">
                {voiceContext.channelName || 'No channel'}
              </span>
            </div>

            {/* Separator */}
            <div className="w-px h-5" style={{ backgroundColor: 'var(--color-border)' }} />

            {/* Connection status */}
            <div className="flex items-center gap-2">
              <div
                className={`w-2 h-2 rounded-full ${
                  connected ? 'bg-accent' : 'bg-red-500'
                }`}
              />
              <span className={`text-sm ${connected ? 'text-accent' : 'text-red-400'}`}>
                {connected ? 'Connected' : 'Disconnected'}
              </span>
            </div>
          </>
        ) : (
          <span className="text-sm" style={{ color: 'var(--color-text-secondary)' }}>
            Not connected to a voice channel
          </span>
        )}
      </div>

      {/* Right section: User info */}
      <div className="flex items-center gap-3">
        {user && (
          <>
            <span className="text-sm" style={{ color: 'var(--color-text-secondary)' }}>{user.username}</span>
            {avatarUrl ? (
              <img
                src={avatarUrl}
                alt={user.username}
                className="w-8 h-8 rounded-full"
              />
            ) : (
              <div
                className="w-8 h-8 rounded-full flex items-center justify-center text-sm font-medium"
                style={{ backgroundColor: 'var(--color-bg)', color: 'var(--color-text-secondary)' }}
              >
                {user.username?.charAt(0) || '?'}
              </div>
            )}
            <button
              onClick={onLogout}
              className="text-sm transition-colors ml-2 px-3 py-1 rounded-lg hover:bg-white/10"
              style={{ color: 'var(--color-text-secondary)' }}
            >
              Logout
            </button>
          </>
        )}
      </div>
    </header>
  );
}
