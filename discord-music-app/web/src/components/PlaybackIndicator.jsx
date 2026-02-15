// PlaybackIndicator - Animated wave bars for showing playback state
// Shows pulsing bars when playing, static bars when paused

const sizeConfig = {
  sm: { width: 12, height: 12, barWidth: 2, gap: 1 },
  md: { width: 16, height: 16, barWidth: 3, gap: 1 },
  lg: { width: 24, height: 24, barWidth: 4, gap: 2 },
};

export function PlaybackIndicator({ playing = false, size = 'md', className = '' }) {
  const config = sizeConfig[size] || sizeConfig.md;
  const { width, height, barWidth, gap } = config;

  // Calculate bar positions (4 bars)
  const totalBarsWidth = barWidth * 4 + gap * 3;
  const startX = (width - totalBarsWidth) / 2;

  return (
    <div
      className={`inline-flex items-center justify-center ${className}`}
      style={{ width, height }}
      role="img"
      aria-label={playing ? 'Playing' : 'Paused'}
    >
      <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`}>
        <style>
          {`
            @keyframes playback-bar-1 {
              0%, 100% { height: 40%; }
              50% { height: 100%; }
            }
            @keyframes playback-bar-2 {
              0%, 100% { height: 70%; }
              50% { height: 40%; }
            }
            @keyframes playback-bar-3 {
              0%, 100% { height: 50%; }
              50% { height: 90%; }
            }
            @keyframes playback-bar-4 {
              0%, 100% { height: 60%; }
              50% { height: 30%; }
            }
            .playback-bar {
              fill: currentColor;
              transform-origin: bottom;
            }
            .playback-bar-animated-1 {
              animation: playback-bar-1 0.8s ease-in-out infinite;
            }
            .playback-bar-animated-2 {
              animation: playback-bar-2 0.8s ease-in-out infinite;
              animation-delay: 0.2s;
            }
            .playback-bar-animated-3 {
              animation: playback-bar-3 0.8s ease-in-out infinite;
              animation-delay: 0.4s;
            }
            .playback-bar-animated-4 {
              animation: playback-bar-4 0.8s ease-in-out infinite;
              animation-delay: 0.1s;
            }
          `}
        </style>
        <g transform={`translate(0, ${height})`}>
          {/* Bar 1 */}
          <rect
            x={startX}
            y={0}
            width={barWidth}
            height={playing ? height * 0.4 : height * 0.3}
            className={`playback-bar ${playing ? 'playback-bar-animated-1' : ''}`}
            transform="scale(1, -1)"
          />
          {/* Bar 2 */}
          <rect
            x={startX + barWidth + gap}
            y={0}
            width={barWidth}
            height={playing ? height * 0.7 : height * 0.5}
            className={`playback-bar ${playing ? 'playback-bar-animated-2' : ''}`}
            transform="scale(1, -1)"
          />
          {/* Bar 3 */}
          <rect
            x={startX + (barWidth + gap) * 2}
            y={0}
            width={barWidth}
            height={playing ? height * 0.5 : height * 0.4}
            className={`playback-bar ${playing ? 'playback-bar-animated-3' : ''}`}
            transform="scale(1, -1)"
          />
          {/* Bar 4 */}
          <rect
            x={startX + (barWidth + gap) * 3}
            y={0}
            width={barWidth}
            height={playing ? height * 0.6 : height * 0.35}
            className={`playback-bar ${playing ? 'playback-bar-animated-4' : ''}`}
            transform="scale(1, -1)"
          />
        </g>
      </svg>
    </div>
  );
}
