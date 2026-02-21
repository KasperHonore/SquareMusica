import { useState, useRef, useEffect } from 'react';
import { Play, Remove } from '../icons';

/**
 * Album icon for fallback thumbnail
 */
function AlbumIcon({ size = 24, className = '' }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
    >
      <circle cx="12" cy="12" r="10" />
      <circle cx="12" cy="12" r="3" />
      <line x1="12" y1="2" x2="12" y2="5" />
      <line x1="12" y1="19" x2="12" y2="22" />
    </svg>
  );
}

/**
 * AlbumItem - A row component for displaying a saved album
 *
 * @param {Object} props
 * @param {Object} props.album - Album data object
 * @param {string} props.album.id - Unique album ID
 * @param {string} props.album.name - Album name
 * @param {string} props.album.coverImage - Cover image URL from Spotify
 * @param {string} props.album.spotifyUrl - Spotify album/playlist URL
 * @param {number} props.index - Position in list (for stagger animation)
 * @param {boolean} props.isLoading - Whether album is being loaded into queue
 * @param {function} props.onPlay - Called when play button clicked
 * @param {function} props.onDelete - Called when delete button clicked
 */
export function AlbumItem({
  album,
  index = 0,
  isLoading = false,
  onPlay,
  onDelete
}) {
  const [shouldScroll, setShouldScroll] = useState(false);
  const textRef = useRef(null);
  const containerRef = useRef(null);

  // Calculate staggered animation delay
  const animationDelay = `${index * 50}ms`;

  // Alternating background tint for scanability
  const isEven = index % 2 === 0;

  // Check if text overflows container
  useEffect(() => {
    const checkOverflow = () => {
      if (textRef.current && containerRef.current) {
        const textWidth = textRef.current.scrollWidth;
        const containerWidth = containerRef.current.clientWidth;
        setShouldScroll(textWidth > containerWidth);
        // Set CSS variable for scroll distance
        if (textWidth > containerWidth) {
          textRef.current.style.setProperty('--scroll-distance', `-${textWidth - containerWidth + 16}px`);
        }
      }
    };
    checkOverflow();
    window.addEventListener('resize', checkOverflow);
    return () => window.removeEventListener('resize', checkOverflow);
  }, [album.name]);

  return (
    <div
      className={[
        'album-item',
        'flex items-center gap-3 p-2.5 rounded-lg',
        'transition-all duration-200',
        'group relative',
        // Staggered fade-in animation
        'animate-queue-item-in',
        // Alternating backgrounds
        isEven ? '' : 'bg-white/[0.02]',
        // Hover effect with purple tint
        'hover:bg-white/[0.05]',
      ].filter(Boolean).join(' ')}
      style={{
        '--animation-delay': animationDelay,
        animationDelay: animationDelay
      }}
      role="listitem"
      aria-label={`Album: ${album.name}`}
    >
      {/* Cover image thumbnail with play overlay */}
      <div className="w-10 h-10 rounded overflow-hidden bg-white/10 flex-shrink-0 relative group/cover">
        {album.coverImage ? (
          <img
            src={album.coverImage}
            alt={album.name}
            className="w-full h-full object-cover"
            loading="lazy"
          />
        ) : (
          <div className="w-full h-full flex items-center justify-center bg-white/5">
            <AlbumIcon size={20} className="text-text-muted" />
          </div>
        )}
        {isLoading ? (
          <div className="absolute inset-0 bg-black/50 flex items-center justify-center">
            <div className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />
          </div>
        ) : (
          /* Play button overlay on hover */
          <button
            onClick={() => onPlay?.(album)}
            className="absolute inset-0 bg-black/60 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity duration-150 cursor-pointer"
            title="Play album"
            aria-label={`Play album ${album.name}`}
          >
            <Play size={16} className="text-white" aria-hidden="true" />
          </button>
        )}
      </div>

      {/* Album info */}
      <div className="flex-1 min-w-0">
        <div
          ref={containerRef}
          className="marquee-container overflow-hidden"
        >
          <p
            ref={textRef}
            className={`
              font-heading text-sm font-semibold text-primary
              whitespace-nowrap inline-block
              ${shouldScroll ? 'marquee-text should-scroll' : ''}
            `}
          >
            {album.name}
          </p>
        </div>
        <p className="text-xs text-text-muted mt-0.5">
          {album.spotifyUrl?.includes('playlist') ? 'Playlist' : 'Album'}
        </p>
      </div>

      {/* Delete button - visible on hover */}
      <button
        onClick={() => onDelete?.(album)}
        disabled={isLoading}
        className={[
          'text-text-muted hover:text-red-400 transition-all duration-150',
          'p-1.5 rounded hover:bg-red-400/10',
          'focus-ring min-w-[32px] min-h-[32px]',
          'flex items-center justify-center',
          'opacity-0 w-0 overflow-hidden group-hover:opacity-100 group-hover:w-auto focus-within:opacity-100',
          isLoading && 'opacity-50 cursor-not-allowed'
        ].filter(Boolean).join(' ')}
        title="Delete album"
        aria-label={`Delete album ${album.name}`}
      >
        <Remove size={14} aria-hidden="true" />
      </button>

      {/* Purple accent bar on hover - subtle visual distinction for albums */}
      <div
        className="absolute left-0 top-1/2 -translate-y-1/2 w-0.5 h-0 bg-purple-500 rounded-full opacity-0 group-hover:h-6 group-hover:opacity-100 transition-all duration-200"
        aria-hidden="true"
      />
    </div>
  );
}

export default AlbumItem;
