import { formatTime } from '../utils/formatTime';
import { Remove } from './icons';
import { UserAvatar } from './UserAvatar';

/**
 * QueueItemDefault - original center-panel queue item layout.
 */
export function QueueItemDefault({
  track,
  index,
  trackId,
  onRemove,
  isUpNext,
  isRemoving,
  isBeingDragged,
  isDragging,
  isOverlay,
  isDropTarget,
  isFailed,
  statusIndicator,
  style,
  setNodeRef,
  attributes,
  listeners
}) {
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
