import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { formatTime } from '../utils/formatTime';
import { Remove } from './icons';
import { UserAvatar } from './UserAvatar';

/**
 * Spotify icon SVG component
 */
function SpotifyIcon({ className = '', color = 'currentColor' }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill={color}
      width="16"
      height="16"
    >
      <path d="M12 0C5.4 0 0 5.4 0 12s5.4 12 12 12 12-5.4 12-12S18.66 0 12 0zm5.521 17.34c-.24.359-.66.48-1.021.24-2.82-1.74-6.36-2.101-10.561-1.141-.418.122-.779-.179-.899-.539-.12-.421.18-.78.54-.9 4.56-1.021 8.52-.6 11.64 1.32.42.18.479.659.301 1.02zm1.44-3.3c-.301.42-.841.6-1.262.3-3.239-1.98-8.159-2.58-11.939-1.38-.479.12-1.02-.12-1.14-.6-.12-.48.12-1.021.6-1.141C9.6 9.9 15 10.561 18.72 12.84c.361.181.54.78.241 1.2zm.12-3.36C15.24 8.4 8.82 8.16 5.16 9.301c-.6.179-1.2-.181-1.38-.721-.18-.601.18-1.2.72-1.381 4.26-1.26 11.28-1.02 15.721 1.621.539.3.719 1.02.419 1.56-.299.421-1.02.599-1.559.3z"/>
    </svg>
  );
}

/**
 * Loading spinner component
 */
function Spinner({ className = '' }) {
  return (
    <svg
      className={`animate-spin ${className}`}
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
    >
      <circle
        className="opacity-25"
        cx="12"
        cy="12"
        r="10"
        stroke="currentColor"
        strokeWidth="4"
      />
      <path
        className="opacity-75"
        fill="currentColor"
        d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
      />
    </svg>
  );
}


/**
 * Get status indicator for a track
 */
function getStatusIndicator(track) {
  // If track has URL and isn't failed, it's resolved (no indicator needed)
  if (track.url && track.status !== 'failed') {
    return null;
  }

  // Only show indicator for Spotify tracks
  if (!track.spotifyData) {
    return null;
  }

  const status = track.status || 'unresolved';

  switch (status) {
    case 'resolving':
      return {
        icon: (
          <div className="flex items-center gap-1">
            <SpotifyIcon className="text-green-500" color="#1DB954" />
            <Spinner className="text-green-500" />
          </div>
        ),
        className: '',
        tooltip: 'Searching YouTube...'
      };
    case 'pending':
      return {
        icon: <SpotifyIcon className="text-green-500 animate-pulse" color="#1DB954" />,
        className: '',
        tooltip: 'Waiting to resolve...'
      };
    case 'failed':
      return {
        icon: <SpotifyIcon className="text-red-500" color="#ef4444" />,
        className: 'line-through opacity-60',
        tooltip: 'Could not find on YouTube'
      };
    case 'unresolved':
    default:
      return {
        icon: <SpotifyIcon className="text-green-500" color="#1DB954" />,
        className: '',
        tooltip: 'From Spotify - not yet matched'
      };
  }
}

