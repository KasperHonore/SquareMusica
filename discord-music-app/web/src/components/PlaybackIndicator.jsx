/**
 * PlaybackIndicator - Animated EQ bars for showing playback state
 * Wave design: 4 gold bars with staggered animation
 */
export function PlaybackIndicator({
  playing = false,
  size = 'md',
  className = '',
}) {
  const sizeMap = {
    sm: { height: '12px', barWidth: '2.5px', gap: '2px' },
    md: { height: '16px', barWidth: '3px', gap: '2px' },
    lg: { height: '20px', barWidth: '3.5px', gap: '2.5px' },
  };

  const config = sizeMap[size] || sizeMap.md;

  return (
    <span
      className={`eq ${className}`}
      style={{
        height: config.height,
        gap: config.gap,
        display: 'inline-flex',
        alignItems: 'flex-end',
        verticalAlign: 'middle',
      }}
      role="img"
      aria-label={playing ? 'Audio is playing' : 'Audio is paused'}
    >
      {[0, 1, 2, 3].map((i) => (
        <span
          key={i}
          className="eq-bar"
          style={{
            width: config.barWidth,
            animationPlayState: playing ? 'running' : 'paused',
          }}
        />
      ))}
    </span>
  );
}
