import { useState } from 'react';
import {
  DndContext,
  closestCenter,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  DragOverlay
} from '@dnd-kit/core';
import {
  SortableContext,
  sortableKeyboardCoordinates,
  verticalListSortingStrategy
} from '@dnd-kit/sortable';
import { QueueItem } from './QueueItem';
import { QueueHeader } from './QueueHeader';
import { EmptyQueue } from './EmptyQueue';

/**
 * Get a unique identifier for a track (handles unresolved Spotify tracks)
 */
function getTrackId(track, index) {
  if (track.url) {
    return track.url;
  }
  if (track.spotifyData?.spotifyId) {
    return `spotify:${track.spotifyData.spotifyId}`;
  }
  return `track:${index}:${track.title}`;
}

export function Queue({
  tracks,
  onReorder,
  onRemove,
  onShuffle,
  onClear,
  resolutionStats,
  isRightPanel = false
}) {
  const [activeId, setActiveId] = useState(null);
  const [removingId, setRemovingId] = useState(null);

  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: {
        distance: 5
      }
    }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates
    })
  );

  const handleDragStart = (event) => {
    setActiveId(event.active.id);
  };

  const handleDragEnd = (event) => {
    const { active, over } = event;
    setActiveId(null);

    if (active.id !== over?.id) {
      const oldIndex = tracks.findIndex((t, i) => getTrackId(t, i) === active.id);
      const newIndex = tracks.findIndex((t, i) => getTrackId(t, i) === over.id);
      onReorder(oldIndex, newIndex);
    }
  };

  const handleDragCancel = () => {
    setActiveId(null);
  };

  const handleRemove = (index, trackId) => {
    setRemovingId(trackId);
    setTimeout(() => {
      onRemove(index);
      setRemovingId(null);
    }, 250);
  };

  const hasUnresolved =
    resolutionStats &&
    (resolutionStats.unresolved > 0 ||
      resolutionStats.resolving > 0 ||
      resolutionStats.pending > 0);

  const activeTrack = activeId ? tracks.find((t, i) => getTrackId(t, i) === activeId) : null;
  const activeIndex = activeId ? tracks.findIndex((t, i) => getTrackId(t, i) === activeId) : -1;

  const isEmpty = tracks.length === 0;

  return (
    <div
      className="h-full flex-1 min-h-0 flex flex-col"
      role="region"
      aria-labelledby="queue-heading"
    >
      <QueueHeader
        count={tracks.length}
        isEmpty={isEmpty}
        hasUnresolved={hasUnresolved}
        isRightPanel={isRightPanel}
        onShuffle={onShuffle}
        onClear={onClear}
      />

      <style>{`
        .wave-queue-action:hover:not(:disabled) { color: var(--color-accent) !important; }
        .wave-queue-action-danger:hover:not(:disabled) { color: var(--color-danger) !important; }
      `}</style>

      {/* Queue list */}
      {isEmpty ? (
        <EmptyQueue isRightPanel={isRightPanel} />
      ) : (
        <DndContext
          sensors={sensors}
          collisionDetection={closestCenter}
          onDragStart={handleDragStart}
          onDragEnd={handleDragEnd}
          onDragCancel={handleDragCancel}
        >
          <SortableContext
            items={tracks.map((t, i) => getTrackId(t, i))}
            strategy={verticalListSortingStrategy}
          >
            <div
              className="flex-1 min-h-0 overflow-y-auto queue-list"
              style={{
                padding: isRightPanel ? '0 10px 12px' : '0 0 12px',
                scrollbarGutter: 'stable'
              }}
              role="list"
              aria-label="Queue items"
            >
              {tracks.map((track, index) => {
                const trackId = getTrackId(track, index);
                return (
                  <QueueItem
                    key={trackId}
                    track={track}
                    index={index}
                    trackId={trackId}
                    onRemove={handleRemove}
                    isUpNext={index === 0}
                    isRemoving={removingId === trackId}
                    isDraggingActive={activeId !== null}
                    isBeingDragged={activeId === trackId}
                    isRightPanel={isRightPanel}
                  />
                );
              })}
            </div>
          </SortableContext>

          <DragOverlay
            dropAnimation={{
              duration: 200,
              easing: 'cubic-bezier(0.18, 0.67, 0.6, 1.22)'
            }}
          >
            {activeTrack ? (
              <QueueItem
                track={activeTrack}
                index={activeIndex}
                trackId={activeId}
                onRemove={() => {}}
                isUpNext={activeIndex === 0}
                isOverlay
                isRightPanel={isRightPanel}
              />
            ) : null}
          </DragOverlay>
        </DndContext>
      )}
    </div>
  );
}
