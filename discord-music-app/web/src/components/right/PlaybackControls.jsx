import { Play, Pause, SkipNext, SkipPrevious, Loop, Stop } from '../icons';

/**
 * PlaybackControls - 5-button row for the right panel
 *
 * Loop | Previous | Play/Pause | Skip | Stop
 * Matches Wave design: gold play button, muted icon buttons, hover surface2 bg.
 */
export function PlaybackControls({ playerState, onControl }) {
  const isPlaying = playerState?.playing;
  const loopMode = playerState?.loop || 'off';
  const isLoopActive = loopMode !== 'off';

  const cycleLoopMode = () => {
    const modes = ['off', 'all', 'track'];
    const currentIndex = modes.indexOf(loopMode);
    const nextIndex = (currentIndex + 1) % modes.length;
    onControl('loop', modes[nextIndex]);
  };

  // Shared button style for control buttons (non-play)
  const ctrlStyle = {
    background: 'none',
    border: 'none',
    color: 'var(--color-text-secondary)',
    cursor: 'pointer',
    padding: '7px',
    borderRadius: '8px',
    transition: 'all 0.12s',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    position: 'relative',
  };

  const ctrlHoverClass = 'wave-ctrl-btn';

  return (
    <>
      <style>{`
        .wave-ctrl-btn:hover {
          background: var(--color-bg-elevated) !important;
          color: var(--color-text-primary) !important;
        }
        .wave-ctrl-btn.active {
          color: var(--color-accent) !important;
        }
        .wave-ctrl-btn:disabled {
          opacity: 0.3;
          cursor: not-allowed;
        }
        .wave-ctrl-btn:disabled:hover {
          background: none !important;
          color: var(--color-text-secondary) !important;
        }
        .wave-play-btn {
          background: var(--color-accent);
          color: var(--color-text-inverse);
          width: 40px;
          height: 40px;
          border-radius: 50%;
          border: none;
          cursor: pointer;
          display: flex;
          align-items: center;
          justify-content: center;
          padding: 0;
          transition: filter 0.12s;
        }
        .wave-play-btn:hover {
          filter: brightness(1.1);
        }
        .wave-loop-badge {
          position: absolute;
          top: 2px;
          right: 2px;
          font-size: 8px;
          font-weight: 700;
          color: var(--color-accent);
          line-height: 1;
        }
      `}</style>

      <div
        className="flex items-center justify-between flex-shrink-0"
        style={{ padding: '2px 20px 0' }}
      >
        {/* Loop */}
        <button
          className={`${ctrlHoverClass} ${isLoopActive ? 'active' : ''}`}
          style={ctrlStyle}
          onClick={cycleLoopMode}
          title={`Loop: ${loopMode}`}
          aria-label={`Loop mode: ${loopMode}`}
          aria-pressed={isLoopActive}
        >
          <Loop size={15} mode={loopMode === 'track' ? 'track' : 'off'} />
          {loopMode === 'track' && (
            <span className="wave-loop-badge">1</span>
          )}
        </button>

        {/* Previous */}
        <button
          className={ctrlHoverClass}
          style={ctrlStyle}
          onClick={() => onControl('previous')}
          title="Previous"
          aria-label="Go to previous track"
        >
          <SkipPrevious size={18} />
        </button>

        {/* Play / Pause */}
        <button
          className="wave-play-btn"
          onClick={() => onControl(isPlaying ? 'pause' : 'play')}
          title={isPlaying ? 'Pause' : 'Play'}
          aria-label={isPlaying ? 'Pause playback' : 'Resume playback'}
        >
          {isPlaying ? <Pause size={18} /> : <Play size={18} />}
        </button>

        {/* Skip */}
        <button
          className={ctrlHoverClass}
          style={ctrlStyle}
          onClick={() => onControl('skip')}
          title="Skip"
          aria-label="Skip to next track"
        >
          <SkipNext size={18} />
        </button>

        {/* Stop */}
        <button
          className={ctrlHoverClass}
          style={ctrlStyle}
          onClick={() => onControl('stop')}
          title="Stop"
          aria-label="Stop playback"
        >
          <Stop size={15} />
        </button>
      </div>
    </>
  );
}
