import { DndContext, closestCenter, KeyboardSensor, PointerSensor, useSensor, useSensors } from '@dnd-kit/core';
import { SortableContext, sortableKeyboardCoordinates, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { QueueItem } from './QueueItem';

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

export function Queue({ tracks, onReorder, onRemove, resolutionStats }) {
  const sensors = useSensors(
    useSensor(PointerSensor),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    })
  );

  const handleDragEnd = (event) => {
    const { active, over } = event;
    if (active.id !== over?.id) {
      const oldIndex = tracks.findIndex((t, i) => getTrackId(t, i) === active.id);
      const newIndex = tracks.findIndex((t, i) => getTrackId(t, i) === over.id);
      onReorder(oldIndex, newIndex);
    }
  };

  if (tracks.length === 0) {
    return (
      <div className="bg-gray-800 p-6 rounded-lg">
        <h3 className="text-lg font-bold mb-4">Up Next</h3>
        <p className="text-gray-400 text-center py-8">No upcoming tracks</p>
      </div>
    );
  }

  // Check if there are unresolved tracks in the queue
  const hasUnresolved = resolutionStats && (
    resolutionStats.unresolved > 0 ||
    resolutionStats.resolving > 0 ||
    resolutionStats.pending > 0
  );

  return (
    <div className="bg-gray-800 p-4 rounded-lg">
      <div className="flex items-center justify-between mb-4">
        <h3 className="text-lg font-bold">Up Next ({tracks.length} {tracks.length === 1 ? 'track' : 'tracks'})</h3>
        {hasUnresolved && (
          <span className="text-xs text-green-400 flex items-center gap-1">
            <svg className="w-3 h-3 animate-pulse" fill="#1DB954" viewBox="0 0 24 24">
              <path d="M12 0C5.4 0 0 5.4 0 12s5.4 12 12 12 12-5.4 12-12S18.66 0 12 0zm5.521 17.34c-.24.359-.66.48-1.021.24-2.82-1.74-6.36-2.101-10.561-1.141-.418.122-.779-.179-.899-.539-.12-.421.18-.78.54-.9 4.56-1.021 8.52-.6 11.64 1.32.42.18.479.659.301 1.02zm1.44-3.3c-.301.42-.841.6-1.262.3-3.239-1.98-8.159-2.58-11.939-1.38-.479.12-1.02-.12-1.14-.6-.12-.48.12-1.021.6-1.141C9.6 9.9 15 10.561 18.72 12.84c.361.181.54.78.241 1.2zm.12-3.36C15.24 8.4 8.82 8.16 5.16 9.301c-.6.179-1.2-.181-1.38-.721-.18-.601.18-1.2.72-1.381 4.26-1.26 11.28-1.02 15.721 1.621.539.3.719 1.02.419 1.56-.299.421-1.02.599-1.559.3z"/>
            </svg>
            Resolving...
          </span>
        )}
      </div>
      <DndContext
        sensors={sensors}
        collisionDetection={closestCenter}
        onDragEnd={handleDragEnd}
      >
        <SortableContext
          items={tracks.map((t, i) => getTrackId(t, i))}
          strategy={verticalListSortingStrategy}
        >
          <div className="space-y-2 max-h-96 overflow-y-auto">
            {tracks.map((track, index) => (
              <QueueItem
                key={getTrackId(track, index)}
                track={track}
                index={index}
                trackId={getTrackId(track, index)}
                onRemove={onRemove}
              />
            ))}
          </div>
        </SortableContext>
      </DndContext>
    </div>
  );
}
