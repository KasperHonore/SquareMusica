import { useState, useRef, useCallback } from 'react';
import { VolumeHigh, VolumeLow, VolumeMute } from './icons/index.jsx';

export function VolumeSlider({ value, onChange }) {
  const [isDragging, setIsDragging] = useState(false);
  const [isHovering, setIsHovering] = useState(false);
  const sliderRef = useRef(null);

  // Determine which volume icon to show based on current level
  const VolumeIcon = value === 0 ? VolumeMute : value < 50 ? VolumeLow : VolumeHigh;

  // Toggle mute on icon click
  const handleMuteToggle = useCallback(() => {
    onChange(value === 0 ? 50 : 0);
  }, [value, onChange]);

  const handleSliderChange = (e) => {
    onChange(parseInt(e.target.value));
  };

  const handleMouseDown = () => setIsDragging(true);
  const handleMouseUp = () => setIsDragging(false);
  const handleMouseEnter = () => setIsHovering(true);
  const handleMouseLeave = () => {
    setIsHovering(false);
    setIsDragging(false);
  };

  // Calculate progress for the track fill
  const progress = value;
  const isActive = isDragging || isHovering;

  return (
    <div
      className="volume-slider-container group"
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
      role="group"
      aria-label="Volume controls"
    >
      {/* Volume icon with mute toggle */}
      <button
        onClick={handleMuteToggle}
        className={`
          volume-icon-btn
          p-2 rounded-lg
          transition-all duration-200 ease-out
          min-w-[44px] min-h-[44px] flex items-center justify-center
          ${isActive ? 'text-primary' : 'text-secondary'}
          hover:text-primary hover:bg-surface-elevated
          focus:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2
        `}
        aria-label={value === 0 ? 'Unmute (currently muted)' : `Mute (currently ${value}%)`}
        aria-pressed={value === 0}
        title={value === 0 ? 'Unmute' : 'Mute'}
      >
        <VolumeIcon
          size={20}
          className={`
            transition-transform duration-200
            ${isDragging ? 'scale-110' : 'scale-100'}
          `}
        />
      </button>

      {/* Slider track container */}
      <div
        ref={sliderRef}
        className={`
          volume-track-container
          relative flex-1 h-10 flex items-center
          cursor-pointer
        `}
      >
        {/* Glow effect behind the track - visible on hover/drag */}
        <div
          className={`
            absolute inset-y-2 left-0 rounded-full
            transition-all duration-300 ease-out
            pointer-events-none
            ${isActive ? 'opacity-100' : 'opacity-0'}
          `}
          style={{
            width: `${progress}%`,
            background: 'var(--color-accent)',
            filter: 'blur(8px)',
            transform: 'scaleY(2)',
          }}
        />

        {/* Background track */}
        <div className="absolute inset-y-0 left-0 right-0 flex items-center">
          <div
            className={`
              w-full rounded-full
              transition-all duration-200 ease-out
              ${isActive ? 'h-[6px]' : 'h-1'}
            `}
            style={{
              background: 'var(--color-bg-elevated)',
            }}
          />
        </div>

        {/* Filled track */}
        <div className="absolute inset-y-0 left-0 right-0 flex items-center pointer-events-none">
          <div
            className={`
              rounded-full
              transition-all duration-200 ease-out
              ${isActive ? 'h-[6px]' : 'h-1'}
            `}
            style={{
              width: `${progress}%`,
              background: isActive
                ? 'var(--color-accent)'
                : 'var(--color-text-secondary)',
            }}
          />
        </div>

        {/* Native range input (for accessibility and native drag behavior) */}
        <input
          type="range"
          min="0"
          max="100"
          value={value}
          onChange={handleSliderChange}
          onMouseDown={handleMouseDown}
          onMouseUp={handleMouseUp}
          onTouchStart={handleMouseDown}
          onTouchEnd={handleMouseUp}
          className="volume-slider-input"
          aria-label="Volume"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={value}
          aria-valuetext={`${value}% volume`}
        />

        {/* Custom thumb */}
        <div
          className={`
            volume-thumb
            absolute rounded-full
            pointer-events-none
            transition-all duration-200
            ${isActive
              ? 'w-4 h-4 opacity-100 shadow-lg'
              : 'w-3 h-3 opacity-0'
            }
            ${isDragging ? 'scale-125' : 'scale-100'}
          `}
          style={{
            left: `calc(${progress}% - ${isActive ? '8px' : '6px'})`,
            background: 'var(--color-text-primary)',
            boxShadow: isDragging
              ? '0 0 12px var(--color-accent), 0 2px 8px rgba(0,0,0,0.3)'
              : '0 2px 4px rgba(0,0,0,0.2)',
          }}
        />
      </div>

      {/* Volume percentage label */}
      <span
        className={`
          volume-label
          w-12 text-right tabular-nums font-mono text-sm
          transition-all duration-200 ease-out
          ${isActive
            ? 'text-primary'
            : 'text-muted'
          }
        `}
      >
        {value}%
      </span>

      <style>{`
        .volume-slider-container {
          display: flex;
          align-items: center;
          gap: 0.75rem;
          padding: 0.75rem 1rem;
          background: var(--color-bg-raised);
          border-radius: var(--radius-lg);
          transition: all var(--transition-base);
        }

        .volume-slider-container:hover {
          background: var(--color-bg-elevated);
        }

        /* Hide the native slider but keep it functional */
        .volume-slider-input {
          position: absolute;
          width: 100%;
          height: 100%;
          opacity: 0;
          cursor: pointer;
          margin: 0;
          z-index: 10;
        }

        /* Ensure proper thumb sizing for touch */
        .volume-slider-input::-webkit-slider-thumb {
          -webkit-appearance: none;
          width: 24px;
          height: 24px;
          cursor: pointer;
        }

        .volume-slider-input::-moz-range-thumb {
          width: 24px;
          height: 24px;
          cursor: pointer;
          border: none;
          background: transparent;
        }

        /* Focus styles for accessibility */
        .volume-slider-input:focus-visible ~ .volume-thumb {
          outline: 2px solid var(--color-accent);
          outline-offset: 2px;
        }

        /* Animation keyframes for thumb pulse on drag */
        @keyframes thumb-pulse {
          0%, 100% {
            box-shadow: 0 0 12px var(--color-accent), 0 2px 8px rgba(0,0,0,0.3);
          }
          50% {
            box-shadow: 0 0 20px var(--color-accent), 0 2px 12px rgba(0,0,0,0.4);
          }
        }

        .volume-thumb.dragging {
          animation: thumb-pulse 1s ease-in-out infinite;
        }
      `}</style>
    </div>
  );
}
