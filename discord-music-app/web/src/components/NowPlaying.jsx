import { useState, useEffect, useRef, useCallback } from 'react';
import { formatTime } from '../utils/formatTime';
import { Play, Pause, SkipNext, SkipPrevious, Shuffle, Loop, MusicNote } from './icons/index.jsx';
import { PlaybackIndicator } from './PlaybackIndicator';

// Floating music note component for empty state animation
function FloatingNote({ delay, duration, startX, size, opacity }) {
  return (
    <div
      className="absolute pointer-events-none text-accent"
      style={{
        left: `${startX}%`,
        bottom: '-20px',
        opacity: 0,
        animation: `float-up ${duration}s ease-out infinite`,
        animationDelay: `${delay}s`,
      }}
    >
      <MusicNote size={size} style={{ opacity }} />
    </div>
  );
}

// Empty state component with animated floating music notes
function EmptyState() {
  const notes = [
    { delay: 0, duration: 4, startX: 20, size: 24, opacity: 0.6 },
    { delay: 0.8, duration: 3.5, startX: 45, size: 20, opacity: 0.4 },
    { delay: 1.6, duration: 4.5, startX: 70, size: 28, opacity: 0.5 },
    { delay: 2.4, duration: 3.8, startX: 30, size: 22, opacity: 0.45 },
    { delay: 3.2, duration: 4.2, startX: 60, size: 26, opacity: 0.55 },
    { delay: 1.2, duration: 3.6, startX: 80, size: 18, opacity: 0.35 },
  ];

  return (
    <div className="flex flex-col items-center justify-center py-16 px-8 relative">
      {/* Floating music notes animation */}
      <style>
        {`
          @keyframes float-up {
            0% {
              opacity: 0;
              transform: translateY(0) rotate(0deg) scale(0.8);
            }
            10% {
              opacity: 1;
            }
            80% {
              opacity: 0.6;
            }
            100% {
              opacity: 0;
              transform: translateY(-280px) rotate(15deg) scale(1.1);
            }
          }

          @keyframes pulse-ring {
            0%, 100% {
              transform: scale(1);
              opacity: 0.3;
            }
            50% {
              transform: scale(1.15);
              opacity: 0.1;
            }
          }

          @keyframes gentle-bounce {
            0%, 100% {
              transform: translateY(0);
            }
            50% {
              transform: translateY(-8px);
            }
          }
        `}
      </style>

      {/* Album art placeholder with animated rings */}
      <div className="relative mb-10">
        {/* Pulsing rings */}
        <div
          className="absolute inset-0 rounded-2xl bg-accent/10"
          style={{
            animation: 'pulse-ring 3s ease-in-out infinite',
          }}
        />
        <div
          className="absolute inset-0 rounded-2xl bg-accent/5"
          style={{
            animation: 'pulse-ring 3s ease-in-out infinite',
            animationDelay: '1s',
          }}
        />

        {/* Main placeholder */}
        <div className="w-72 h-72 bg-surface-elevated rounded-2xl flex items-center justify-center relative overflow-hidden">
          {/* Floating notes container */}
          <div className="absolute inset-0 overflow-hidden">
            {notes.map((note, i) => (
              <FloatingNote key={i} {...note} />
            ))}
          </div>

          {/* Center icon with gentle bounce */}
          <div
            className="relative z-10"
            style={{ animation: 'gentle-bounce 2s ease-in-out infinite' }}
          >
            <MusicNote size={96} className="text-gray-600" />
          </div>
        </div>
      </div>

      {/* Text content */}
      <h2 className="text-heading text-2xl text-white mb-3">
        Nothing playing
      </h2>
      <p className="text-body text-secondary text-center max-w-sm leading-relaxed">
        Ready when you are. Use <span className="text-mono text-accent">/play</span> in Discord or search above to start the music.
      </p>
    </div>
  );
}