export function QueueItem({
  track,
  index,
  trackId,
  onRemove,
  isUpNext = false,
  isRemoving = false,
  isDraggingActive = false,
  isBeingDragged = false,
  isOverlay = false,
}) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
    over,
  } = useSortable({ id: trackId, disabled: isOverlay });

  // Calculate staggered animation delay
  const animationDelay = `${index * 50}ms`;

  // Build transform and transition styles
  const style = {
    transform: CSS.Transform.toString(transform),
    transition: isOverlay ? undefined : transition,
    // Stagger fade-in animation
    '--animation-delay': animationDelay,
    animationDelay: animationDelay,
  };

  // Determine if this item is a drop target
  const isDropTarget = isDraggingActive && !isBeingDragged && over?.id === trackId;

  const statusIndicator = getStatusIndicator(track);
  const isFailed = track.status === 'failed';

  // Alternating background tint for scanability
  const isEven = index % 2 === 0;

  // Build class names based on state
  const containerClasses = [
    'queue-item',
    'flex items-start gap-3 p-2.5 rounded-lg',
    'transition-all duration-200',
    'group relative',
    // Staggered fade-in animation on initial render
    !isOverlay && 'animate-queue-item-in',
    // Alternating backgrounds - subtle
    isEven ? '' : 'bg-white/[0.02]',
    // Hover effect
    !isDragging && !isOverlay && 'hover:bg-white/[0.05]',
    // Dragging states
    isDragging && 'opacity-40 scale-95',
    isBeingDragged && 'ring-2 ring-accent/50',
    // Drop target indicator
    isDropTarget && 'queue-item-drop-target',
    // Removing animation
    isRemoving && 'animate-queue-item-out',
    // Overlay styling
    isOverlay && 'shadow-2xl ring-2 ring-accent scale-105 bg-surface-raised',
    // Failed track styling
    isFailed && 'opacity-60',
    // Draggable cursor
    !isOverlay && 'cursor-grab active:cursor-grabbing',
  ].filter(Boolean).join(' ');

  return (
    <div
      ref={!isOverlay ? setNodeRef : undefined}
      style={style}
      className={containerClasses}
      role="listitem"
      aria-label={`${isUpNext ? 'Up next: ' : ''}${track.title}${track.duration ? `, duration ${formatTime(track.duration, '')}` : ''}`}
      {...(!isOverlay ? attributes : {})}
      {...(!isOverlay ? listeners : {})}
    >
      {/* Drop zone indicator line */}
      {isDropTarget && (
        <div className="absolute -top-1 left-0 right-0 h-0.5 bg-accent rounded-full shadow-[0_0_8px_rgba(29,185,84,0.6)]" />
      )}

      {/* Thumbnail */}
      {track.thumbnail ? (
        <img
          src={track.thumbnail}
          alt=""
          className="w-11 h-11 rounded-md object-cover flex-shrink-0"
        />
      ) : (
        <div className="w-11 h-11 rounded-md bg-surface-elevated flex items-center justify-center flex-shrink-0">
          {statusIndicator?.icon || (
            <span className="text-text-muted text-lg">&#9835;</span>
          )}
        </div>
      )}

      {/* Track info */}
      <div className="flex-1 min-w-0 pt-0.5">
        <div className="flex items-center gap-2">
          {statusIndicator && track.thumbnail && (
            <span title={statusIndicator.tooltip} className="flex-shrink-0">
              {statusIndicator.icon}
            </span>
          )}
          <p className={`truncate font-medium text-sm text-primary ${statusIndicator?.className || ''}`}>
            {track.title}
          </p>
        </div>
        <div className="flex items-center gap-1.5 text-text-muted text-xs mt-0.5">
          <span className="text-mono">{formatTime(track.duration, '')}</span>
          {track.spotifyData?.artists?.length > 0 && (
            <>
              <span className="text-text-muted/50">&#8226;</span>
              <span className="truncate text-secondary">
                {track.spotifyData.artists.join(', ')}
              </span>
            </>
          )}
        </div>
        {track.requestedBy && (
          <div className="flex items-center gap-1.5 text-xs mt-1 text-text-muted">
            <UserAvatar
              userId={track.requestedById}
              avatarHash={track.requestedByAvatar}
              username={track.requestedBy}
              size={14}
            />
            <span className="truncate">{track.requestedBy}</span>
          </div>
        )}
      </div>

      {/* Remove button */}
      {!isOverlay && (
        <button
          onClick={() => onRemove(index, trackId)}
          onPointerDown={(e) => e.stopPropagation()}
          className="text-text-muted hover:text-red-400 transition-colors p-1.5 rounded hover:bg-red-400/10 focus-ring min-w-[32px] min-h-[32px] flex items-center justify-center opacity-0 group-hover:opacity-100 focus-within:opacity-100 transition-opacity duration-150"
          title="Remove from queue"
          aria-label={`Remove ${track.title} from queue`}
        >
          <Remove size={14} aria-hidden="true" />
        </button>
      )}
    </div>
  );
}
