import { useState } from 'react';
import { formatTime } from '../../utils/formatTime';
import { MusicNote } from '../icons';

/**
 * NowPlayingCompact - Right panel now-playing section
 *
 * Shows album art, track info, and a display-only progress bar.
 * Matches Wave design: Instrument Serif title, gold progress, scrubber on hover.
 */
export function NowPlayingCompact({ currentTrack, playerState }) {
  const [isHovered, setIsHovered] = useState(false);

  const duration = currentTrack?.duration || 0;
  const position = playerState?.position || 0;
  const progress = duration > 0 ? (position / duration) * 100 : 0;

  return (
    <div className="flex flex-col gap-3 flex-shrink-0" style={{ padding: '22px 20px 14px' }}>
      {/* Label */}
      <div
        className="text-label"
        style={{
          fontSize: '10px',
          fontWeight: 600,
          letterSpacing: '1px',
          textTransform: 'uppercase',
          color: 'var(--color-text-muted)'
        }}
      >
        Now Playing
      </div>

      {/* Album art */}
      <div
        className="relative w-full overflow-hidden"
        style={{
          aspectRatio: '1',
          borderRadius: '10px',
          backgroundColor: 'var(--color-bg-elevated)'
        }}
      >
        {currentTrack?.thumbnail ? (
          <img
            src={currentTrack.thumbnail}
            alt=""
            className="w-full h-full object-cover"
            style={{ transition: 'opacity 0.3s' }}
          />
        ) : (
          <div className="absolute inset-0 flex items-center justify-center">
            <MusicNote size={48} style={{ color: 'var(--color-text-muted)' }} />
          </div>
        )}
      </div>

      {/* Track info */}
      <div className="flex flex-col gap-0.5">
        <div
          className="truncate"
          style={{
            fontFamily: 'var(--font-heading)',
            fontSize: '17px',
            lineHeight: '1.25',
            color: 'var(--color-text-primary)'
          }}
        >
          {currentTrack?.title || 'Nothing playing'}
        </div>
        <div
          className="truncate"
          style={{
            fontSize: '12px',
            color: 'var(--color-text-muted)'
          }}
        >
          {currentTrack?.artist || '\u2014'}
        </div>
      </div>

      {/* Progress bar */}
      <div style={{ padding: '0' }}>
        <div
          className="w-full relative"
          style={{
            height: '3px',
            backgroundColor: 'var(--color-bg-elevated)',
            borderRadius: '3px'
          }}
          onMouseEnter={() => setIsHovered(true)}
          onMouseLeave={() => setIsHovered(false)}
          aria-label="Playback progress"
          aria-valuemin={0}
          aria-valuemax={duration}
          aria-valuenow={Math.floor(position)}
          aria-valuetext={`${formatTime(position)} of ${formatTime(duration)}`}
        >
          <div
            className="h-full relative"
            style={{
              width: `${Math.min(progress, 100)}%`,
              backgroundColor: 'var(--color-accent)',
              borderRadius: '3px'
            }}
          >
            {/* Scrubber dot - visible on hover */}
            <div
              style={{
                position: 'absolute',
                right: '-4px',
                top: '-3px',
                width: '9px',
                height: '9px',
                backgroundColor: 'var(--color-accent)',
                borderRadius: '50%',
                opacity: isHovered ? 1 : 0,
                transition: 'opacity 0.15s'
              }}
            />
          </div>
        </div>

        {/* Time display */}
        <div
          className="flex justify-between"
          style={{
            fontSize: '10px',
            color: 'var(--color-text-muted)',
            marginTop: '6px'
          }}
        >
          <span>{formatTime(position)}</span>
          <span>{formatTime(duration)}</span>
        </div>
      </div>
    </div>
  );
}
