import { formatTime } from '../utils/formatTime';
import { UserAvatar } from './UserAvatar';
import { Play } from './icons';

/**
 * Format a timestamp into a relative or absolute time string
 * @param {string} timestamp - ISO timestamp
 * @returns {string} Formatted time string
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
 * HistoryItem component matching Queue styling
 */
export function HistoryItem({ track, index, onPlayAgain }) {
  // Calculate staggered animation delay
  const animationDelay = `${index * 50}ms`;

  // Alternating background tint for scanability
  const isEven = index % 2 === 0;

  // Build class names based on state
  const containerClasses = [
    'flex items-start gap-3 p-2.5 rounded-lg',
    'transition-all duration-200',
    'group relative',
    // Staggered fade-in animation on initial render
    'animate-queue-item-in',
    // Alternating backgrounds - subtle
    isEven ? '' : 'bg-white/[0.02]',
    // Hover effect
    'hover:bg-white/[0.05]',
  ].filter(Boolean).join(' ');

  return (
    <article
      className={containerClasses}
      style={{
        '--animation-delay': animationDelay,
        animationDelay: animationDelay,
      }}
      aria-label={`${track.title}, played ${formatPlayedAt(track.played_at)}`}
      role="listitem"
    >
      {/* Thumbnail */}
      {track.thumbnail ? (
        <img
          src={track.thumbnail}
          alt=""
          className="w-11 h-11 rounded-md object-cover flex-shrink-0"
        />
      ) : (
        <div className="w-11 h-11 rounded-md bg-surface-elevated flex items-center justify-center flex-shrink-0">
          <span className="text-text-muted text-lg">&#9835;</span>
        </div>
      )}

      {/* Track info */}
      <div className="flex-1 min-w-0 pt-0.5">
        <p className="truncate font-medium text-sm text-primary">
          {track.title}
        </p>
        <div className="flex items-center gap-1.5 text-text-muted text-xs mt-0.5">
          <span className="text-mono">{formatTime(track.duration, '--:--')}</span>
          <span className="text-text-muted/50">&#8226;</span>
          <span className="text-secondary">{formatPlayedAt(track.played_at)}</span>
        </div>
        {track.requested_by && (
          <div className="flex items-center gap-1.5 text-xs mt-1 text-text-muted">
            <UserAvatar
              userId={track.requested_by_id}
              avatarHash={track.requested_by_avatar}
              username={track.requested_by}
              size={14}
            />
            <span className="truncate">{track.requested_by}</span>
          </div>
        )}
      </div>

      {/* Play again button - hover revealed */}
      <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 focus-within:opacity-100 transition-opacity duration-150">
        <button
          onClick={() => onPlayAgain(track)}
          className="text-text-muted hover:text-accent transition-colors p-1.5 rounded hover:bg-accent/10 focus-ring min-w-[32px] min-h-[32px] flex items-center justify-center"
          title="Play again"
          aria-label={`Play ${track.title} again`}
        >
          <Play size={14} aria-hidden="true" />
        </button>
      </div>
    </article>
  );
}
