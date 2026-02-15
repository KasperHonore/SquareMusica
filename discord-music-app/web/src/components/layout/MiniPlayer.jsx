import { useState, useEffect, useRef, useCallback } from 'react';
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
 * Extract dominant color from album art using canvas
 * Returns HSL values for flexible manipulation
 */
function useAlbumColor(thumbnailUrl) {
  const [color, setColor] = useState({ h: 142, s: 73, l: 40 }); // Default: accent green

  useEffect(() => {
    if (!thumbnailUrl) {
      setColor({ h: 142, s: 73, l: 40 });
      return;
    }

    const img = new Image();
    img.crossOrigin = 'anonymous';

    img.onload = () => {
      try {
        const canvas = document.createElement('canvas');
        const ctx = canvas.getContext('2d');
        canvas.width = 50;
        canvas.height = 50;
        ctx.drawImage(img, 0, 0, 50, 50);

        const imageData = ctx.getImageData(0, 0, 50, 50).data;
        let r = 0, g = 0, b = 0, count = 0;

        // Sample pixels, skip near-black/white for better color extraction
        for (let i = 0; i < imageData.length; i += 16) {
          const pr = imageData[i];
          const pg = imageData[i + 1];
          const pb = imageData[i + 2];

          // Skip very dark or very light pixels
          const brightness = (pr + pg + pb) / 3;
          if (brightness > 30 && brightness < 225) {
            r += pr;
            g += pg;
            b += pb;
            count++;
          }
        }

        if (count > 0) {
          r = Math.round(r / count);
          g = Math.round(g / count);
          b = Math.round(b / count);

          // Convert RGB to HSL
          const rNorm = r / 255;
          const gNorm = g / 255;
          const bNorm = b / 255;
          const max = Math.max(rNorm, gNorm, bNorm);
          const min = Math.min(rNorm, gNorm, bNorm);
          let h, s, l = (max + min) / 2;

          if (max === min) {
            h = s = 0;
          } else {
            const d = max - min;
            s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
            switch (max) {
              case rNorm: h = ((gNorm - bNorm) / d + (gNorm < bNorm ? 6 : 0)) / 6; break;
              case gNorm: h = ((bNorm - rNorm) / d + 2) / 6; break;
              case bNorm: h = ((rNorm - gNorm) / d + 4) / 6; break;
              default: h = 0;
            }
          }

          // Boost saturation for more vivid glow
          setColor({
            h: Math.round(h * 360),
            s: Math.min(100, Math.round(s * 100) + 20),
            l: Math.round(l * 100)
          });
        }
      } catch (e) {
        // CORS or other error - use default
        setColor({ h: 142, s: 73, l: 40 });
      }
    };

    img.onerror = () => {
      setColor({ h: 142, s: 73, l: 40 });
    };

    img.src = thumbnailUrl;
  }, [thumbnailUrl]);

  return color;
}

/**
 * Waveform visualization component
 */
function WaveformVisualizer({ isPlaying, color }) {
  const bars = 5;
  const baseHeight = isPlaying ? 'h-3' : 'h-1';

  return (
    <div className="flex items-end gap-[3px] h-4">
      {Array.from({ length: bars }).map((_, i) => (
        <div
          key={i}
          className={`w-[3px] rounded-full transition-all duration-300 ${
            isPlaying ? 'animate-wave' : baseHeight
          }`}
          style={{
            backgroundColor: `hsl(${color.h}, ${color.s}%, ${Math.min(color.l + 15, 70)}%)`,
            animationDelay: isPlaying ? `${i * 0.1}s` : '0s',
            height: isPlaying ? undefined : '4px'
          }}
        />
      ))}
    </div>
  );
}

/**
 * Compact volume slider for MiniPlayer with glass styling
 */
