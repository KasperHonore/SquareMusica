import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { formatTime } from '../utils/formatTime';

export function QueueItem({ track, index, onRemove }) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging
  } = useSortable({ id: track.url });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
  };

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={`flex items-center gap-3 p-3 rounded-lg bg-gray-700/50 ${isDragging ? 'shadow-lg' : ''}`}
    >
      <div
        {...attributes}
        {...listeners}
        className="cursor-grab active:cursor-grabbing text-gray-500 hover:text-gray-300"
        aria-label="Drag to reorder"
        role="button"
      >
        ⋮⋮
      </div>

      <span className="text-gray-500 w-6 text-sm">{index + 1}</span>

      {track.thumbnail && (
        <img
          src={track.thumbnail}
          alt=""
          className="w-10 h-10 rounded object-cover"
        />
      )}

      <div className="flex-1 min-w-0">
        <p className="truncate font-medium">
          {track.title}
        </p>
        <p className="text-gray-400 text-sm truncate">
          {formatTime(track.duration, '')}
        </p>
      </div>

      <button
        onClick={() => onRemove(index)}
        className="text-gray-500 hover:text-red-400 transition-colors p-1"
        title="Remove"
        aria-label={`Remove ${track.title} from queue`}
      >
        ✕
      </button>
    </div>
  );
}
