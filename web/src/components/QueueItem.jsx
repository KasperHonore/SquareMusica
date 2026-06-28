import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { getStatusIndicator } from './QueueItemStatus';
import { QueueItemCompact } from './QueueItemCompact';
import { QueueItemDefault } from './QueueItemDefault';

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

  const layoutProps = {
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
  };

  // Right panel uses compact Wave-style q-item layout
  if (isRightPanel) {
    return <QueueItemCompact {...layoutProps} />;
  }

  // Original center-panel layout (non-right-panel)
  return <QueueItemDefault {...layoutProps} />;
}