function CompactVolumeSlider({ value, onChange, onMute, glowColor }) {
  const [showSlider, setShowSlider] = useState(false);

  const VolumeIcon = value === 0 ? VolumeMute : value < 50 ? VolumeLow : VolumeHigh;

  return (
    <div
      className="relative flex items-center"
      onMouseEnter={() => setShowSlider(true)}
      onMouseLeave={() => setShowSlider(false)}
      role="group"
      aria-label="Volume controls"
    >
      <button
        onClick={onMute}
        className="miniplayer-btn-secondary min-w-[44px] min-h-[44px] flex items-center justify-center"
        style={{ color: 'var(--color-text-secondary)' }}
        title={value === 0 ? 'Unmute' : 'Mute'}
        aria-label={value === 0 ? 'Unmute (currently muted)' : `Mute (currently ${value}%)`}
        aria-pressed={value === 0}
      >
        <VolumeIcon size={18} aria-hidden="true" />
      </button>

      <div
        className={`absolute bottom-full left-1/2 -translate-x-1/2 mb-3 px-4 py-3 rounded-xl transition-all duration-200 ${
          showSlider ? 'opacity-100 translate-y-0' : 'opacity-0 translate-y-2 pointer-events-none'
        }`}
        style={{
          background: 'rgba(40, 40, 40, 0.95)',
          backdropFilter: 'blur(12px)',
          border: '1px solid var(--color-border)',
          boxShadow: `0 8px 32px rgba(0, 0, 0, 0.4), 0 0 20px hsla(${glowColor.h}, ${glowColor.s}%, ${glowColor.l}%, 0.15)`
        }}
        role="dialog"
        aria-label="Volume slider"
      >
        <input
          type="range"
          min="0"
          max="100"
          value={value}
          onChange={(e) => onChange(parseInt(e.target.value))}
          className="volume-slider w-24"
          style={{
            '--thumb-color': `hsl(${glowColor.h}, ${glowColor.s}%, ${Math.min(glowColor.l + 10, 60)}%)`
          }}
          aria-label="Volume"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={value}
          aria-valuetext={`${value}% volume`}
        />
      </div>
    </div>
  );
}

/**
 * Play/Pause button with micro-interactions
 */
function PlayPauseButton({ isPlaying, onClick, glowColor }) {
  const [isPressed, setIsPressed] = useState(false);

  const handleClick = () => {
    setIsPressed(true);
    onClick();
    setTimeout(() => setIsPressed(false), 150);
  };

  return (
    <button
      onClick={handleClick}
      className={`miniplayer-btn-primary min-w-[44px] min-h-[44px] ${isPressed ? 'scale-90' : ''}`}
      style={{
        background: `linear-gradient(135deg,
          hsl(${glowColor.h}, ${glowColor.s}%, ${Math.min(glowColor.l + 10, 55)}%) 0%,
          hsl(${glowColor.h}, ${glowColor.s}%, ${Math.max(glowColor.l - 5, 30)}%) 100%)`,
        boxShadow: `0 4px 20px hsla(${glowColor.h}, ${glowColor.s}%, ${glowColor.l}%, 0.4)`
      }}
      title={isPlaying ? 'Pause' : 'Play'}
      aria-label={isPlaying ? 'Pause playback' : 'Resume playback'}
    >
      <span className={`transition-transform duration-150 ${isPressed ? 'scale-75' : 'scale-100'}`} aria-hidden="true">
        {isPlaying ? <Pause size={22} /> : <Play size={22} />}
      </span>
    </button>
  );
}

/**
 * Skip button with satisfying bounce animation
 */
function SkipButton({ direction, onClick, disabled }) {
  const [isAnimating, setIsAnimating] = useState(false);
  const Icon = direction === 'next' ? SkipNext : SkipPrevious;

  const handleClick = () => {
    if (disabled) return;
    setIsAnimating(true);
    onClick();
    setTimeout(() => setIsAnimating(false), 300);
  };

  return (
    <button
      onClick={handleClick}
      disabled={disabled}
      className={`miniplayer-btn-secondary min-w-[44px] min-h-[44px] flex items-center justify-center ${isAnimating ? 'animate-skip-bounce' : ''}`}
      style={{
        color: 'var(--color-text-secondary)',
        transform: isAnimating
          ? direction === 'next' ? 'translateX(3px)' : 'translateX(-3px)'
          : 'translateX(0)'
      }}
      title={direction === 'next' ? 'Skip' : 'Previous'}
      aria-label={direction === 'next' ? 'Skip to next track' : 'Go to previous track'}
    >
      <Icon size={22} aria-hidden="true" />
    </button>
  );
}

