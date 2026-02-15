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
 * MiniPlayer - The ONLY playback control surface
 *
 * This is the single source of truth for all playback controls.
 * Following Spotify's design pattern: persistent bottom dock with
 * all controls in one place.
 *
 * Layout:
 * ┌──────────────────────────────────────────────────────────────────┐
 * │ Progress Bar (full width, interactive)                          │
 * ├──────────────────────────────────────────────────────────────────┤
 * │ [Cover] Track – Artist     ⏮  ▶/⏸  ⏭     🔀 🔁    🔊────●── │
 * │          0:00 / 3:45                                            │
 * └──────────────────────────────────────────────────────────────────┘
 */

/**
 * Extract dominant color from album art using canvas
 */
function useAlbumColor(thumbnailUrl) {
  const [color, setColor] = useState({ h: 142, s: 73, l: 40 });

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

        for (let i = 0; i < imageData.length; i += 16) {
          const pr = imageData[i];
          const pg = imageData[i + 1];
          const pb = imageData[i + 2];
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

          setColor({
            h: Math.round(h * 360),
            s: Math.min(100, Math.round(s * 100) + 20),
            l: Math.round(l * 100)
          });
        }
      } catch {
        setColor({ h: 142, s: 73, l: 40 });
      }
    };

    img.onerror = () => setColor({ h: 142, s: 73, l: 40 });
    img.src = thumbnailUrl;
  }, [thumbnailUrl]);

  return color;
}

/**
 * Waveform visualization component
 */
function WaveformVisualizer({ isPlaying, color }) {
  return (
    <div className="flex items-end gap-[3px] h-4">
      {Array.from({ length: 4 }).map((_, i) => (
        <div
          key={i}
          className={`w-[3px] rounded-full transition-all duration-300 ${isPlaying ? 'animate-wave' : ''}`}
          style={{
            backgroundColor: `hsl(${color.h}, ${color.s}%, ${Math.min(color.l + 15, 70)}%)`,
            animationDelay: isPlaying ? `${i * 0.12}s` : '0s',
            height: isPlaying ? undefined : '4px'
          }}
        />
      ))}
    </div>
  );
}

/**
 * Interactive progress bar with seek functionality
 */
function ProgressBar({ progress, duration, position, onSeek, albumColor, isPlaying }) {
  const [isHovered, setIsHovered] = useState(false);
  const [isDragging, setIsDragging] = useState(false);
  const [hoverPosition, setHoverPosition] = useState(0);
  const barRef = useRef(null);

  const handleClick = useCallback((e) => {
    if (!barRef.current || !duration) return;
    const rect = barRef.current.getBoundingClientRect();
    const percent = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    onSeek(percent * duration);
  }, [duration, onSeek]);

  const handleMouseMove = useCallback((e) => {
    if (!barRef.current) return;
    const rect = barRef.current.getBoundingClientRect();
    const percent = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    setHoverPosition(percent * 100);
  }, []);

  const active = isHovered || isDragging;

  return (
    <div
      ref={barRef}
      className="absolute top-0 left-0 right-0 h-1.5 cursor-pointer group transition-all duration-200"
      style={{
        height: active ? '6px' : '4px',
        backgroundColor: 'rgba(255, 255, 255, 0.1)'
      }}
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
      onMouseMove={handleMouseMove}
      onClick={handleClick}
      role="slider"
      aria-label="Seek"
      aria-valuemin={0}
      aria-valuemax={duration || 0}
      aria-valuenow={position}
      aria-valuetext={`${formatTime(position)} of ${formatTime(duration)}`}
      tabIndex={0}
      onKeyDown={(e) => {
        if (!duration) return;
        const step = duration * 0.05;
        if (e.key === 'ArrowRight') {
          e.preventDefault();
          onSeek(Math.min(duration, position + step));
        } else if (e.key === 'ArrowLeft') {
          e.preventDefault();
          onSeek(Math.max(0, position - step));
        }
      }}
    >
      {/* Hover time tooltip */}
      {active && duration > 0 && (
        <div
          className="absolute bottom-full mb-2 px-2 py-1 rounded text-xs font-mono bg-surface-elevated text-primary pointer-events-none transform -translate-x-1/2 transition-opacity duration-150"
          style={{
            left: `${hoverPosition}%`,
            opacity: active ? 1 : 0
          }}
        >
          {formatTime((hoverPosition / 100) * duration)}
        </div>
      )}

      {/* Progress fill */}
      <div
        className="h-full relative transition-all duration-100"
        style={{
          width: `${Math.min(progress, 100)}%`,
          background: `linear-gradient(90deg,
            hsl(${albumColor.h}, ${albumColor.s}%, ${Math.min(albumColor.l + 5, 50)}%) 0%,
            hsl(${albumColor.h}, ${albumColor.s}%, ${Math.min(albumColor.l + 15, 60)}%) 100%)`,
          boxShadow: active
            ? `0 0 10px hsla(${albumColor.h}, ${albumColor.s}%, ${albumColor.l}%, 0.5)`
            : 'none'
        }}
      >
        {/* Thumb indicator */}
        <div
          className={`absolute right-0 top-1/2 -translate-y-1/2 rounded-full bg-white transition-all duration-200 ${
            active ? 'opacity-100 scale-100' : 'opacity-0 scale-0'
          }`}
          style={{
            width: active ? '12px' : '8px',
            height: active ? '12px' : '8px',
            boxShadow: `0 0 8px hsla(${albumColor.h}, ${albumColor.s}%, ${albumColor.l}%, 0.6), 0 2px 4px rgba(0,0,0,0.3)`
          }}
        />
      </div>
    </div>
  );
}

