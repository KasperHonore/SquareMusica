import { useState } from 'react';
import { formatTime } from '../../utils/formatTime';
import {
  Play,
  Pause,
  SkipNext,
  SkipPrevious,
  Shuffle,
  Loop,
  VolumeHigh,
  VolumeLow,
  VolumeMute,
  MusicNote
} from '../icons';

/**
 * Compact volume slider for MiniPlayer
 */
function CompactVolumeSlider({ value, onChange, onMute }) {
  const [showSlider, setShowSlider] = useState(false);

  const VolumeIcon = value === 0 ? VolumeMute : value < 50 ? VolumeLow : VolumeHigh;

  return (
    <div
      className="relative flex items-center"
      onMouseEnter={() => setShowSlider(true)}
      onMouseLeave={() => setShowSlider(false)}
    >
      <button
        onClick={onMute}
        className="p-1.5 rounded-full transition-colors hover:bg-white/10"
        style={{ color: 'var(--color-text-secondary)' }}
        title={value === 0 ? 'Unmute' : 'Mute'}
        aria-label={value === 0 ? 'Unmute' : 'Mute'}
      >
        <VolumeIcon size={18} />
      </button>

      <div
        className={`absolute bottom-full left-1/2 -translate-x-1/2 mb-2 px-3 py-2 rounded-lg shadow-lg transition-opacity ${
          showSlider ? 'opacity-100' : 'opacity-0 pointer-events-none'
        }`}
        style={{ backgroundColor: 'var(--color-bg-elevated)' }}
      >
        <input
          type="range"
          min="0"
          max="100"
          value={value}
          onChange={(e) => onChange(parseInt(e.target.value))}
          className="w-24 h-1 rounded-lg appearance-none cursor-pointer accent-accent"
          style={{ backgroundColor: 'var(--color-bg-raised)' }}
          aria-label="Volume"
        />
      </div>
    </div>
  );
}

export function MiniPlayer({ currentTrack, playerState, onControl }) {
  const [prevVolume, setPrevVolume] = useState(100);

  if (!currentTrack) {
    return null;
  }

  const progress = currentTrack.duration
    ? (playerState.position / currentTrack.duration) * 100
    : 0;

  const handleMute = () => {
    if (playerState.volume > 0) {
      setPrevVolume(playerState.volume);
      onControl('volume', 0);
    } else {
      onControl('volume', prevVolume);
    }
  };

  const handleVolumeChange = (value) => {
    onControl('volume', value);
    if (value > 0) {
      setPrevVolume(value);
    }
  };

  const cycleLoopMode = () => {
    const modes = ['off', 'track', 'queue'];
    const currentIndex = modes.indexOf(playerState.loop || 'off');
    const nextIndex = (currentIndex + 1) % modes.length;
    onControl('loop', modes[nextIndex]);
  };

  return (
    <div
      className="fixed bottom-0 left-0 right-0 h-[72px] z-50 border-t"
      style={{
        backgroundColor: 'var(--color-bg-raised)',
        borderColor: 'var(--color-border)'
      }}
    >
      {/* Progress bar (thin, at top of miniplayer) */}
      <div
        className="absolute top-0 left-0 right-0 h-1 cursor-pointer group"
        style={{ backgroundColor: 'var(--color-bg-elevated)' }}
        onClick={(e) => {
          const rect = e.currentTarget.getBoundingClientRect();
          const percent = (e.clientX - rect.left) / rect.width;
          const newPosition = percent * (currentTrack.duration || 0);
          onControl('seek', newPosition);
        }}
      >
        <div
          className="h-full bg-accent transition-all duration-300 group-hover:bg-accent-hover"
          style={{ width: `${Math.min(progress, 100)}%` }}
        />
      </div>

      <div className="h-full flex items-center px-2 sm:px-4 gap-2 sm:gap-4">
        {/* Track Info */}
        <div className="flex items-center gap-2 sm:gap-3 min-w-0 flex-1 sm:flex-none sm:w-[30%]">
          {currentTrack.thumbnail ? (
            <img
              src={currentTrack.thumbnail}
              alt=""
              className="w-12 h-12 rounded-lg object-cover flex-shrink-0"
            />
          ) : (
            <div
              className="w-12 h-12 rounded-lg flex items-center justify-center flex-shrink-0"
              style={{ backgroundColor: 'var(--color-bg-elevated)' }}
            >
              <MusicNote size={20} className="text-accent" />
            </div>
          )}
          <div className="min-w-0">
            <p className="font-medium truncate text-sm">
              {currentTrack.title}
            </p>
            <p className="text-xs truncate" style={{ color: 'var(--color-text-secondary)' }}>
              {currentTrack.requestedBy && `Requested by ${currentTrack.requestedBy}`}
            </p>
          </div>
        </div>

        {/* Playback Controls (center) */}
        <div className="flex items-center justify-center gap-1 sm:gap-2 flex-shrink-0">
          <button
            onClick={() => onControl('previous')}
            className="p-2 rounded-full transition-colors hover:bg-white/10"
            style={{ color: 'var(--color-text-secondary)' }}
            title="Previous"
            aria-label="Previous track"
          >
            <SkipPrevious size={20} />
          </button>

          <button
            onClick={() => onControl(playerState.playing ? 'pause' : 'play')}
            className="p-2 rounded-full bg-white text-surface transition-transform hover:scale-105"
            title={playerState.playing ? 'Pause' : 'Play'}
            aria-label={playerState.playing ? 'Pause' : 'Play'}
          >
            {playerState.playing ? <Pause size={20} /> : <Play size={20} />}
          </button>

          <button
            onClick={() => onControl('skip')}
            className="p-2 rounded-full transition-colors hover:bg-white/10"
            style={{ color: 'var(--color-text-secondary)' }}
            title="Skip"
            aria-label="Skip to next track"
          >
            <SkipNext size={20} />
          </button>
        </div>

        {/* Time & Secondary Controls - hidden on mobile */}
        <div className="hidden sm:flex items-center gap-3 w-[30%] justify-end">
          {/* Time display */}
          <span className="text-xs tabular-nums" style={{ color: 'var(--color-text-muted)' }}>
            {formatTime(playerState.position)} / {formatTime(currentTrack.duration)}
          </span>

          {/* Shuffle */}
          <button
            onClick={() => onControl('shuffle')}
            className="p-1.5 rounded-full transition-colors hover:bg-white/10"
            style={{ color: 'var(--color-text-secondary)' }}
            title="Shuffle queue"
            aria-label="Shuffle queue"
          >
            <Shuffle size={18} />
          </button>

          {/* Loop */}
          <button
            onClick={cycleLoopMode}
            className={`p-1.5 rounded-full transition-colors hover:bg-white/10 ${
              playerState.loop !== 'off' ? 'text-accent' : ''
            }`}
            style={{
              color: playerState.loop !== 'off' ? undefined : 'var(--color-text-secondary)'
            }}
            title={`Loop: ${playerState.loop || 'off'}`}
            aria-label={`Loop mode: ${playerState.loop || 'off'}`}
          >
            <Loop size={18} mode={playerState.loop} />
          </button>

          {/* Volume */}
          <CompactVolumeSlider
            value={playerState.volume}
            onChange={handleVolumeChange}
            onMute={handleMute}
          />
        </div>
      </div>
    </div>
  );
}
