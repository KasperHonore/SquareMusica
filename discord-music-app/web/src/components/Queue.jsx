import { DndContext, closestCenter, KeyboardSensor, PointerSensor, useSensor, useSensors } from '@dnd-kit/core';
import { SortableContext, sortableKeyboardCoordinates, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { QueueItem } from './QueueItem';

export function Queue({ tracks, currentIndex, onReorder, onRemove }) {
  const sensors = useSensors(
    useSensor(PointerSensor),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    })
  );

  const handleDragEnd = (event) => {
    const { active, over } = event;
    if (active.id !== over?.id) {
      const oldIndex = tracks.findIndex(t => t.url === active.id);
      const newIndex = tracks.findIndex(t => t.url === over.id);
      onReorder(oldIndex, newIndex);
    }
  };

  if (tracks.length === 0) {
    return (
      <div className="bg-gray-800 p-6 rounded-lg">
        <h3 className="text-lg font-bold mb-4">Queue</h3>
        <p className="text-gray-400 text-center py-8">Queue is empty</p>
      </div>
    );
  }

  return (
    <div className="bg-gray-800 p-4 rounded-lg">
      <h3 className="text-lg font-bold mb-4">Queue ({tracks.length} tracks)</h3>
      <DndContext
        sensors={sensors}
        collisionDetection={closestCenter}
        onDragEnd={handleDragEnd}
      >
        <SortableContext
          items={tracks.map(t => t.url)}
          strategy={verticalListSortingStrategy}
        >
          <div className="space-y-2 max-h-96 overflow-y-auto">
            {tracks.map((track, index) => (
              <QueueItem
                key={track.url}
                track={track}
                index={index}
                isCurrent={index === currentIndex}
                onRemove={onRemove}
              />
            ))}
          </div>
        </SortableContext>
      </DndContext>
    </div>
  );
}
