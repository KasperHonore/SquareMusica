import { formatTime } from '../../utils/formatTime';
import {
  Play,
  Pause,
  SkipNext,
  SkipPrevious,
  MusicNote,
  Leave,
  Speaker
} from '../icons';

/**
 * MiniPlayer - Minimal transport strip (72px bottom bar)
 *
 * Wave design bottom bar:
 * ┌──────────────────────────────────────────────────────────────┐
 * │ [Art] Title / Artist    ⏮  ▶  ⏭    [progress]   Voice btn  │
 * └──────────────────────────────────────────────────────────────┘
 *
 * Controls mirror the right panel (same playerControl calls).
 * No seek on progress bar here (visual sync only).
 */
export function MiniPlayer({
  currentTrack,
  playerState,
  onControl,
  voiceContext,
  onJoinChannel,
  onLeaveChannel,
}) {
  if (!currentTrack) return null;

  const isPlaying = playerState?.playing;
  const duration = currentTrack.duration || 0;
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
      aria-label={`Now playing: ${currentTrack.title}`}
    >
      <div
        className="h-full flex items-center"
        style={{ padding: '0 20px', gap: '12px' }}
      >
        {/* Left: Mini thumbnail + track info */}
        <div className="flex items-center gap-2.5 flex-shrink-0" style={{ width: '200px' }}>
          {/* Thumbnail */}
          {currentTrack.thumbnail ? (
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
              {currentTrack.title}
            </div>
            <div
              className="truncate"
              style={{
                fontSize: '11px',
                color: 'var(--color-text-muted)',
              }}
            >
              {currentTrack.artist || '\u2014'}
            </div>
          </div>
        </div>

        {/* Center: Controls + progress */}
        <div className="flex-1 flex flex-col items-center" style={{ gap: '7px' }}>
          {/* Transport buttons */}
          <div className="flex items-center" style={{ gap: '2px' }}>
            <button
              onClick={() => onControl('previous')}
              className="wave-bb-ctrl"
              title="Previous"
              aria-label="Previous track"
            >
              <SkipPrevious size={17} />
            </button>
            <button
              onClick={() => onControl(isPlaying ? 'pause' : 'play')}
              className="wave-bb-play"
              title={isPlaying ? 'Pause' : 'Play'}
              aria-label={isPlaying ? 'Pause' : 'Play'}
            >
              {isPlaying ? <Pause size={15} /> : <Play size={15} />}
            </button>
            <button
              onClick={() => onControl('skip')}
              className="wave-bb-ctrl"
              title="Skip"
              aria-label="Skip to next track"
            >
              <SkipNext size={17} />
            </button>
          </div>

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
              {/* Green pulse dot */}
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
        .wave-bb-play {
          background: var(--color-accent);
          color: var(--color-text-inverse);
          width: 34px;
          height: 34px;
          border-radius: 50%;
          border: none;
          cursor: pointer;
          display: flex;
          align-items: center;
          justify-content: center;
          padding: 0;
          transition: filter 0.12s;
        }
        .wave-bb-play:hover {
          filter: brightness(1.1);
        }
      `}</style>
    </div>
  );
}
