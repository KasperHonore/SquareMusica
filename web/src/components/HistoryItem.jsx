import { formatTime } from '../utils/formatTime';

/**
 * Format a timestamp into a relative or absolute time string
 */
function formatPlayedAt(timestamp) {
  const date = new Date(timestamp);
  const now = new Date();
  const diffMs = now - date;
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMs / 3600000);
  const diffDays = Math.floor(diffMs / 86400000);

  if (diffMins < 1) return 'Just now';
  if (diffMins < 60) return `${diffMins}m ago`;
  if (diffHours < 24) return `${diffHours}h ago`;
  if (diffDays < 7) return `${diffDays}d ago`;

  return date.toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit'
  });
}

/**
 * HistoryItem - Wave result-item row style
 * thumbnail (48x36), title, channel, duration, "+ Add" button
 */
export function HistoryItem({ track, index, onPlayAgain }) {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: '12px',
        padding: '9px 10px',
        borderRadius: '9px',
        cursor: 'pointer',
        transition: 'background 0.1s',
        background: index % 2 !== 0 ? 'rgba(255,255,255,0.02)' : 'transparent',
        animationDelay: `${index * 50}ms`
      }}
      className="wave-result-item"
      onMouseEnter={(e) => {
        e.currentTarget.style.background = 'var(--color-bg-elevated)';
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.background =
          index % 2 !== 0 ? 'rgba(255,255,255,0.02)' : 'transparent';
      }}
    >
      {/* Thumbnail */}
      <div
        style={{
          width: '48px',
          height: '36px',
          borderRadius: '5px',
          flexShrink: 0,
          overflow: 'hidden',
          background: 'var(--color-bg-surface3)'
        }}
      >
        {track.thumbnail ? (
          <img
            src={track.thumbnail}
            alt=""
            loading="lazy"
            style={{ width: '100%', height: '100%', objectFit: 'cover' }}
          />
        ) : (
          <div
            style={{
              width: '100%',
              height: '100%',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              color: 'var(--color-text-muted)',
              fontSize: '14px'
            }}
          >
            &#9835;
          </div>
        )}
      </div>

      {/* Info */}
      <div style={{ flex: 1, minWidth: 0 }}>
        <div
          style={{
            fontSize: '13px',
            fontWeight: 500,
            whiteSpace: 'nowrap',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            color: 'var(--color-text-primary)'
          }}
        >
          {track.title}
        </div>
        <div
          style={{
            fontSize: '11px',
            color: 'var(--color-text-muted)',
            marginTop: '2px',
            display: 'flex',
            alignItems: 'center',
            gap: '6px'
          }}
        >
          {track.channel && <span>{track.channel}</span>}
          {track.played_at && (
            <>
              <span style={{ opacity: 0.5 }}>&bull;</span>
              <span>{formatPlayedAt(track.played_at)}</span>
            </>
          )}
        </div>
      </div>

      {/* Duration */}
      <div
        style={{
          fontSize: '11px',
          color: 'var(--color-text-muted)',
          flexShrink: 0
        }}
      >
        {formatTime(track.duration)}
      </div>

      {/* Add button */}
      <button
        onClick={(e) => {
          e.stopPropagation();
          onPlayAgain(track);
        }}
        style={{
          background: 'rgba(232,200,122,0.1)',
          border: '1px solid rgba(232,200,122,0.2)',
          color: 'var(--color-accent)',
          borderRadius: '6px',
          padding: '5px 10px',
          fontSize: '11px',
          fontWeight: 600,
          cursor: 'pointer',
          fontFamily: 'var(--font-body)',
          transition: 'background 0.12s',
          whiteSpace: 'nowrap',
          flexShrink: 0
        }}
        onMouseEnter={(e) => {
          e.currentTarget.style.background = 'rgba(232,200,122,0.18)';
        }}
        onMouseLeave={(e) => {
          e.currentTarget.style.background = 'rgba(232,200,122,0.1)';
        }}
        title="Add to queue"
        aria-label={`Add ${track.title} to queue`}
      >
        + Add
      </button>
    </div>
  );
}
