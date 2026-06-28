import { formatTime } from '../utils/formatTime';
import { UserAvatar } from './UserAvatar';

/**
 * QueueItemCompact - right-panel (Wave-style) compact queue item layout.
 */
export function QueueItemCompact({
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
