import { useState, useEffect } from 'react';
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
    <div className="flex flex-col items-center justify-center h-full min-h-[60vh] px-8 relative">
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
  const [isAlbumArtHovered, setIsAlbumArtHovered] = useState(false);

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
    <div className="flex flex-col items-center justify-center min-h-[60vh] px-4 relative">
      {/* CSS for animations */}
      <style>
        {`
          @keyframes vinyl-spin {
            from { transform: rotate(0deg); }
            to { transform: rotate(360deg); }
          }

          @keyframes color-pulse {
            0%, 100% { opacity: 0.5; }
            50% { opacity: 0.8; }
          }

          @keyframes subtle-float {
            0%, 100% { transform: translateY(0); }
            50% { transform: translateY(-6px); }
          }
        `}
      </style>

      {/* Album Art with Ambient Lighting - INCREASED SIZE */}
      <div className="relative mb-8">
        {/* Ambient glow layer - larger and more dramatic */}
        {track.thumbnail && dominantColor && (
          <div
            className="absolute -inset-12 rounded-[40px] blur-[60px] transition-all duration-1000"
            style={{
              background: `radial-gradient(circle at center, rgba(${dominantColor}, 0.5) 0%, rgba(${dominantColor}, 0.2) 40%, transparent 70%)`,
              animation: playerState.playing ? 'color-pulse 4s ease-in-out infinite' : 'none',
              opacity: playerState.playing ? 1 : 0.6,
            }}
          />
        )}

        {/* Album Art Container - LARGER */}
        <div
          className="relative"
          onMouseEnter={() => setIsAlbumArtHovered(true)}
          onMouseLeave={() => setIsAlbumArtHovered(false)}
        >
          {track.thumbnail ? (
            <div className="relative">
              {/* Vinyl record effect behind album art - visible on hover */}
              <div
                className="absolute rounded-full bg-gradient-to-br from-gray-800 via-gray-900 to-black transition-all duration-500"
                style={{
                  width: '420px',
                  height: '420px',
                  top: '10px',
                  left: '10px',
                  transform: isAlbumArtHovered
                    ? 'translateX(50px) scale(0.95)'
                    : 'translateX(0) scale(0.9)',
                  opacity: isAlbumArtHovered ? 0.9 : 0,
                  animation: playerState.playing && isAlbumArtHovered
                    ? 'vinyl-spin 3s linear infinite'
                    : 'none',
                }}
              >
                {/* Vinyl grooves */}
                <div className="absolute inset-8 rounded-full border border-gray-700/50" />
                <div className="absolute inset-16 rounded-full border border-gray-700/30" />
                <div className="absolute inset-24 rounded-full border border-gray-700/20" />
                <div className="absolute inset-32 rounded-full border border-gray-700/10" />
                {/* Center label */}
                <div className="absolute inset-0 flex items-center justify-center">
                  <div className="w-28 h-28 rounded-full bg-gradient-to-br from-accent/80 to-accent/40 flex items-center justify-center">
                    <div className="w-5 h-5 rounded-full bg-gray-900" />
                  </div>
                </div>
              </div>

              {/* Main album art image - INCREASED SIZE (30-40% larger: 320px -> 440px) */}
              <img
                src={track.thumbnail}
                alt={track.title}
                className="w-[340px] h-[340px] md:w-[420px] md:h-[420px] rounded-2xl object-cover relative z-10 transition-all duration-500"
                style={{
                  transform: isAlbumArtHovered ? 'scale(1.02)' : 'scale(1)',
                  filter: isAlbumArtHovered ? 'brightness(1.05)' : 'brightness(1)',
                  boxShadow: isAlbumArtHovered
                    ? `0 30px 80px rgba(0,0,0,0.7), 0 10px 30px rgba(0,0,0,0.5), 0 0 60px rgba(${dominantColor || '29, 185, 84'}, 0.2)`
                    : '0 12px 40px rgba(0,0,0,0.6)',
                  animation: playerState.playing ? 'subtle-float 6s ease-in-out infinite' : 'none',
                }}
              />
            </div>
          ) : (
            <div className="w-[340px] h-[340px] md:w-[420px] md:h-[420px] bg-surface-elevated rounded-2xl flex items-center justify-center shadow-soft">
              <MusicNote size={100} className="text-gray-600" />
            </div>
          )}

          {/* Playback indicator overlay */}
          {playerState.playing && (
            <div
              className="absolute bottom-5 right-5 bg-black/80 backdrop-blur-md rounded-xl p-3 z-20 transition-all duration-300"
              style={{
                boxShadow: `0 0 30px rgba(${dominantColor || '29, 185, 84'}, 0.4)`,
              }}
            >
              <PlaybackIndicator
                playing={true}
                size="xl"
                className="text-accent"
                glowColor={dominantColor ? `rgb(${dominantColor})` : 'var(--color-accent)'}
              />
            </div>
          )}
        </div>
      </div>

      {/* Track info - ENHANCED */}
      <div className="text-center max-w-lg">
        <h2 className="text-heading text-2xl md:text-3xl text-white mb-3 line-clamp-2 tracking-tight leading-tight">
          {track.title}
        </h2>
        {track.artist && (
          <p className="text-body text-secondary text-lg md:text-xl mb-5">{track.artist}</p>
        )}

        {/* Requested by - elegant pill design */}
        <div className="inline-flex items-center gap-3 px-5 py-2.5 bg-surface-elevated/60 backdrop-blur-sm rounded-full border border-white/5 transition-all duration-300 hover:bg-surface-elevated/80">
          <span className="text-label text-muted text-xs">Requested by</span>
          {avatarUrl ? (
            <img
              src={avatarUrl}
              alt={track.requestedBy}
              className="w-7 h-7 rounded-full ring-2 ring-accent/40"
            />
          ) : (
            <div className="w-7 h-7 rounded-full bg-accent/20 flex items-center justify-center text-sm font-medium text-accent">
              {track.requestedBy?.charAt(0)?.toUpperCase() || '?'}
            </div>
          )}
          <span className="text-body text-primary font-medium">{track.requestedBy}</span>
        </div>
      </div>
    </div>
  );
}