/**
 * Volume control with slider
 */
function VolumeControl({ value, onChange, onMute, glowColor }) {
  const [showSlider, setShowSlider] = useState(false);
  const [prevVolume, setPrevVolume] = useState(100);

  const VolumeIcon = value === 0 ? VolumeMute : value < 50 ? VolumeLow : VolumeHigh;

  const handleMute = () => {
    if (value > 0) {
      setPrevVolume(value);
      onMute(0);
    } else {
      onMute(prevVolume);
    }
  };

  return (
    <div
      className="relative flex items-center gap-2"
      onMouseEnter={() => setShowSlider(true)}
      onMouseLeave={() => setShowSlider(false)}
    >
      <button
        onClick={handleMute}
        className="miniplayer-btn-icon"
        title={value === 0 ? 'Unmute' : 'Mute'}
        aria-label={value === 0 ? 'Unmute' : `Mute (volume ${value}%)`}
      >
        <VolumeIcon size={20} />
      </button>

      {/* Volume slider - always visible on desktop, hover on mobile */}
      <div className={`hidden sm:flex items-center gap-2 transition-all duration-200 ${showSlider ? 'opacity-100' : 'opacity-70'}`}>
        <input
          type="range"
          min="0"
          max="100"
          value={value}
          onChange={(e) => onChange(parseInt(e.target.value))}
          className="volume-slider-dock w-20"
          style={{
            '--thumb-color': `hsl(${glowColor.h}, ${glowColor.s}%, ${Math.min(glowColor.l + 10, 60)}%)`
          }}
          aria-label="Volume"
        />
        <span className="text-xs font-mono text-muted w-8">{value}%</span>
      </div>
    </div>
  );
}

/**
 * Main control button (Play/Pause)
 */
function PlayPauseButton({ isPlaying, onClick, glowColor, size = 'normal' }) {
  const [isPressed, setIsPressed] = useState(false);

  const handleClick = () => {
    setIsPressed(true);
    onClick();
    setTimeout(() => setIsPressed(false), 150);
  };

  const buttonSize = size === 'large' ? 'w-14 h-14' : 'w-11 h-11';
  const iconSize = size === 'large' ? 24 : 20;

  return (
    <button
      onClick={handleClick}
      className={`${buttonSize} rounded-full flex items-center justify-center text-black transition-all duration-200 ${
        isPressed ? 'scale-90' : 'hover:scale-105'
      }`}
      style={{
        background: `linear-gradient(135deg,
          hsl(${glowColor.h}, ${glowColor.s}%, ${Math.min(glowColor.l + 15, 60)}%) 0%,
          hsl(${glowColor.h}, ${glowColor.s}%, ${Math.max(glowColor.l, 35)}%) 100%)`,
        boxShadow: `0 4px 20px hsla(${glowColor.h}, ${glowColor.s}%, ${glowColor.l}%, 0.4)`
      }}
      title={isPlaying ? 'Pause' : 'Play'}
      aria-label={isPlaying ? 'Pause playback' : 'Resume playback'}
    >
      {isPlaying ? <Pause size={iconSize} /> : <Play size={iconSize} className="ml-0.5" />}
    </button>
  );
}

/**
 * Skip button with animation
 */
