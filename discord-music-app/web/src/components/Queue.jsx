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
 * Empty state component
 */
function EmptyQueue({ isRightPanel }) {
  return (
    <div className="flex-1 min-h-0 flex flex-col items-center justify-center" style={{ padding: isRightPanel ? '20px 10px' : '40px 20px' }}>
      <div className="relative w-16 h-16 mb-4">
        <div
          className="absolute inset-0 rounded-full animate-pulse-glow"
          style={{ backgroundColor: 'var(--color-accent-subtle)' }}
        />
        <div className="absolute inset-0 flex items-center justify-center">
          <MusicNote size={28} style={{ color: 'var(--color-accent)' }} />
        </div>
      </div>
      <p style={{ fontSize: '13px', color: 'var(--color-text-secondary)', marginBottom: '4px' }}>Queue is empty</p>
      <p
        className="text-center"
        style={{ fontSize: '12px', color: 'var(--color-text-muted)', maxWidth: '200px' }}
      >
        Search for songs or use <code
          style={{
            color: 'rgba(232,200,122,0.8)',
            background: 'var(--color-accent-subtle)',
            padding: '1px 6px',
            borderRadius: '4px',
            fontSize: '11px',
          }}
        >/play</code> in Discord
      </p>
    </div>
  );
}

export function Queue({ tracks, onReorder, onRemove, onShuffle, onClear, resolutionStats, isRightPanel = false }) {
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
        distance: 5,
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

  const handleRemove = (index, trackId) => {
    setRemovingId(trackId);
    setTimeout(() => {
      onRemove(index);
      setRemovingId(null);
    }, 250);
  };

  const hasUnresolved = resolutionStats && (
    resolutionStats.unresolved > 0 ||
    resolutionStats.resolving > 0 ||
    resolutionStats.pending > 0
  );

  const activeTrack = activeId
    ? tracks.find((t, i) => getTrackId(t, i) === activeId)
    : null;
  const activeIndex = activeId
    ? tracks.findIndex((t, i) => getTrackId(t, i) === activeId)
    : -1;

  const isEmpty = tracks.length === 0;

  return (
    <div
      className="h-full flex-1 min-h-0 flex flex-col"
      role="region"
      aria-labelledby="queue-heading"
    >
      {/* Queue header */}
      <div
        className="flex items-center justify-between flex-shrink-0"
        style={{ padding: isRightPanel ? '11px 20px 9px' : '8px 4px 12px' }}
      >
        <div className="flex items-center gap-2">
          <span
            style={{
              fontSize: isRightPanel ? '10px' : '11px',
              fontWeight: 600,
              letterSpacing: isRightPanel ? '1px' : '0.8px',
              textTransform: 'uppercase',
              color: 'var(--color-text-muted)',
            }}
            id="queue-heading"
          >
            Up Next
          </span>
          {!isEmpty && (
            <span
              className="text-mono"
              style={{
                fontSize: '10px',
                padding: '1px 6px',
                borderRadius: '9999px',
                backgroundColor: 'var(--color-accent-subtle)',
                color: 'var(--color-accent)',
              }}
            >
              {tracks.length}
            </span>
          )}
          {hasUnresolved && (
            <span className="flex items-center gap-1" title="Resolving Spotify tracks" aria-label="Resolving Spotify tracks">
              <svg className="w-4 h-4 animate-pulse" fill="#1DB954" viewBox="0 0 24 24" aria-hidden="true">
                <path d="M12 0C5.4 0 0 5.4 0 12s5.4 12 12 12 12-5.4 12-12S18.66 0 12 0zm5.521 17.34c-.24.359-.66.48-1.021.24-2.82-1.74-6.36-2.101-10.561-1.141-.418.122-.779-.179-.899-.539-.12-.421.18-.78.54-.9 4.56-1.021 8.52-.6 11.64 1.32.42.18.479.659.301 1.02zm1.44-3.3c-.301.42-.841.6-1.262.3-3.239-1.98-8.159-2.58-11.939-1.38-.479.12-1.02-.12-1.14-.6-.12-.48.12-1.021.6-1.141C9.6 9.9 15 10.561 18.72 12.84c.361.181.54.78.241 1.2zm.12-3.36C15.24 8.4 8.82 8.16 5.16 9.301c-.6.179-1.2-.181-1.38-.721-.18-.601.18-1.2.72-1.381 4.26-1.26 11.28-1.02 15.721 1.621.539.3.719 1.02.419 1.56-.299.421-1.02.599-1.559.3z"/>
              </svg>
            </span>
          )}
        </div>
        <div className="flex items-center" style={{ gap: isRightPanel ? '10px' : '4px' }}>
          {/* Clear button with inline confirmation */}
          {showClearConfirm ? (
            <div className="flex items-center gap-1 animate-fade-in" style={{
              background: 'var(--color-bg-elevated)',
              borderRadius: '9999px',
              padding: '2px 8px',
            }}>
              <span style={{ fontSize: '11px', color: 'var(--color-text-secondary)', whiteSpace: 'nowrap' }}>Clear?</span>
              <button
                onClick={handleClearConfirm}
                className="flex items-center justify-center"
                style={{
                  padding: '4px',
                  color: 'var(--color-success)',
                  borderRadius: '50%',
                  border: 'none',
                  background: 'none',
                  cursor: 'pointer',
                  transition: 'background 0.12s',
                  minWidth: '24px',
                  minHeight: '24px',
                }}
                title="Confirm clear"
                aria-label="Confirm clear queue"
              >
                <svg width={14} height={14} viewBox="0 0 24 24" fill="currentColor">
                  <path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z" />
                </svg>
              </button>
              <button
                onClick={handleClearCancel}
                className="flex items-center justify-center"
                style={{
                  padding: '4px',
                  color: 'var(--color-danger)',
                  borderRadius: '50%',
                  border: 'none',
                  background: 'none',
                  cursor: 'pointer',
                  transition: 'background 0.12s',
                  minWidth: '24px',
                  minHeight: '24px',
                }}
                title="Cancel"
                aria-label="Cancel clear queue"
              >
                <svg width={14} height={14} viewBox="0 0 24 24" fill="currentColor">
                  <path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z" />
                </svg>
              </button>
            </div>
          ) : isRightPanel ? (
            <>
              <button
                onClick={onShuffle}
                disabled={isEmpty}
                style={{
                  background: 'none',
                  border: 'none',
                  fontSize: '11px',
                  color: isEmpty ? 'var(--color-text-muted)' : 'var(--color-text-muted)',
                  cursor: isEmpty ? 'not-allowed' : 'pointer',
                  fontFamily: 'var(--font-body)',
                  transition: 'color 0.12s',
                  padding: 0,
                  opacity: isEmpty ? 0.5 : 1,
                }}
                className="wave-queue-action"
                title="Shuffle queue"
                aria-label="Shuffle queue"
              >
                Shuffle
              </button>
              <button
                onClick={handleClearClick}
                disabled={isEmpty}
                style={{
                  background: 'none',
                  border: 'none',
                  fontSize: '11px',
                  color: isEmpty ? 'var(--color-text-muted)' : 'var(--color-text-muted)',
                  cursor: isEmpty ? 'not-allowed' : 'pointer',
                  fontFamily: 'var(--font-body)',
                  transition: 'color 0.12s',
                  padding: 0,
                  opacity: isEmpty ? 0.5 : 1,
                }}
                className="wave-queue-action-danger"
                title="Clear queue"
                aria-label="Clear queue"
              >
                Clear
              </button>
            </>
          ) : (
            <>
              <button
                onClick={handleClearClick}
                disabled={isEmpty}
                className="flex items-center justify-center"
                style={{
                  padding: '8px',
                  color: 'var(--color-text-secondary)',
                  opacity: isEmpty ? 0.5 : 1,
                  cursor: isEmpty ? 'not-allowed' : 'pointer',
                  borderRadius: '9999px',
                  border: 'none',
                  background: 'none',
                  transition: 'color 0.12s, background 0.12s',
                  minWidth: '44px',
                  minHeight: '44px',
                }}
                title="Clear queue"
                aria-label="Clear queue"
              >
                <Trash size={20} />
              </button>
              <button
                onClick={onShuffle}
                disabled={isEmpty}
                className="flex items-center justify-center"
                style={{
                  padding: '8px',
                  color: 'var(--color-text-secondary)',
                  opacity: isEmpty ? 0.5 : 1,
                  cursor: isEmpty ? 'not-allowed' : 'pointer',
                  borderRadius: '9999px',
                  border: 'none',
                  background: 'none',
                  transition: 'color 0.12s, background 0.12s',
                  minWidth: '44px',
                  minHeight: '44px',
                }}
                title="Shuffle queue"
                aria-label="Shuffle queue"
              >
                <Shuffle size={20} />
              </button>
            </>
          )}
        </div>
      </div>

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
                    isRightPanel={isRightPanel}
                  />
                );
              })}
            </div>
          </SortableContext>

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
                isRightPanel={isRightPanel}
              />
            ) : null}
          </DragOverlay>
        </DndContext>
      )}
    </div>
  );
}
