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
    <svg className={className} viewBox="0 0 24 24" fill={color} width="16" height="16">
      <path d="M12 0C5.4 0 0 5.4 0 12s5.4 12 12 12 12-5.4 12-12S18.66 0 12 0zm5.521 17.34c-.24.359-.66.48-1.021.24-2.82-1.74-6.36-2.101-10.561-1.141-.418.122-.779-.179-.899-.539-.12-.421.18-.78.54-.9 4.56-1.021 8.52-.6 11.64 1.32.42.18.479.659.301 1.02zm1.44-3.3c-.301.42-.841.6-1.262.3-3.239-1.98-8.159-2.58-11.939-1.38-.479.12-1.02-.12-1.14-.6-.12-.48.12-1.021.6-1.141C9.6 9.9 15 10.561 18.72 12.84c.361.181.54.78.241 1.2zm.12-3.36C15.24 8.4 8.82 8.16 5.16 9.301c-.6.179-1.2-.181-1.38-.721-.18-.601.18-1.2.72-1.381 4.26-1.26 11.28-1.02 15.721 1.621.539.3.719 1.02.419 1.56-.299.421-1.02.599-1.559.3z" />
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
      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
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
  if (track.url && track.status !== 'failed') {
    return null;
  }

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
  isRightPanel = false
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging, over } =
    useSortable({ id: trackId, disabled: isOverlay });

  const animationDelay = `${index * 50}ms`;

  const style = {
    transform: CSS.Transform.toString(transform),
    transition: isOverlay ? undefined : transition,
    '--animation-delay': animationDelay,
    animationDelay: animationDelay
  };

  const isDropTarget = isDraggingActive && !isBeingDragged && over?.id === trackId;

  const statusIndicator = getStatusIndicator(track);
  const isFailed = track.status === 'failed';

  // Right panel uses compact Wave-style q-item layout
  if (isRightPanel) {
    const itemStyle = {
      ...style,
      display: 'flex',
      alignItems: 'center',
      gap: '9px',
      padding: '6px 8px',
      borderRadius: '7px',
      transition: 'background 0.1s',
      cursor: isOverlay ? 'grabbing' : 'grab',
      opacity: isDragging ? 0.4 : isFailed ? 0.6 : 1
    };

    return (
      <div
        ref={!isOverlay ? setNodeRef : undefined}
        style={itemStyle}
        className={[
          'wave-q-item group animate-queue-item-in',
          isDragging && 'opacity-40',
          isBeingDragged && 'ring-2 ring-accent/50',
          isDropTarget && 'queue-item-drop-target',
          isRemoving && 'animate-queue-item-out',
          isOverlay && 'shadow-2xl ring-2 ring-accent'
        ]
          .filter(Boolean)
          .join(' ')}
        role="listitem"
        aria-label={`${isUpNext ? 'Up next: ' : ''}${track.title}`}
        {...(!isOverlay ? attributes : {})}
        {...(!isOverlay ? listeners : {})}
      >
        {/* Drop zone indicator */}
        {isDropTarget && (
          <div
            className="absolute -top-1 left-0 right-0 h-0.5 rounded-full"
            style={{
              backgroundColor: 'var(--color-accent)',
              boxShadow: '0 0 8px rgba(232,200,122,0.6)'
            }}
          />
        )}

        {/* Thumbnail */}
        {track.thumbnail ? (
          <img
            src={track.thumbnail}
            alt=""
            style={{
              width: '36px',
              height: '36px',
              borderRadius: '5px',
              objectFit: 'cover',
              flexShrink: 0,
              backgroundColor: 'var(--color-bg-surface3)'
            }}
            loading="lazy"
          />
        ) : (
          <div
            style={{
              width: '36px',
              height: '36px',
              borderRadius: '5px',
              flexShrink: 0,
              backgroundColor: 'var(--color-bg-surface3)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center'
            }}
          >
            {statusIndicator?.icon || (
              <span style={{ color: 'var(--color-text-muted)', fontSize: '14px' }}>&#9835;</span>
            )}
          </div>
        )}

        {/* Track info */}
        <div style={{ flex: 1, minWidth: 0 }}>
          <div className="flex items-center gap-1.5">
            {statusIndicator && track.thumbnail && (
              <span title={statusIndicator.tooltip} className="flex-shrink-0">
                {statusIndicator.icon}
              </span>
            )}
            <div
              className={`truncate ${statusIndicator?.className || ''}`}
              style={{
                fontSize: '12px',
                fontWeight: 500,
                color: 'var(--color-text-primary)'
              }}
            >
              {track.title}
            </div>
          </div>
          <div className="truncate" style={{ fontSize: '10px', color: 'var(--color-text-muted)' }}>
            {track.spotifyData?.artists?.length > 0
              ? track.spotifyData.artists.join(', ')
              : track.artist || ''}
          </div>
          {track.requestedBy && (
            <div
              className="flex items-center gap-1 mt-0.5"
              style={{ fontSize: '10px', color: 'var(--color-text-muted)' }}
            >
              <UserAvatar
                userId={track.requestedById}
                avatarHash={track.requestedByAvatar}
                username={track.requestedBy}
                size={12}
              />
              <span className="truncate">{track.requestedBy}</span>
            </div>
          )}
        </div>

        {/* Duration */}
        <span style={{ fontSize: '10px', color: 'var(--color-text-muted)', flexShrink: 0 }}>
          {formatTime(track.duration, '')}
        </span>

        {/* Remove button - appears on hover */}
        {!isOverlay && (
          <button
            onClick={(e) => {
              e.stopPropagation();
              onRemove(index, trackId);
            }}
            onPointerDown={(e) => e.stopPropagation()}
            style={{
              background: 'none',
              border: 'none',
              color: 'transparent',
              cursor: 'pointer',
              padding: '3px',
              borderRadius: '4px',
              flexShrink: 0,
              transition: 'all 0.12s',
              display: 'flex'
            }}
            className="wave-q-remove"
            title="Remove from queue"
            aria-label={`Remove ${track.title} from queue`}
          >
            <svg
              width="12"
              height="12"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              strokeWidth="2"
            >
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        )}

        <style>{`
          .wave-q-item:hover { background: var(--color-bg-elevated); }
          .wave-q-item:hover .wave-q-remove { color: var(--color-text-muted) !important; }
          .wave-q-remove:hover { color: var(--color-danger) !important; background: rgba(232,122,122,0.1); }
        `}</style>
      </div>
    );
  }

  // Original center-panel layout (non-right-panel)
  const isEven = index % 2 === 0;

  const containerClasses = [
    'queue-item',
    'flex items-start gap-3 p-2.5 rounded-lg',
    'transition-all duration-200',
    'group relative',
    !isOverlay && 'animate-queue-item-in',
    isEven ? '' : 'bg-white/[0.02]',
    !isDragging && !isOverlay && 'hover:bg-white/[0.05]',
    isDragging && 'opacity-40 scale-95',
    isBeingDragged && 'ring-2 ring-accent/50',
    isDropTarget && 'queue-item-drop-target',
    isRemoving && 'animate-queue-item-out',
    isOverlay && 'shadow-2xl ring-2 ring-accent scale-105 bg-surface-raised',
    isFailed && 'opacity-60',
    !isOverlay && 'cursor-grab active:cursor-grabbing'
  ]
    .filter(Boolean)
    .join(' ');

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
      {isDropTarget && (
        <div className="absolute -top-1 left-0 right-0 h-0.5 bg-accent rounded-full shadow-[0_0_8px_rgba(232,200,122,0.6)]" />
      )}

      {track.thumbnail ? (
        <img
          src={track.thumbnail}
          alt=""
          className="w-11 h-11 rounded-md object-cover flex-shrink-0"
        />
      ) : (
        <div className="w-11 h-11 rounded-md bg-surface-elevated flex items-center justify-center flex-shrink-0">
          {statusIndicator?.icon || <span className="text-text-muted text-lg">&#9835;</span>}
        </div>
      )}

      <div className="flex-1 min-w-0 pt-0.5">
        <div className="flex items-center gap-2">
          {statusIndicator && track.thumbnail && (
            <span title={statusIndicator.tooltip} className="flex-shrink-0">
              {statusIndicator.icon}
            </span>
          )}
          <p
            className={`truncate font-medium text-sm text-primary ${statusIndicator?.className || ''}`}
          >
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