function SkipButton({ direction, onClick, disabled }) {
  const [isAnimating, setIsAnimating] = useState(false);
  const Icon = direction === 'next' ? SkipNext : SkipPrevious;

  const handleClick = () => {
    if (disabled) return;
    setIsAnimating(true);
    onClick();
    setTimeout(() => setIsAnimating(false), 200);
  };

  return (
    <button
      onClick={handleClick}
      disabled={disabled}
      className="miniplayer-btn-icon"
      style={{
        transform: isAnimating
          ? direction === 'next' ? 'translateX(2px)' : 'translateX(-2px)'
          : 'translateX(0)'
      }}
      title={direction === 'next' ? 'Next track' : 'Previous track'}
      aria-label={direction === 'next' ? 'Skip to next track' : 'Go to previous track'}
    >
      <Icon size={22} />
    </button>
  );
}

/**
 * Toggle button for shuffle/loop
 */
function ToggleButton({ active, onClick, icon: Icon, title, ariaLabel, glowColor, mode }) {
  return (
    <button
      onClick={onClick}
      className={`miniplayer-btn-icon ${active ? 'active' : ''}`}
      style={{
        color: active
          ? `hsl(${glowColor.h}, ${glowColor.s}%, ${Math.min(glowColor.l + 15, 60)}%)`
          : 'var(--color-text-secondary)',
        backgroundColor: active ? `hsla(${glowColor.h}, ${glowColor.s}%, ${glowColor.l}%, 0.15)` : 'transparent'
      }}
      title={title}
      aria-label={ariaLabel}
      aria-pressed={active}
    >
      <Icon size={18} mode={mode} />
    </button>
  );
}