export function MiniPlayer({ currentTrack, playerState, onControl }) {
  const [prevVolume, setPrevVolume] = useState(100);
  const [isExpanded, setIsExpanded] = useState(false);
  const [isMobile, setIsMobile] = useState(false);
  const expandTimeoutRef = useRef(null);

  // Extract dominant color from album art
  const albumColor = useAlbumColor(currentTrack?.thumbnail);

  // Detect mobile
  useEffect(() => {
    const checkMobile = () => setIsMobile(window.innerWidth < 640);
    checkMobile();
    window.addEventListener('resize', checkMobile);
    return () => window.removeEventListener('resize', checkMobile);
  }, []);

  // Handle hover expansion (desktop only)
  const handleMouseEnter = useCallback(() => {
    if (isMobile) return;
    clearTimeout(expandTimeoutRef.current);
    expandTimeoutRef.current = setTimeout(() => setIsExpanded(true), 200);
  }, [isMobile]);

  const handleMouseLeave = useCallback(() => {
    if (isMobile) return;
    clearTimeout(expandTimeoutRef.current);
    expandTimeoutRef.current = setTimeout(() => setIsExpanded(false), 300);
  }, [isMobile]);

  // Handle tap expansion (mobile)
  const handleTap = useCallback(() => {
    if (!isMobile) return;
    setIsExpanded(prev => !prev);
  }, [isMobile]);

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

  // Dynamic glow based on album color
  const glowStyle = {
    boxShadow: `
      0 -8px 32px hsla(${albumColor.h}, ${albumColor.s}%, ${albumColor.l}%, 0.15),
      0 0 60px hsla(${albumColor.h}, ${albumColor.s}%, ${albumColor.l}%, 0.08),
      inset 0 1px 0 rgba(255, 255, 255, 0.05)
    `
  };

  // Expanded height calculation
  const playerHeight = isExpanded ? 'h-[100px]' : 'h-[72px]';

  return (
    <>
      {/* Custom styles for MiniPlayer */}
      <style>{`
        .miniplayer-glass {
          background: linear-gradient(
            180deg,
            rgba(40, 40, 40, 0.85) 0%,
            rgba(24, 24, 24, 0.95) 100%
          );
          backdrop-filter: blur(20px) saturate(180%);
          -webkit-backdrop-filter: blur(20px) saturate(180%);
        }

        .miniplayer-btn-primary {
          padding: 10px;
          border-radius: 9999px;
          color: white;
          transition: all 200ms cubic-bezier(0.4, 0, 0.2, 1);
          transform-origin: center;
        }

        .miniplayer-btn-primary:hover {
          transform: scale(1.08);
          filter: brightness(1.1);
        }

        .miniplayer-btn-primary:active {
          transform: scale(0.95);
        }

        .miniplayer-btn-secondary {
          padding: 8px;
          border-radius: 9999px;
          transition: all 200ms cubic-bezier(0.4, 0, 0.2, 1);
        }

        .miniplayer-btn-secondary:hover {
          background: rgba(255, 255, 255, 0.1);
          color: var(--color-text-primary) !important;
          transform: scale(1.05);
        }

        .miniplayer-btn-secondary:active {
          transform: scale(0.95);
        }

        @keyframes skip-bounce {
          0%, 100% { transform: translateX(0); }
          50% { transform: translateX(4px); }
        }

        .animate-skip-bounce {
          animation: skip-bounce 0.3s cubic-bezier(0.68, -0.55, 0.265, 1.55);
        }

        .progress-track {
          position: relative;
          overflow: hidden;
        }

        .progress-track::after {
          content: '';
          position: absolute;
          top: 0;
          left: 0;
          right: 0;
          bottom: 0;
          background: linear-gradient(90deg, transparent, rgba(255,255,255,0.2), transparent);
          transform: translateX(-100%);
          animation: shimmer 2s infinite;
        }

        @keyframes shimmer {
          100% { transform: translateX(100%); }
        }

        .volume-slider {
          -webkit-appearance: none;
          appearance: none;
          height: 4px;
          border-radius: 2px;
          background: var(--color-bg-elevated);
          cursor: pointer;
        }

        .volume-slider::-webkit-slider-thumb {
          -webkit-appearance: none;
          appearance: none;
          width: 14px;
          height: 14px;
          border-radius: 50%;
          background: var(--thumb-color, var(--color-accent));
          cursor: pointer;
          transition: transform 0.15s ease, box-shadow 0.15s ease;
          box-shadow: 0 2px 8px rgba(0, 0, 0, 0.3);
        }

        .volume-slider::-webkit-slider-thumb:hover {
          transform: scale(1.2);
          box-shadow: 0 2px 12px rgba(0, 0, 0, 0.4);
        }

        .volume-slider::-moz-range-thumb {
          width: 14px;
          height: 14px;
          border-radius: 50%;
          background: var(--thumb-color, var(--color-accent));
          cursor: pointer;
          border: none;
          transition: transform 0.15s ease, box-shadow 0.15s ease;
          box-shadow: 0 2px 8px rgba(0, 0, 0, 0.3);
        }

        .album-art-glow {
          position: relative;
        }

        .album-art-glow::before {
          content: '';
          position: absolute;
          inset: -4px;
          border-radius: 14px;
          background: linear-gradient(
            135deg,
            hsla(var(--glow-h), var(--glow-s), var(--glow-l), 0.4) 0%,
            hsla(var(--glow-h), var(--glow-s), calc(var(--glow-l) - 10%), 0.2) 100%
          );
          filter: blur(8px);
          z-index: -1;
          opacity: 0.7;
          transition: opacity 0.3s ease;
        }

        .miniplayer:hover .album-art-glow::before {
          opacity: 1;
        }

        /* Wave animation with staggered delays */
        @keyframes wave {
          0%, 100% { transform: scaleY(0.4); }
          50% { transform: scaleY(1); }
        }

        .animate-wave {
          animation: wave 0.8s ease-in-out infinite;
        }
      `}</style>

      <div
        className={`miniplayer fixed bottom-0 left-0 right-0 ${playerHeight} z-50 border-t miniplayer-glass transition-all duration-300 ease-out`}
        style={{
          borderColor: `hsla(${albumColor.h}, ${albumColor.s}%, ${albumColor.l}%, 0.2)`,
          ...glowStyle
        }}
        onMouseEnter={handleMouseEnter}
        onMouseLeave={handleMouseLeave}
        onClick={isMobile ? handleTap : undefined}
        role="region"
        aria-label={`Now playing: ${currentTrack.title}`}
      >
        {/* Animated progress bar at top */}
        <div
          className="progress-track absolute top-0 left-0 right-0 h-1 cursor-pointer group"
          style={{ backgroundColor: 'rgba(255, 255, 255, 0.1)' }}
          onClick={(e) => {
            e.stopPropagation();
            const rect = e.currentTarget.getBoundingClientRect();
            const percent = (e.clientX - rect.left) / rect.width;
            const newPosition = percent * (currentTrack.duration || 0);
            onControl('seek', newPosition);
          }}
        >
          <div
            className="h-full transition-all duration-100 relative overflow-hidden"
            style={{
              width: `${Math.min(progress, 100)}%`,
              background: `linear-gradient(90deg,
                hsl(${albumColor.h}, ${albumColor.s}%, ${Math.min(albumColor.l + 5, 50)}%) 0%,
                hsl(${albumColor.h}, ${albumColor.s}%, ${Math.min(albumColor.l + 15, 60)}%) 100%)`
            }}
          >
            {/* Glow effect at the end of progress */}
            <div
              className="absolute right-0 top-1/2 -translate-y-1/2 w-2 h-2 rounded-full opacity-0 group-hover:opacity-100 transition-opacity"
              style={{
                backgroundColor: `hsl(${albumColor.h}, ${albumColor.s}%, ${Math.min(albumColor.l + 20, 70)}%)`,
                boxShadow: `0 0 10px hsl(${albumColor.h}, ${albumColor.s}%, ${albumColor.l}%)`
              }}
            />
          </div>
        </div>

        <div className="h-full flex items-center px-3 sm:px-5 gap-3 sm:gap-5">
          {/* Track Info with Album Art Glow */}
          <div className="flex items-center gap-3 sm:gap-4 min-w-0 flex-1 sm:flex-none sm:w-[30%]">
            <div
              className="album-art-glow flex-shrink-0"
              style={{
                '--glow-h': albumColor.h,
                '--glow-s': `${albumColor.s}%`,
                '--glow-l': `${albumColor.l}%`
              }}
            >
              {currentTrack.thumbnail ? (
                <img
                  src={currentTrack.thumbnail}
                  alt=""
                  className={`rounded-lg object-cover flex-shrink-0 transition-all duration-300 ${
                    isExpanded ? 'w-16 h-16' : 'w-12 h-12'
                  }`}
                  style={{
                    boxShadow: `0 4px 16px hsla(${albumColor.h}, ${albumColor.s}%, ${albumColor.l}%, 0.3)`
                  }}
                />
              ) : (
                <div
                  className={`rounded-lg flex items-center justify-center flex-shrink-0 transition-all duration-300 ${
                    isExpanded ? 'w-16 h-16' : 'w-12 h-12'
                  }`}
                  style={{
                    background: `linear-gradient(135deg,
                      hsl(${albumColor.h}, ${albumColor.s}%, ${albumColor.l}%) 0%,
                      hsl(${albumColor.h}, ${albumColor.s}%, ${Math.max(albumColor.l - 15, 15)}%) 100%)`
                  }}
                >
                  <MusicNote size={24} className="text-white/80" />
                </div>
              )}
            </div>

            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <p className="font-medium truncate text-sm" style={{ fontFamily: 'var(--font-heading)' }}>
                  {currentTrack.title}
                </p>
                {playerState.playing && (
                  <WaveformVisualizer isPlaying={playerState.playing} color={albumColor} />
                )}
              </div>
              <p className="text-xs truncate" style={{ color: 'var(--color-text-secondary)' }}>
                {currentTrack.requestedBy && `Requested by ${currentTrack.requestedBy}`}
              </p>

              {/* Expanded info - shows on hover/tap */}
              {isExpanded && (
                <div className="mt-1 flex items-center gap-2 text-xs animate-fade-in" style={{ color: 'var(--color-text-muted)' }}>
                  <span className="font-mono tabular-nums">
                    {formatTime(playerState.position)} / {formatTime(currentTrack.duration)}
                  </span>
                </div>
              )}
            </div>
          </div>

          {/* Playback Controls (center) */}
          <div className="flex items-center justify-center gap-1 sm:gap-3 flex-shrink-0">
            <SkipButton
              direction="previous"
              onClick={() => onControl('previous')}
            />

            <PlayPauseButton
              isPlaying={playerState.playing}
              onClick={() => onControl(playerState.playing ? 'pause' : 'play')}
              glowColor={albumColor}
            />

            <SkipButton
              direction="next"
              onClick={() => onControl('skip')}
            />
          </div>

          {/* Time & Secondary Controls - hidden on mobile */}
          <div className="hidden sm:flex items-center gap-3 w-[30%] justify-end">
            {/* Time display */}
            <span
              className="text-xs tabular-nums font-mono"
              style={{ color: 'var(--color-text-muted)' }}
            >
              {formatTime(playerState.position)} / {formatTime(currentTrack.duration)}
            </span>

            {/* Shuffle */}
            <button
              onClick={() => onControl('shuffle')}
              className={`miniplayer-btn-secondary min-w-[44px] min-h-[44px] flex items-center justify-center ${playerState.shuffle ? 'text-accent' : ''}`}
              style={{
                color: playerState.shuffle
                  ? `hsl(${albumColor.h}, ${albumColor.s}%, ${Math.min(albumColor.l + 10, 55)}%)`
                  : 'var(--color-text-secondary)'
              }}
              title="Shuffle queue"
              aria-label={`Shuffle queue ${playerState.shuffle ? '(on)' : '(off)'}`}
              aria-pressed={playerState.shuffle}
            >
              <Shuffle size={18} aria-hidden="true" />
            </button>

            {/* Loop */}
            <button
              onClick={cycleLoopMode}
              className={`miniplayer-btn-secondary min-w-[44px] min-h-[44px] flex items-center justify-center ${playerState.loop !== 'off' ? 'text-accent' : ''}`}
              style={{
                color: playerState.loop !== 'off'
                  ? `hsl(${albumColor.h}, ${albumColor.s}%, ${Math.min(albumColor.l + 10, 55)}%)`
                  : 'var(--color-text-secondary)'
              }}
              title={`Loop: ${playerState.loop || 'off'}`}
              aria-label={`Loop mode: ${playerState.loop || 'off'}. Click to cycle.`}
              aria-pressed={playerState.loop !== 'off'}
            >
              <Loop size={18} mode={playerState.loop} aria-hidden="true" />
            </button>

            {/* Volume */}
            <CompactVolumeSlider
              value={playerState.volume}
              onChange={handleVolumeChange}
              onMute={handleMute}
              glowColor={albumColor}
            />
          </div>
        </div>
      </div>
    </>
  );
}
