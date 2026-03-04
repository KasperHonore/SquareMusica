import { PlaybackControls } from '../right/PlaybackControls';
import {
  MusicNote,
  Leave,
  Speaker
} from '../icons';

/**
 * MiniPlayer - Transport strip (72px bottom bar)
 *
 * Always visible. Shows playback controls + voice join/leave.
 * ┌──────────────────────────────────────────────────────────────────┐
 * │ [Art] Title / Artist   🔁 ⏮ ▶ ⏭ ⏹  [progress]   Voice btn   │
 * └──────────────────────────────────────────────────────────────────┘
 */
export function MiniPlayer({
  currentTrack,
  playerState,
  onControl,
  voiceContext,
  onJoinChannel,
  onLeaveChannel,
}) {
  const duration = currentTrack?.duration || 0;
  const position = playerState?.position || 0;
  const progress = duration > 0 ? (position / duration) * 100 : 0;

  const isVoiceConnected = voiceContext?.connected;
  const channelName = voiceContext?.channelName;

  return (
    <div
      className="fixed bottom-0 left-0 right-0 z-50"
      style={{
        height: '72px',
        backgroundColor: 'var(--color-bg-raised)',
        borderTop: '1px solid var(--color-border)',
      }}
      role="region"
      aria-label={currentTrack ? `Now playing: ${currentTrack.title}` : 'Player controls'}
    >
      <div
        className="h-full flex items-center"
        style={{ padding: '0 20px', gap: '12px' }}
      >
        {/* Left: Mini thumbnail + track info */}
        <div className="flex items-center gap-2.5 flex-shrink-0" style={{ width: '200px' }}>
          {currentTrack?.thumbnail ? (
            <img
              src={currentTrack.thumbnail}
              alt=""
              style={{
                width: '40px',
                height: '40px',
                borderRadius: '7px',
                objectFit: 'cover',
                flexShrink: 0,
              }}
            />
          ) : (
            <div
              style={{
                width: '40px',
                height: '40px',
                borderRadius: '7px',
                flexShrink: 0,
                backgroundColor: 'var(--color-bg-surface3)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              <MusicNote size={18} style={{ color: 'var(--color-text-muted)' }} />
            </div>
          )}
          <div className="min-w-0">
            <div
              className="truncate"
              style={{
                fontSize: '13px',
                fontWeight: 500,
                color: 'var(--color-text-primary)',
              }}
            >
              {currentTrack?.title || '\u2014'}
            </div>
            <div
              className="truncate"
              style={{
                fontSize: '11px',
                color: 'var(--color-text-muted)',
              }}
            >
              {currentTrack?.artist || 'Not playing'}
            </div>
          </div>
        </div>

        {/* Center: PlaybackControls + progress */}
        <div className="flex-1 flex flex-col items-center" style={{ gap: '5px' }}>
          <PlaybackControls playerState={playerState} onControl={onControl} />

          {/* Progress bar (visual only, no seek) */}
          <div
            style={{
              width: '100%',
              maxWidth: '400px',
              height: '2px',
              backgroundColor: 'var(--color-bg-elevated)',
              borderRadius: '2px',
            }}
          >
            <div
              style={{
                width: `${Math.min(progress, 100)}%`,
                height: '100%',
                backgroundColor: 'var(--color-text-secondary)',
                borderRadius: '2px',
                transition: 'width 1s linear',
              }}
            />
          </div>
        </div>

        {/* Right: Voice connection */}
        <div className="flex items-center gap-2 flex-shrink-0">
          {isVoiceConnected ? (
            <button
              onClick={onLeaveChannel}
              className="flex items-center gap-2 wave-bb-ctrl"
              style={{ padding: '6px 10px', borderRadius: '8px' }}
              title={`Leave ${channelName || 'voice'}`}
              aria-label={`Leave voice channel ${channelName || ''}`}
            >
              <span
                className="animate-pulse"
                style={{
                  width: '6px',
                  height: '6px',
                  borderRadius: '50%',
                  backgroundColor: 'var(--color-success)',
                  flexShrink: 0,
                }}
              />
              {channelName && (
                <span style={{ fontSize: '11px', color: 'var(--color-text-secondary)' }}>
                  {channelName}
                </span>
              )}
              <Leave size={14} />
            </button>
          ) : (
            <button
              onClick={onJoinChannel}
              className="wave-bb-ctrl"
              style={{ padding: '6px 10px', borderRadius: '8px' }}
              title="Join voice channel"
              aria-label="Join voice channel"
            >
              <Speaker size={16} />
            </button>
          )}
        </div>
      </div>

      <style>{`
        .wave-bb-ctrl {
          background: none;
          border: none;
          color: var(--color-text-secondary);
          cursor: pointer;
          padding: 7px;
          border-radius: 8px;
          transition: all 0.12s;
          display: flex;
          align-items: center;
          justify-content: center;
        }
        .wave-bb-ctrl:hover {
          color: var(--color-text-primary);
          background: var(--color-bg-elevated);
        }
      `}</style>
    </div>
  );
}