export function MiniPlayer({ currentTrack, playerState, onControl }) {
  const [isMobile, setIsMobile] = useState(false);
  const albumColor = useAlbumColor(currentTrack?.thumbnail);

  useEffect(() => {
    const checkMobile = () => setIsMobile(window.innerWidth < 640);
    checkMobile();
    window.addEventListener('resize', checkMobile);
    return () => window.removeEventListener('resize', checkMobile);
  }, []);

  if (!currentTrack) return null;

  const progress = currentTrack.duration
    ? (playerState.position / currentTrack.duration) * 100
    : 0;

  const handleSeek = (position) => {
    onControl('seek', Math.floor(position));
  };

  const handleVolumeChange = (value) => {
    onControl('volume', value);
  };

  const cycleLoopMode = () => {
    const modes = ['off', 'track', 'queue'];
    const currentIndex = modes.indexOf(playerState.loop || 'off');
    const nextIndex = (currentIndex + 1) % modes.length;
    onControl('loop', modes[nextIndex]);
  };

  return (
    <>
      <style>{`
        .miniplayer-dock {
          background: linear-gradient(
            180deg,
            rgba(40, 40, 40, 0.92) 0%,
            rgba(24, 24, 24, 0.98) 100%
          );
          backdrop-filter: blur(24px) saturate(180%);
          -webkit-backdrop-filter: blur(24px) saturate(180%);
        }

        .miniplayer-btn-icon {
          padding: 10px;
          border-radius: 9999px;
          color: var(--color-text-secondary);
          transition: all 200ms cubic-bezier(0.4, 0, 0.2, 1);
          min-width: 44px;
          min-height: 44px;
          display: flex;
          align-items: center;
          justify-content: center;
        }

        .miniplayer-btn-icon:hover {
          background: rgba(255, 255, 255, 0.1);
          color: var(--color-text-primary);
          transform: scale(1.05);
        }

        .miniplayer-btn-icon:active {
          transform: scale(0.95);
        }

        .miniplayer-btn-icon.active {
          position: relative;
        }

        .miniplayer-btn-icon.active::after {
          content: '';
          position: absolute;
          bottom: 6px;
          left: 50%;
          transform: translateX(-50%);
          width: 4px;
          height: 4px;
          border-radius: 50%;
          background: currentColor;
        }

        .volume-slider-dock {
          -webkit-appearance: none;
          appearance: none;
          height: 4px;
          border-radius: 2px;
          background: rgba(255, 255, 255, 0.2);
          cursor: pointer;
        }

        .volume-slider-dock::-webkit-slider-thumb {
          -webkit-appearance: none;
          width: 12px;
          height: 12px;
          border-radius: 50%;
          background: var(--thumb-color, var(--color-accent));
          cursor: pointer;
          transition: transform 0.15s ease, box-shadow 0.15s ease;
          box-shadow: 0 1px 4px rgba(0, 0, 0, 0.3);
        }

        .volume-slider-dock::-webkit-slider-thumb:hover {
          transform: scale(1.2);
        }

        .volume-slider-dock::-moz-range-thumb {
          width: 12px;
          height: 12px;
          border-radius: 50%;
          background: var(--thumb-color, var(--color-accent));
          border: none;
          cursor: pointer;
        }

        @keyframes wave {
          0%, 100% { transform: scaleY(0.4); }
          50% { transform: scaleY(1); }
        }

        .animate-wave {
          animation: wave 0.8s ease-in-out infinite;
        }
      `}</style>

      <div
        className="miniplayer-dock fixed bottom-0 left-0 right-0 lg:left-60 lg:right-80 z-50 border-t lg:rounded-t-xl"
        style={{
          borderColor: 'rgba(255, 255, 255, 0.1)',
          boxShadow: 'inset 0 1px 0 rgba(255, 255, 255, 0.05)'
        }}
        role="region"
        aria-label={`Now playing: ${currentTrack.title}`}
      >
        {/* Progress bar at top */}
        <ProgressBar
          progress={progress}
          duration={currentTrack.duration}
          position={playerState.position}
          onSeek={handleSeek}
          albumColor={albumColor}
          isPlaying={playerState.playing}
        />

        {/* Main content - 3 column layout: track info | controls | volume */}
        <div className="h-[72px] flex items-center px-4 sm:px-6">
          {/* Track info section - left, fixed width */}
          <div className="flex items-center gap-3 sm:gap-4 min-w-0 w-[30%] max-w-[300px]">
            {/* Album art with glow */}
            <div className="relative flex-shrink-0">
              {currentTrack.thumbnail ? (
                <img
                  src={currentTrack.thumbnail}
                  alt=""
                  className="w-12 h-12 sm:w-14 sm:h-14 rounded-lg object-cover"
                  style={{
                    boxShadow: `0 4px 16px hsla(${albumColor.h}, ${albumColor.s}%, ${albumColor.l}%, 0.35)`
                  }}
                />
              ) : (
                <div
                  className="w-12 h-12 sm:w-14 sm:h-14 rounded-lg flex items-center justify-center"
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

            {/* Track details */}
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <p className="font-semibold truncate text-sm sm:text-base" style={{ fontFamily: 'var(--font-heading)' }}>
                  {currentTrack.title}
                </p>
                {playerState.playing && !isMobile && (
                  <WaveformVisualizer isPlaying={playerState.playing} color={albumColor} />
                )}
              </div>
              <div className="flex items-center gap-2 text-xs sm:text-sm" style={{ color: 'var(--color-text-secondary)' }}>
                {currentTrack.artist && <span className="truncate">{currentTrack.artist}</span>}
                {currentTrack.artist && <span className="text-muted">•</span>}
                <span className="font-mono text-xs text-muted tabular-nums whitespace-nowrap">
                  {formatTime(playerState.position)} / {formatTime(currentTrack.duration)}
                </span>
              </div>
            </div>
          </div>

          {/* Playback controls - center, takes remaining space */}
          <div className="flex-1 flex items-center justify-center gap-1 sm:gap-2">
            {/* Shuffle - hidden on mobile */}
            <div className="hidden sm:block">
              <ToggleButton
                active={playerState.shuffle}
                onClick={() => onControl('shuffle')}
                icon={Shuffle}
                title={`Shuffle ${playerState.shuffle ? 'on' : 'off'}`}
                ariaLabel={`Shuffle queue (${playerState.shuffle ? 'on' : 'off'})`}
                glowColor={albumColor}
              />
            </div>

            <SkipButton
              direction="previous"
              onClick={() => onControl('previous')}
            />

            <PlayPauseButton
              isPlaying={playerState.playing}
              onClick={() => onControl(playerState.playing ? 'pause' : 'play')}
              glowColor={albumColor}
              size={isMobile ? 'normal' : 'large'}
            />

            <SkipButton
              direction="next"
              onClick={() => onControl('skip')}
            />

            {/* Loop - hidden on mobile */}
            <div className="hidden sm:block">
              <ToggleButton
                active={playerState.loop && playerState.loop !== 'off'}
                onClick={cycleLoopMode}
                icon={Loop}
                mode={playerState.loop}
                title={`Loop: ${playerState.loop || 'off'}`}
                ariaLabel={`Loop mode: ${playerState.loop || 'off'}`}
                glowColor={albumColor}
              />
            </div>
          </div>

          {/* Volume - right, fixed width (hidden on mobile) */}
          <div className="hidden sm:flex items-center justify-end w-[30%] max-w-[300px]">
            <VolumeControl
              value={playerState.volume}
              onChange={handleVolumeChange}
              onMute={handleVolumeChange}
              glowColor={albumColor}
            />
          </div>
        </div>
      </div>
    </>
  );
}
