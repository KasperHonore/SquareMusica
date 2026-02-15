import {
  MusicNote,
  Queue,
  History,
  Settings,
  Speaker,
  Leave,
  VolumeHigh,
  VolumeLow,
  VolumeMute,
  Loop,
} from '../icons/index.jsx';

/**
 * Sidebar component with navigation and persistent controls
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
 * ├────────────────────┤
 * │ Volume [─────*───] │
 * │ Loop: Off          │
 * └────────────────────┘
 */

const navItems = [
  { id: 'nowplaying', label: 'Now Playing', icon: MusicNote },
  { id: 'queue', label: 'Queue', icon: Queue },
  { id: 'history', label: 'History', icon: History },
  { id: 'settings', label: 'Settings', icon: Settings },
];

function VolumeIcon({ volume }) {
  if (volume === 0) return <VolumeMute size={18} />;
  if (volume < 50) return <VolumeLow size={18} />;
  return <VolumeHigh size={18} />;
}

function getLoopLabel(mode) {
  switch (mode) {
    case 'track':
      return 'Track';
    case 'queue':
      return 'Queue';
    default:
      return 'Off';
  }
}

export function Sidebar({
  activeView = 'nowplaying',
  onViewChange,
  voiceContext,
  playerState,
  onVolumeChange,
  onLoopChange,
  onLeaveChannel,
}) {
  const volume = playerState?.volume ?? 50;
  const loopMode = playerState?.loop ?? 'off';

  const handleVolumeChange = (e) => {
    onVolumeChange?.(parseInt(e.target.value, 10));
  };

  const handleLoopClick = () => {
    // Cycle through: off -> track -> queue -> off
    const modes = ['off', 'track', 'queue'];
    const currentIndex = modes.indexOf(loopMode);
    const nextIndex = (currentIndex + 1) % modes.length;
    onLoopChange?.(modes[nextIndex]);
  };

  return (
    <aside
      className="w-60 flex flex-col flex-shrink-0 border-r"
      style={{
        backgroundColor: 'var(--color-bg)',
        borderColor: 'var(--color-border)'
      }}
    >
      {/* Logo section */}
      <div className="p-4 border-b" style={{ borderColor: 'var(--color-border)' }}>
        <div className="flex items-center gap-3">
          <div className="p-2 rounded-lg bg-accent/20">
            <MusicNote size={24} className="text-accent" />
          </div>
          <span className="text-lg font-semibold" style={{ color: 'var(--color-text-primary)' }}>
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
                  className="w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-colors"
                  style={{
                    backgroundColor: isActive ? 'var(--color-bg-elevated)' : 'transparent',
                    color: isActive ? 'var(--color-text-primary)' : 'var(--color-text-secondary)'
                  }}
                >
                  <Icon
                    size={20}
                    className={isActive ? 'text-accent' : ''}
                    style={{ color: isActive ? undefined : 'var(--color-text-secondary)' }}
                  />
                  {label}
                </button>
              </li>
            );
          })}
        </ul>
      </nav>

      {/* Voice channel section */}
      {voiceContext?.channelName && (
        <div className="p-4 border-t" style={{ borderColor: 'var(--color-border)' }}>
          <div
            className="text-xs font-semibold uppercase tracking-wider mb-2"
            style={{ color: 'var(--color-text-muted)' }}
          >
            Voice Channel
          </div>
          <div className="flex items-center gap-2 mb-3" style={{ color: 'var(--color-text-secondary)' }}>
            <Speaker size={18} />
            <span className="text-sm truncate">{voiceContext.channelName}</span>
          </div>
          <button
            onClick={onLeaveChannel}
            className="w-full flex items-center justify-center gap-2 px-3 py-2 rounded-lg text-sm font-medium text-red-400 hover:text-red-300 hover:bg-red-500/10 transition-colors"
          >
            <Leave size={18} />
            Leave Channel
          </button>
        </div>
      )}

      {/* Playback controls section */}
      <div className="p-4 border-t" style={{ borderColor: 'var(--color-border)' }}>
        {/* Volume control */}
        <div className="mb-4">
          <div className="flex items-center gap-2 mb-2">
            <span style={{ color: 'var(--color-text-secondary)' }}>
              <VolumeIcon volume={volume} />
            </span>
            <span className="text-xs" style={{ color: 'var(--color-text-secondary)' }}>Volume</span>
            <span className="text-xs ml-auto" style={{ color: 'var(--color-text-muted)' }}>{volume}%</span>
          </div>
          <input
            type="range"
            min="0"
            max="100"
            value={volume}
            onChange={handleVolumeChange}
            className="w-full h-1 rounded-full appearance-none cursor-pointer
              [&::-webkit-slider-thumb]:appearance-none
              [&::-webkit-slider-thumb]:w-3
              [&::-webkit-slider-thumb]:h-3
              [&::-webkit-slider-thumb]:rounded-full
              [&::-webkit-slider-thumb]:bg-white
              [&::-webkit-slider-thumb]:hover:bg-accent
              [&::-webkit-slider-thumb]:transition-colors
              [&::-moz-range-thumb]:w-3
              [&::-moz-range-thumb]:h-3
              [&::-moz-range-thumb]:rounded-full
              [&::-moz-range-thumb]:bg-white
              [&::-moz-range-thumb]:border-0
              [&::-moz-range-thumb]:hover:bg-accent
              [&::-moz-range-thumb]:transition-colors"
            style={{ backgroundColor: 'var(--color-bg-elevated)' }}
          />
        </div>

        {/* Loop control */}
        <button
          onClick={handleLoopClick}
          className={`w-full flex items-center gap-2 px-3 py-2 rounded-lg text-sm transition-colors ${
            loopMode !== 'off'
              ? 'text-accent bg-accent/10'
              : ''
          }`}
          style={{
            color: loopMode === 'off' ? 'var(--color-text-secondary)' : undefined
          }}
        >
          <Loop size={18} mode={loopMode} />
          <span>Loop: {getLoopLabel(loopMode)}</span>
        </button>
      </div>
    </aside>
  );
}
