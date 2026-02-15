// PlaybackIndicator - Animated wave bars for showing playback state
// Shows pulsing bars when playing, static bars when paused
// Enhanced with glow effects and smoother animations

import { useMemo } from 'react';

const sizeConfig = {
  sm: { width: 14, height: 14, barWidth: 2.5, gap: 1.5 },
  md: { width: 20, height: 20, barWidth: 3.5, gap: 2 },
  lg: { width: 28, height: 28, barWidth: 5, gap: 2.5 },
  xl: { width: 36, height: 36, barWidth: 6, gap: 3 },
};

export function PlaybackIndicator({
  playing = false,
  size = 'md',
  className = '',
  glowColor = 'var(--color-accent)',
  showGlow = true
}) {
  const config = sizeConfig[size] || sizeConfig.md;
  const { width, height, barWidth, gap } = config;

  // Calculate bar positions (4 bars)
  const totalBarsWidth = barWidth * 4 + gap * 3;
  const startX = (width - totalBarsWidth) / 2;

  // Unique ID for this instance's filter
  const filterId = useMemo(() => `glow-${Math.random().toString(36).substr(2, 9)}`, []);

  return (
    <div
      className={`inline-flex items-center justify-center transition-transform duration-200 ${playing ? 'scale-100' : 'scale-95 opacity-70'} ${className}`}
      style={{ width, height }}
      role="img"
      aria-label={playing ? 'Audio is playing' : 'Audio is paused'}
      aria-live="polite"
    >
      <svg
        width={width}
        height={height}
        viewBox={`0 0 ${width} ${height}`}
        style={{ overflow: 'visible' }}
      >
        <defs>
          {/* Glow filter for playing state */}
          {showGlow && (
            <filter id={filterId} x="-50%" y="-50%" width="200%" height="200%">
              <feGaussianBlur stdDeviation="2" result="coloredBlur" />
              <feMerge>
                <feMergeNode in="coloredBlur" />
                <feMergeNode in="SourceGraphic" />
              </feMerge>
            </filter>
          )}
        </defs>

        <style>
          {`
            @keyframes playback-wave-1 {
              0%, 100% { transform: scaleY(0.35); }
              25% { transform: scaleY(0.7); }
              50% { transform: scaleY(1); }
              75% { transform: scaleY(0.55); }
            }
            @keyframes playback-wave-2 {
              0%, 100% { transform: scaleY(0.65); }
              25% { transform: scaleY(0.4); }
              50% { transform: scaleY(0.75); }
              75% { transform: scaleY(1); }
            }
            @keyframes playback-wave-3 {
              0%, 100% { transform: scaleY(0.5); }
              25% { transform: scaleY(0.9); }
              50% { transform: scaleY(0.6); }
              75% { transform: scaleY(0.85); }
            }
            @keyframes playback-wave-4 {
              0%, 100% { transform: scaleY(0.55); }
              25% { transform: scaleY(0.3); }
              50% { transform: scaleY(0.8); }
              75% { transform: scaleY(0.45); }
            }

            .playback-bar {
              fill: currentColor;
              transform-origin: center bottom;
              transition: transform 0.3s ease;
            }

            .playback-bar-wave-1 {
              animation: playback-wave-1 1.2s ease-in-out infinite;
            }
            .playback-bar-wave-2 {
              animation: playback-wave-2 1.2s ease-in-out infinite;
              animation-delay: -0.4s;
            }
            .playback-bar-wave-3 {
              animation: playback-wave-3 1.2s ease-in-out infinite;
              animation-delay: -0.8s;
            }
            .playback-bar-wave-4 {
              animation: playback-wave-4 1.2s ease-in-out infinite;
              animation-delay: -0.2s;
            }
          `}
        </style>

        <g
          filter={playing && showGlow ? `url(#${filterId})` : undefined}
          style={{ color: playing ? glowColor : 'currentColor' }}
        >
          {/* Bar 1 */}
          <rect
            x={startX}
            y={height * 0.15}
            width={barWidth}
            rx={barWidth / 2}
            height={height * 0.7}
            className={`playback-bar ${playing ? 'playback-bar-wave-1' : ''}`}
            style={{
              transform: playing ? undefined : 'scaleY(0.3)',
            }}
          />
          {/* Bar 2 */}
          <rect
            x={startX + barWidth + gap}
            y={height * 0.15}
            width={barWidth}
            rx={barWidth / 2}
            height={height * 0.7}
            className={`playback-bar ${playing ? 'playback-bar-wave-2' : ''}`}
            style={{
              transform: playing ? undefined : 'scaleY(0.5)',
            }}
          />
          {/* Bar 3 */}
          <rect
            x={startX + (barWidth + gap) * 2}
            y={height * 0.15}
            width={barWidth}
            rx={barWidth / 2}
            height={height * 0.7}
            className={`playback-bar ${playing ? 'playback-bar-wave-3' : ''}`}
            style={{
              transform: playing ? undefined : 'scaleY(0.4)',
            }}
          />
          {/* Bar 4 */}
          <rect
            x={startX + (barWidth + gap) * 3}
            y={height * 0.15}
            width={barWidth}
            rx={barWidth / 2}
            height={height * 0.7}
            className={`playback-bar ${playing ? 'playback-bar-wave-4' : ''}`}
            style={{
              transform: playing ? undefined : 'scaleY(0.35)',
            }}
          />
        </g>
      </svg>
    </div>
  );
}
