import { MusicNote } from '../icons';

/**
 * Loading spinner component for album loading state
 */
function Spinner({ className = '' }) {
  return (
    <svg
      className={`animate-spin ${className}`}
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
    >
      <circle
        className="opacity-25"
        cx="12"
        cy="12"
        r="10"
        stroke="currentColor"
        strokeWidth="4"
      />
      <path
        className="opacity-75"
        fill="currentColor"
        d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
      />
    </svg>
  );
}

/**
 * MosaicThumbnail - A 2x2 grid of track thumbnails for album preview
 *
 * @param {Object} props
 * @param {string[]} props.thumbnails - Array of up to 4 thumbnail URLs
 * @param {boolean} props.isLoading - Show loading spinner overlay
 * @param {string} props.className - Additional CSS classes
 */
export function MosaicThumbnail({
  thumbnails = [],
  isLoading = false,
  className = ''
}) {
  // Take up to 4 thumbnails and pad with nulls if needed
  const slots = [...thumbnails.slice(0, 4), null, null, null, null].slice(0, 4);

  return (
    <div
      className={`relative w-11 h-11 rounded-md overflow-hidden flex-shrink-0 ${className}`}
      aria-hidden="true"
    >
      {/* 2x2 Grid */}
      <div className="grid grid-cols-2 grid-rows-2 w-full h-full">
        {slots.map((thumbnail, index) => (
          <div
            key={index}
            className="w-full h-full bg-surface-elevated flex items-center justify-center overflow-hidden"
          >
            {thumbnail ? (
              <img
                src={thumbnail}
                alt=""
                className="w-full h-full object-cover"
                loading="lazy"
              />
            ) : (
              <MusicNote
                size={10}
                className="text-text-muted opacity-40"
              />
            )}
          </div>
        ))}
      </div>

      {/* Loading overlay */}
      {isLoading && (
        <div className="absolute inset-0 bg-black/60 flex items-center justify-center backdrop-blur-sm">
          <Spinner className="text-accent" />
        </div>
      )}
    </div>
  );
}

export default MosaicThumbnail;