// Extract dominant color from image using canvas
function useImageDominantColor(imageUrl) {
  const [color, setColor] = useState(null);

  useEffect(() => {
    if (!imageUrl) {
      setColor(null);
      return;
    }

    const img = new Image();
    img.crossOrigin = 'Anonymous';
    img.src = imageUrl;

    img.onload = () => {
      try {
        const canvas = document.createElement('canvas');
        const ctx = canvas.getContext('2d');
        canvas.width = 50;
        canvas.height = 50;
        ctx.drawImage(img, 0, 0, 50, 50);

        const imageData = ctx.getImageData(0, 0, 50, 50).data;
        let r = 0, g = 0, b = 0, count = 0;

        // Sample pixels, weighting towards center and avoiding very dark/light pixels
        for (let i = 0; i < imageData.length; i += 16) {
          const red = imageData[i];
          const green = imageData[i + 1];
          const blue = imageData[i + 2];
          const brightness = (red + green + blue) / 3;

          // Skip very dark or very light pixels
          if (brightness > 30 && brightness < 220) {
            // Boost saturation in the selection
            const max = Math.max(red, green, blue);
            const min = Math.min(red, green, blue);
            const saturation = max > 0 ? (max - min) / max : 0;

            if (saturation > 0.15) {
              const weight = saturation * 2;
              r += red * weight;
              g += green * weight;
              b += blue * weight;
              count += weight;
            }
          }
        }

        if (count > 0) {
          r = Math.round(r / count);
          g = Math.round(g / count);
          b = Math.round(b / count);

          // Boost the color saturation a bit for more vibrant glow
          const max = Math.max(r, g, b);
          const boost = 1.3;
          if (max > 0) {
            r = Math.min(255, Math.round(r * boost));
            g = Math.min(255, Math.round(g * boost));
            b = Math.min(255, Math.round(b * boost));
          }

          setColor(`${r}, ${g}, ${b}`);
        } else {
          // Fallback to accent color
          setColor('29, 185, 84');
        }
      } catch {
        setColor('29, 185, 84');
      }
    };

    img.onerror = () => {
      setColor('29, 185, 84');
    };
  }, [imageUrl]);

  return color;
}

