import { useState } from 'react';
import { PlaybackControls } from '../right/PlaybackControls';
import {
  MusicNote,
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

  const isVoiceConnected = !!voiceContext;
  const channelName = voiceContext?.channelName;
  const [actionHovered, setActionHovered] = useState(false);

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

        {/* Right: Voice connection split pill */}
        <div
          className="flex-shrink-0"
          style={{
            display: 'flex',
            borderRadius: '10px',
            border: '1px solid var(--color-border)',
            overflow: 'hidden',
            backgroundColor: isVoiceConnected ? 'rgba(126,200,122,0.08)' : 'var(--color-bg-elevated)',
            transition: 'all 0.12s',
          }}
        >
          {/* Left: status (not clickable) */}
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '6px',
              padding: '6px 10px',
              fontSize: '11px',
              color: isVoiceConnected ? 'var(--color-text-secondary)' : 'var(--color-text-muted)',
              whiteSpace: 'nowrap',
            }}
          >
            <span
              className={isVoiceConnected ? 'animate-pulse' : undefined}
              style={{
                width: '6px',
                height: '6px',
                borderRadius: '50%',
                backgroundColor: isVoiceConnected ? 'var(--color-success)' : 'var(--color-text-muted)',
                flexShrink: 0,
              }}
            />
            {isVoiceConnected ? `#${channelName || 'voice'}` : 'Not connected'}
          </div>

          {/* Divider */}
          <div style={{ width: '1px', backgroundColor: 'var(--color-border)' }} />

          {/* Right: action button */}
          <button
            onClick={isVoiceConnected ? onLeaveChannel : onJoinChannel}
            onMouseEnter={() => setActionHovered(true)}
            onMouseLeave={() => setActionHovered(false)}
            style={{
              background: actionHovered
                ? isVoiceConnected ? 'rgba(232,122,122,0.15)' : 'var(--color-accent-muted)'
                : 'transparent',
              border: 'none',
              padding: '6px 12px',
              fontSize: '11px',
              fontWeight: 500,
              cursor: 'pointer',
              color: actionHovered
                ? isVoiceConnected ? 'var(--color-danger)' : 'var(--color-accent)'
                : 'var(--color-text-secondary)',
              transition: 'all 0.12s',
              whiteSpace: 'nowrap',
            }}
            aria-label={isVoiceConnected ? `Leave voice channel ${channelName || ''}` : 'Join voice channel'}
          >
            {isVoiceConnected ? 'Leave' : 'Join'}
          </button>
        </div>
      </div>
    </div>
  );
}
