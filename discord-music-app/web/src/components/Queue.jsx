import { useState, useEffect } from 'react';
import { DndContext, closestCenter, KeyboardSensor, PointerSensor, useSensor, useSensors, DragOverlay } from '@dnd-kit/core';
import { SortableContext, sortableKeyboardCoordinates, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { QueueItem } from './QueueItem';
import { Shuffle, MusicNote, Trash } from './icons';

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

/**
 * Empty state component with engaging animated visuals
 */
function EmptyQueue({ onShuffle, onClear }) {
  return (
    <div className="h-full flex-1 min-h-0 flex flex-col" role="region" aria-label="Music queue">
      <div className="flex items-center justify-between mb-4 px-1">
        <h3 className="text-heading text-lg" id="queue-heading">Up Next</h3>
        <div className="flex items-center gap-1">
          <button
            onClick={onClear}
            disabled
            className="p-2 text-text-secondary opacity-50 cursor-not-allowed min-w-[44px] min-h-[44px] flex items-center justify-center"
            title="Clear queue (queue is empty)"
            aria-label="Clear queue (disabled - queue is empty)"
            aria-disabled="true"
          >
            <Trash size={20} />
          </button>
          <button
            onClick={onShuffle}
            disabled
            className="p-2 text-text-secondary opacity-50 cursor-not-allowed min-w-[44px] min-h-[44px] flex items-center justify-center"
            title="Shuffle queue (queue is empty)"
            aria-label="Shuffle queue (disabled - queue is empty)"
            aria-disabled="true"
          >
            <Shuffle size={20} />
          </button>
        </div>
      </div>

      {/* Engaging empty state */}
      <div className="flex-1 flex flex-col items-center justify-center py-8 animate-fade-in">
        {/* Animated music notes container */}
        <div className="relative w-24 h-24 mb-6">
          {/* Background circle */}
          <div className="absolute inset-0 rounded-full bg-accent-subtle animate-pulse-glow" />

          {/* Floating notes animation */}
          <div className="absolute inset-0 flex items-center justify-center">
            <div className="relative">
              <MusicNote size={36} className="text-accent" />
              {/* Orbiting mini notes */}
              <div className="absolute -top-2 -left-3 animate-wave">
                <MusicNote size={14} className="text-accent/60" />
              </div>
              <div className="absolute -bottom-1 -right-3 animate-wave-delay-2">
                <MusicNote size={16} className="text-accent/40" />
              </div>
            </div>
          </div>

          {/* Sound wave rings */}
          <div
            className="absolute inset-0 rounded-full border border-accent/20"
            style={{ animation: 'ring-pulse 2s ease-out infinite' }}
          />
          <div
            className="absolute inset-0 rounded-full border border-accent/10"
            style={{ animation: 'ring-pulse 2s ease-out infinite 0.5s' }}
          />
        </div>

        <p className="text-heading text-sm text-text-secondary mb-2">Queue is empty</p>
        <p className="text-body text-xs text-text-muted text-center max-w-[200px]">
          Search for songs or use <code className="text-mono text-accent/80 bg-accent-subtle px-1.5 py-0.5 rounded">/play</code> in Discord
        </p>
      </div>
    </div>
  );
}

export function Queue({ tracks, onReorder, onRemove, onShuffle, onClear, resolutionStats }) {
  const [activeId, setActiveId] = useState(null);
  const [removingId, setRemovingId] = useState(null);
  const [showClearConfirm, setShowClearConfirm] = useState(false);

  // Auto-dismiss confirmation after 3 seconds
  useEffect(() => {
    if (showClearConfirm) {
      const timer = setTimeout(() => setShowClearConfirm(false), 3000);
      return () => clearTimeout(timer);
    }
  }, [showClearConfirm]);

  const handleClearClick = () => {
    setShowClearConfirm(true);
  };

  const handleClearConfirm = () => {
    onClear();
    setShowClearConfirm(false);
  };

  const handleClearCancel = () => {
    setShowClearConfirm(false);
  };

  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: {
        distance: 5, // Start drag after 5px movement
      },
    }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
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

  // Enhanced remove with animation
  const handleRemove = (index, trackId) => {
    setRemovingId(trackId);
    // Allow animation to play before actually removing
    setTimeout(() => {
      onRemove(index);
      setRemovingId(null);
    }, 250);
  };

  if (tracks.length === 0) {
    return <EmptyQueue onShuffle={onShuffle} onClear={onClear} />;
  }

  // Check if there are unresolved tracks in the queue
  const hasUnresolved = resolutionStats && (
    resolutionStats.unresolved > 0 ||
    resolutionStats.resolving > 0 ||
    resolutionStats.pending > 0
  );

  // Get the currently dragging track for overlay
  const activeTrack = activeId
    ? tracks.find((t, i) => getTrackId(t, i) === activeId)
    : null;
  const activeIndex = activeId
    ? tracks.findIndex((t, i) => getTrackId(t, i) === activeId)
    : -1;

  return (
    <div className="h-full flex-1 min-h-0 flex flex-col" role="region" aria-labelledby="queue-heading">
      {/* Header */}
      <div className="flex items-center justify-between mb-3 px-1">
        <div className="flex items-center gap-2">
          <h3 className="text-heading text-lg" id="queue-heading">Up Next</h3>
          <span
            className="text-mono text-xs px-2 py-0.5 rounded-full bg-accent-subtle text-accent"
            aria-label={`${tracks.length} tracks in queue`}
          >
            {tracks.length}
          </span>
          {hasUnresolved && (
            <span className="flex items-center gap-1" title="Resolving Spotify tracks" aria-label="Resolving Spotify tracks">
              <svg className="w-4 h-4 animate-pulse" fill="#1DB954" viewBox="0 0 24 24" aria-hidden="true">
                <path d="M12 0C5.4 0 0 5.4 0 12s5.4 12 12 12 12-5.4 12-12S18.66 0 12 0zm5.521 17.34c-.24.359-.66.48-1.021.24-2.82-1.74-6.36-2.101-10.561-1.141-.418.122-.779-.179-.899-.539-.12-.421.18-.78.54-.9 4.56-1.021 8.52-.6 11.64 1.32.42.18.479.659.301 1.02zm1.44-3.3c-.301.42-.841.6-1.262.3-3.239-1.98-8.159-2.58-11.939-1.38-.479.12-1.02-.12-1.14-.6-.12-.48.12-1.021.6-1.141C9.6 9.9 15 10.561 18.72 12.84c.361.181.54.78.241 1.2zm.12-3.36C15.24 8.4 8.82 8.16 5.16 9.301c-.6.179-1.2-.181-1.38-.721-.18-.601.18-1.2.72-1.381 4.26-1.26 11.28-1.02 15.721 1.621.539.3.719 1.02.419 1.56-.299.421-1.02.599-1.559.3z"/>
              </svg>
            </span>
          )}
        </div>
        <div className="flex items-center gap-1">
          {/* Clear button with inline confirmation */}
          {showClearConfirm ? (
            <div className="flex items-center gap-1 bg-surface-elevated rounded-full px-2 py-1 animate-fade-in">
              <span className="text-xs text-text-secondary whitespace-nowrap">Clear queue?</span>
              <button
                onClick={handleClearConfirm}
                className="p-1.5 text-green-400 hover:text-green-300 hover:bg-green-400/10 transition-colors rounded-full min-w-[32px] min-h-[32px] flex items-center justify-center"
                title="Confirm clear"
                aria-label="Confirm clear queue"
              >
                <svg width={16} height={16} viewBox="0 0 24 24" fill="currentColor">
                  <path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z" />
                </svg>
              </button>
              <button
                onClick={handleClearCancel}
                className="p-1.5 text-red-400 hover:text-red-300 hover:bg-red-400/10 transition-colors rounded-full min-w-[32px] min-h-[32px] flex items-center justify-center"
                title="Cancel"
                aria-label="Cancel clear queue"
              >
                <svg width={16} height={16} viewBox="0 0 24 24" fill="currentColor">
                  <path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z" />
                </svg>
              </button>
            </div>
          ) : (
            <button
              onClick={handleClearClick}
              className="p-2 text-text-secondary hover:text-accent transition-colors rounded-full hover:bg-accent-subtle interactive focus-ring min-w-[44px] min-h-[44px] flex items-center justify-center"
              title="Clear queue"
              aria-label="Clear queue"
            >
              <Trash size={20} />
            </button>
          )}
          <button
            onClick={onShuffle}
            className="p-2 text-text-secondary hover:text-accent transition-colors rounded-full hover:bg-accent-subtle interactive focus-ring min-w-[44px] min-h-[44px] flex items-center justify-center"
            title="Shuffle queue"
            aria-label="Shuffle queue"
          >
            <Shuffle size={20} />
          </button>
        </div>
      </div>

      {/* Queue list with DnD - fills remaining space */}
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
            className="flex-1 min-h-0 space-y-1.5 overflow-y-auto pr-1 queue-list"
            style={{
              scrollbarGutter: 'stable',
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
                />
              );
            })}
          </div>
        </SortableContext>

        {/* Drag overlay - shows a ghost of the dragged item */}
        <DragOverlay dropAnimation={{
          duration: 200,
          easing: 'cubic-bezier(0.18, 0.67, 0.6, 1.22)',
        }}>
          {activeTrack ? (
            <QueueItem
              track={activeTrack}
              index={activeIndex}
              trackId={activeId}
              onRemove={() => {}}
              isUpNext={activeIndex === 0}
              isOverlay
            />
          ) : null}
        </DragOverlay>
      </DndContext>
    </div>
  );
}