export function NowPlaying({ track, playerState, onControl }) {
  const [isPlayPauseActive, setIsPlayPauseActive] = useState(false);
  const [skipDirection, setSkipDirection] = useState(null);
  const [isProgressHovered, setIsProgressHovered] = useState(false);
  const [isDragging, setIsDragging] = useState(false);
  const [isAlbumArtHovered, setIsAlbumArtHovered] = useState(false);
  const progressRef = useRef(null);

  const dominantColor = useImageDominantColor(track?.thumbnail);

  if (!track) {
    return <EmptyState />;
  }

  const progress = track.duration ? (playerState.position / track.duration) * 100 : 0;

  const getAvatarUrl = () => {
    if (!track.requestedById || !track.requestedByAvatar) return null;
    return `https://cdn.discordapp.com/avatars/${track.requestedById}/${track.requestedByAvatar}.png`;
  };

  const avatarUrl = getAvatarUrl();

  // Handle play/pause with animation
  const handlePlayPause = () => {
    setIsPlayPauseActive(true);
    onControl(playerState.playing ? 'pause' : 'play');
    setTimeout(() => setIsPlayPauseActive(false), 200);
  };

  // Handle skip with directional animation
  const handleSkip = (direction) => {
    setSkipDirection(direction);
    onControl(direction === 'next' ? 'skip' : 'previous');
    setTimeout(() => setSkipDirection(null), 250);
  };

  // Progress bar interaction
  const handleProgressClick = (e) => {
    if (!progressRef.current || !track.duration) return;
    const rect = progressRef.current.getBoundingClientRect();
    const percentage = (e.clientX - rect.left) / rect.width;
    const newPosition = Math.max(0, Math.min(1, percentage)) * track.duration;
    onControl('seek', { position: Math.floor(newPosition) });
  };

  return (
    <div className="flex flex-col items-center py-8 px-4 relative">
      {/* CSS for animations */}
      <style>
        {`
          @keyframes vinyl-spin {
            from { transform: rotate(0deg); }
            to { transform: rotate(360deg); }
          }

          @keyframes color-pulse {
            0%, 100% { opacity: 0.5; }
            50% { opacity: 0.7; }
          }

          @keyframes skip-left {
            0% { transform: translateX(0); }
            50% { transform: translateX(-4px); }
            100% { transform: translateX(0); }
          }

          @keyframes skip-right {
            0% { transform: translateX(0); }
            50% { transform: translateX(4px); }
            100% { transform: translateX(0); }
          }

          @keyframes button-press {
            0% { transform: scale(1); }
            50% { transform: scale(0.92); }
            100% { transform: scale(1); }
          }

          .progress-glow {
            box-shadow: 0 0 12px rgba(29, 185, 84, 0.5), 0 0 4px rgba(29, 185, 84, 0.8);
          }

          .progress-thumb-visible::-webkit-slider-thumb {
            opacity: 1 !important;
            transform: scale(1.2);
          }

          .progress-thumb-visible::-moz-range-thumb {
            opacity: 1 !important;
            transform: scale(1.2);
          }
        `}
      </style>

      {/* Album Art with Ambient Lighting */}
      <div className="relative mb-8">
        {/* Ambient glow layer - positioned behind album art */}
        {track.thumbnail && dominantColor && (
          <div
            className="absolute -inset-8 rounded-3xl blur-3xl transition-all duration-1000"
            style={{
              background: `radial-gradient(circle at center, rgba(${dominantColor}, 0.4) 0%, rgba(${dominantColor}, 0.15) 50%, transparent 70%)`,
              animation: playerState.playing ? 'color-pulse 3s ease-in-out infinite' : 'none',
              opacity: playerState.playing ? 1 : 0.5,
            }}
          />
        )}

        {/* Album Art Container */}
        <div
          className="relative cursor-pointer"
          onMouseEnter={() => setIsAlbumArtHovered(true)}
          onMouseLeave={() => setIsAlbumArtHovered(false)}
        >
          {track.thumbnail ? (
            <div className="relative">
              {/* Vinyl record effect behind album art - visible on hover */}
              <div
                className="absolute inset-0 rounded-full bg-gradient-to-br from-gray-800 via-gray-900 to-black transition-all duration-500"
                style={{
                  width: '320px',
                  height: '320px',
                  transform: isAlbumArtHovered
                    ? 'translateX(40px) scale(0.95)'
                    : 'translateX(0) scale(0.9)',
                  opacity: isAlbumArtHovered ? 0.9 : 0,
                  animation: playerState.playing && isAlbumArtHovered
                    ? 'vinyl-spin 3s linear infinite'
                    : 'none',
                }}
              >
                {/* Vinyl grooves */}
                <div className="absolute inset-6 rounded-full border border-gray-700/50" />
                <div className="absolute inset-12 rounded-full border border-gray-700/30" />
                <div className="absolute inset-20 rounded-full border border-gray-700/20" />
                {/* Center label */}
                <div className="absolute inset-0 flex items-center justify-center">
                  <div className="w-24 h-24 rounded-full bg-gradient-to-br from-accent/80 to-accent/40 flex items-center justify-center">
                    <div className="w-4 h-4 rounded-full bg-gray-900" />
                  </div>
                </div>
              </div>

              {/* Main album art image */}
              <img
                src={track.thumbnail}
                alt={track.title}
                className="w-80 h-80 rounded-xl object-cover relative z-10 transition-all duration-300"
                style={{
                  transform: isAlbumArtHovered ? 'scale(1.02)' : 'scale(1)',
                  filter: isAlbumArtHovered ? 'brightness(1.05)' : 'brightness(1)',
                  boxShadow: isAlbumArtHovered
                    ? '0 20px 60px rgba(0,0,0,0.6), 0 8px 24px rgba(0,0,0,0.4)'
                    : '0 8px 24px rgba(0,0,0,0.5)',
                }}
              />
            </div>
          ) : (
            <div className="w-80 h-80 bg-surface-elevated rounded-xl flex items-center justify-center shadow-soft">
              <MusicNote size={80} className="text-gray-600" />
            </div>
          )}

          {/* Playback indicator overlay */}
          {playerState.playing && (
            <div
              className="absolute bottom-4 right-4 bg-black/70 backdrop-blur-sm rounded-lg p-2.5 z-20 transition-all duration-300"
              style={{
                boxShadow: `0 0 20px rgba(${dominantColor || '29, 185, 84'}, 0.3)`,
              }}
            >
              <PlaybackIndicator
                playing={true}
                size="lg"
                className="text-accent"
                glowColor={dominantColor ? `rgb(${dominantColor})` : 'var(--color-accent)'}
              />
            </div>
          )}
        </div>
      </div>

      {/* Track info */}
      <div className="text-center mb-6 max-w-md">
        <h2 className="text-heading text-2xl text-white mb-2 line-clamp-2 tracking-tight">
          {track.title}
        </h2>
        {track.artist && (
          <p className="text-body text-secondary text-lg mb-4">{track.artist}</p>
        )}

        {/* Requested by - more prominent styling */}
        <div className="inline-flex items-center gap-2.5 px-4 py-2 bg-surface-elevated/80 rounded-full border border-white/5">
          <span className="text-label text-muted">Requested by</span>
          {avatarUrl ? (
            <img
              src={avatarUrl}
              alt={track.requestedBy}
              className="w-6 h-6 rounded-full ring-2 ring-accent/30"
            />
          ) : (
            <div className="w-6 h-6 rounded-full bg-accent/20 flex items-center justify-center text-xs font-medium text-accent">
              {track.requestedBy?.charAt(0)?.toUpperCase() || '?'}
            </div>
          )}
          <span className="text-body text-primary font-medium">{track.requestedBy}</span>
        </div>
      </div>

      {/* Progress bar - larger hit area with glow effects */}
      <div className="w-full max-w-md mb-6" role="group" aria-label="Playback progress">
        <div
          ref={progressRef}
          className="relative py-3 -my-3 cursor-pointer group"
          onMouseEnter={() => setIsProgressHovered(true)}
          onMouseLeave={() => {
            if (!isDragging) setIsProgressHovered(false);
          }}
          onClick={handleProgressClick}
          role="slider"
          aria-label="Seek"
          aria-valuemin={0}
          aria-valuemax={track.duration || 0}
          aria-valuenow={playerState.position}
          aria-valuetext={`${formatTime(playerState.position)} of ${formatTime(track.duration)}`}
          tabIndex={0}
          onKeyDown={(e) => {
            if (!track.duration) return;
            const step = track.duration * 0.05; // 5% of total duration
            if (e.key === 'ArrowRight' || e.key === 'ArrowUp') {
              e.preventDefault();
              const newPos = Math.min(track.duration, playerState.position + step);
              onControl('seek', { position: Math.floor(newPos) });
            } else if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') {
              e.preventDefault();
              const newPos = Math.max(0, playerState.position - step);
              onControl('seek', { position: Math.floor(newPos) });
            }
          }}
        >
          {/* Progress track background */}
          <div
            className={`h-1.5 rounded-full bg-surface-elevated transition-all duration-200 ${
              isProgressHovered || isDragging ? 'h-2' : ''
            }`}
          >
            {/* Progress fill */}
            <div
              className={`h-full rounded-full bg-accent transition-all duration-200 relative ${
                isProgressHovered || isDragging ? 'progress-glow' : ''
              }`}
              style={{ width: `${progress}%` }}
            >
              {/* Thumb indicator */}
              <div
                className={`absolute right-0 top-1/2 -translate-y-1/2 w-4 h-4 bg-white rounded-full shadow-lg transition-all duration-200 ${
                  isProgressHovered || isDragging
                    ? 'opacity-100 scale-100'
                    : 'opacity-0 scale-75'
                }`}
                style={{
                  boxShadow: isProgressHovered || isDragging
                    ? '0 0 12px rgba(29, 185, 84, 0.5), 0 2px 8px rgba(0,0,0,0.3)'
                    : '0 2px 4px rgba(0,0,0,0.2)',
                }}
              />
            </div>
          </div>
        </div>

        {/* Time display */}
        <div className="flex justify-between text-mono text-xs text-muted mt-2">
          <span>{formatTime(playerState.position)}</span>
          <span>{formatTime(track.duration)}</span>
        </div>
      </div>

      {/* Playback controls */}
      <div className="flex items-center justify-center gap-4" role="group" aria-label="Playback controls">
        {/* Shuffle */}
        <button
          onClick={() => onControl('shuffle')}
          className={`p-2.5 rounded-full transition-all duration-200 focus-ring min-w-[44px] min-h-[44px] flex items-center justify-center ${
            playerState.shuffle
              ? 'text-accent bg-accent/10'
              : 'text-muted hover:text-primary hover:bg-white/5'
          }`}
          title="Shuffle"
          aria-label={`Shuffle queue ${playerState.shuffle ? '(on)' : '(off)'}`}
          aria-pressed={playerState.shuffle}
        >
          <Shuffle size={20} />
        </button>

        {/* Previous */}
        <button
          onClick={() => handleSkip('prev')}
          className="p-3 text-muted hover:text-primary transition-all duration-200 hover:bg-white/5 rounded-full focus-ring min-w-[44px] min-h-[44px] flex items-center justify-center"
          title="Previous"
          aria-label="Previous track"
          style={{
            animation: skipDirection === 'prev' ? 'skip-left 0.25s ease-out' : 'none',
          }}
        >
          <SkipPrevious size={28} />
        </button>

        {/* Play/Pause - main control */}
        <button
          onClick={handlePlayPause}
          className="w-16 h-16 bg-white rounded-full flex items-center justify-center text-black shadow-lg transition-all duration-200 hover:scale-105 focus-ring"
          title={playerState.playing ? 'Pause' : 'Play'}
          aria-label={playerState.playing ? 'Pause playback' : 'Resume playback'}
          style={{
            animation: isPlayPauseActive ? 'button-press 0.2s ease-out' : 'none',
            boxShadow: isPlayPauseActive
              ? `0 0 30px rgba(${dominantColor || '29, 185, 84'}, 0.5), 0 4px 20px rgba(0,0,0,0.3)`
              : '0 4px 20px rgba(0,0,0,0.3)',
          }}
        >
          {playerState.playing ? (
            <Pause size={28} />
          ) : (
            <Play size={28} className="ml-1" />
          )}
        </button>

        {/* Next */}
        <button
          onClick={() => handleSkip('next')}
          className="p-3 text-muted hover:text-primary transition-all duration-200 hover:bg-white/5 rounded-full focus-ring min-w-[44px] min-h-[44px] flex items-center justify-center"
          title="Next"
          aria-label="Skip to next track"
          style={{
            animation: skipDirection === 'next' ? 'skip-right 0.25s ease-out' : 'none',
          }}
        >
          <SkipNext size={28} />
        </button>

        {/* Loop */}
        <button
          onClick={() => onControl('loop')}
          className={`p-2.5 rounded-full transition-all duration-200 focus-ring min-w-[44px] min-h-[44px] flex items-center justify-center ${
            playerState.loop && playerState.loop !== 'off'
              ? 'text-accent bg-accent/10'
              : 'text-muted hover:text-primary hover:bg-white/5'
          }`}
          title={`Loop: ${playerState.loop || 'off'}`}
          aria-label={`Loop mode: ${playerState.loop || 'off'}`}
          aria-pressed={playerState.loop && playerState.loop !== 'off'}
        >
          <Loop size={20} mode={playerState.loop || 'off'} />
        </button>
      </div>
    </div>
  );
}
