import { useEffect, useState } from 'react';
import { MusicNote } from './icons/index.jsx';
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
    <div className="flex flex-col items-center justify-center h-full px-8 relative">
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
      <div className="relative mb-8">
        {/* Pulsing rings */}
        <div
          className="absolute inset-0 rounded-3xl bg-accent/10"
          style={{
            animation: 'pulse-ring 3s ease-in-out infinite',
          }}
        />
        <div
          className="absolute inset-0 rounded-3xl bg-accent/5"
          style={{
            animation: 'pulse-ring 3s ease-in-out infinite',
            animationDelay: '1s',
          }}
        />

        {/* Main placeholder - larger size */}
        <div className="w-80 h-80 md:w-96 md:h-96 bg-surface-elevated rounded-3xl flex items-center justify-center relative overflow-hidden">
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
            <MusicNote size={112} className="text-gray-600" />
          </div>
        </div>
      </div>

      {/* Text content */}
      <h2 className="text-heading text-3xl text-white mb-3">
        Nothing playing
      </h2>
      <p className="text-body text-secondary text-center max-w-md leading-relaxed text-lg">
        Ready when you are. Search for a track above or use{' '}
        <span className="text-mono text-accent">/play</span> in Discord.
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

export function NowPlaying({ track, playerState }) {
  const dominantColor = useImageDominantColor(track?.thumbnail);

  if (!track) {
    return <EmptyState />;
  }

  const getAvatarUrl = () => {
    if (!track.requestedById || !track.requestedByAvatar) return null;
    return `https://cdn.discordapp.com/avatars/${track.requestedById}/${track.requestedByAvatar}.png`;
  };

  const avatarUrl = getAvatarUrl();

  return (
    <div className="relative w-full h-full">
      {/* Hero section with blur atmosphere - full height */}
      <div className="relative h-full w-full overflow-visible">
        {/* Background atmosphere layer - extends beyond container */}
        <div className="absolute inset-0 overflow-hidden">
          {/* Blurred album art background */}
          {track.thumbnail && (
            <div
              className="absolute -inset-20 scale-125 blur-[100px] opacity-70"
              style={{
                backgroundImage: `url(${track.thumbnail})`,
                backgroundSize: 'cover',
                backgroundPosition: 'center',
              }}
            />
          )}
          {/* Softer gradient overlay - gentle fade with soft bottom transition */}
          <div
            className="absolute inset-0"
            style={{
              background: `linear-gradient(to bottom,
                rgba(0,0,0,0.15) 0%,
                rgba(0,0,0,0.25) 30%,
                rgba(0,0,0,0.45) 60%,
                rgba(18,18,18,0.85) 85%,
                rgba(18,18,18,0.95) 100%
              )`,
            }}
          />
          {/* Subtle vignette */}
          <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_top_center,transparent_0%,rgba(0,0,0,0.25)_100%)]" />
        </div>

        {/* Content: Horizontal layout - centered vertically in the hero */}
        <div className="relative z-10 h-full flex flex-row items-center gap-6 md:gap-10 lg:gap-12 px-6 md:px-10 lg:px-16">
          {/* Album Artwork - Left Column */}
          <div className="relative flex-shrink-0">
            {track.thumbnail ? (
              <div className="relative">
                <img
                  src={track.thumbnail}
                  alt={track.title}
                  className="w-44 h-44 sm:w-52 sm:h-52 md:w-60 md:h-60 lg:w-72 lg:h-72 rounded-2xl object-cover ring-1 ring-white/10 shadow-2xl"
                  style={{
                    boxShadow: '0 25px 50px -12px rgba(0, 0, 0, 0.8)',
                  }}
                />
                {/* Playback indicator overlay */}
                {playerState.playing && (
                  <div className="absolute bottom-3 right-3 bg-black/60 backdrop-blur-md rounded-lg p-2">
                    <PlaybackIndicator
                      playing={true}
                      size="lg"
                      className="text-accent"
                      glowColor={dominantColor ? `rgb(${dominantColor})` : 'var(--color-accent)'}
                    />
                  </div>
                )}
              </div>
            ) : (
              <div className="w-44 h-44 sm:w-52 sm:h-52 md:w-60 md:h-60 lg:w-72 lg:h-72 bg-surface-elevated rounded-2xl flex items-center justify-center ring-1 ring-white/10">
                <MusicNote size={72} className="text-gray-600" />
              </div>
            )}
          </div>

          {/* Metadata - Right Column */}
          <div className="relative z-10 flex flex-col justify-center gap-2 md:gap-3 min-w-0 flex-1 max-w-2xl">
            {/* Track Title - Primary focal point */}
            <h2 className="text-heading text-2xl sm:text-3xl md:text-4xl lg:text-5xl text-white font-bold tracking-tight line-clamp-2 leading-[1.1]">
              {track.title}
            </h2>

            {/* Artist/Channel Name - Secondary */}
            {(track.artist || track.channel) && (
              <p className="text-body text-base sm:text-lg md:text-xl text-secondary/90 line-clamp-1">
                {track.artist || track.channel}
              </p>
            )}

            {/* Requested By Pill - Tertiary */}
            <div className="inline-flex items-center gap-2 px-3 py-1.5 bg-white/5 backdrop-blur-sm rounded-full border border-white/10 w-fit mt-1">
              {avatarUrl ? (
                <img
                  src={avatarUrl}
                  alt={track.requestedBy}
                  className="w-5 h-5 rounded-full"
                />
              ) : (
                <div className="w-5 h-5 rounded-full bg-accent/20 flex items-center justify-center text-xs text-accent">
                  {track.requestedBy?.charAt(0)?.toUpperCase() || '?'}
                </div>
              )}
              <span className="text-xs text-muted">Requested by</span>
              <span className="text-sm font-medium text-primary">{track.requestedBy}</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
