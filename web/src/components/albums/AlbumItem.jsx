import { useState, useRef, useEffect } from 'react';
import { Play, Remove } from '../icons';

const CHIP_COLORS = ['#e8c87a', '#9b7fe8', '#7ec87a', '#e87a7a', '#7ac4e8', '#e8a87a'];

/**
 * AlbumItem — Wave `pl-sidebar-item` style
 *
 * - 30x30 color-coded thumbnail (rounded 6px, surface3 background)
 * - Playlist name: 12px, font-weight 500, truncated
 * - Track count: 11px, muted color
 * - Hover: surface2 background
 * - Staggered list animations (delay by index * 50ms)
 * - Marquee text for long names
 */
export function AlbumItem({ album, index = 0, isLoading = false, onPlay, onDelete, onInspect }) {
  const [shouldScroll, setShouldScroll] = useState(false);
  const [isHovered, setIsHovered] = useState(false);
  const textRef = useRef(null);
  const containerRef = useRef(null);

  const animationDelay = `${index * 50}ms`;
  const chipColor = CHIP_COLORS[index % CHIP_COLORS.length];

  // Check if text overflows for marquee
  useEffect(() => {
    const checkOverflow = () => {
      if (textRef.current && containerRef.current) {
        const textWidth = textRef.current.scrollWidth;
        const containerWidth = containerRef.current.clientWidth;
        setShouldScroll(textWidth > containerWidth);
        if (textWidth > containerWidth) {
          textRef.current.style.setProperty(
            '--scroll-distance',
            `-${textWidth - containerWidth + 16}px`
          );
        }
      }
    };
    checkOverflow();
    window.addEventListener('resize', checkOverflow);
    return () => window.removeEventListener('resize', checkOverflow);
  }, [album.name]);

  const handleClick = (e) => {
    if (!e.target.closest('.album-thumbnail') && !e.target.closest('.delete-button')) {
      onInspect?.(album);
    }
  };

  const trackCount =
    album.trackCount ?? (album.spotifyUrl?.includes('playlist') ? 'Playlist' : 'Album');
  const trackLabel = typeof trackCount === 'number' ? `${trackCount} songs` : trackCount;

  return (
    <div
      className="animate-queue-item-in"
      onClick={handleClick}
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
      role="listitem"
      aria-label={`Playlist: ${album.name}`}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: '9px',
        padding: '7px 10px',
        borderRadius: '8px',
        cursor: 'pointer',
        transition: 'background 0.12s',
        backgroundColor: isHovered ? 'var(--color-bg-elevated)' : 'transparent',
        position: 'relative',
        animationDelay,
        '--animation-delay': animationDelay
      }}
    >
      {/* Color-coded thumbnail */}
      <div
        className="album-thumbnail"
        style={{
          width: '30px',
          height: '30px',
          borderRadius: '6px',
          flexShrink: 0,
          backgroundColor: `${chipColor}18`,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          fontSize: '13px',
          overflow: 'hidden',
          position: 'relative'
        }}
      >
        {album.coverImage ? (
          <img
            src={album.coverImage}
            alt={album.name}
            style={{ width: '100%', height: '100%', objectFit: 'cover' }}
            loading="lazy"
          />
        ) : (
          <span style={{ color: chipColor }}>{String.fromCodePoint(0x1f3b5)}</span>
        )}

        {/* Loading overlay on thumbnail */}
        {isLoading && (
          <div
            style={{
              position: 'absolute',
              inset: 0,
              backgroundColor: 'rgba(0,0,0,0.5)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center'
            }}
          >
            <div
              style={{
                width: '12px',
                height: '12px',
                border: '2px solid rgba(255,255,255,0.3)',
                borderTopColor: '#fff',
                borderRadius: '50%',
                animation: 'spin 0.7s linear infinite'
              }}
            />
          </div>
        )}

        {/* Play overlay on hover (thumbnail click area) */}
        {isHovered && !isLoading && (
          <button
            onClick={(e) => {
              e.stopPropagation();
              onPlay?.(album);
            }}
            title="Play playlist"
            aria-label={`Play playlist ${album.name}`}
            style={{
              position: 'absolute',
              inset: 0,
              backgroundColor: 'rgba(0,0,0,0.55)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              border: 'none',
              cursor: 'pointer',
              padding: 0
            }}
          >
            <Play size={12} className="text-white" />
          </button>
        )}
      </div>

      {/* Playlist info */}
      <div style={{ flex: 1, minWidth: 0 }}>
        <div ref={containerRef} style={{ overflow: 'hidden' }}>
          <span
            ref={textRef}
            className={shouldScroll ? 'marquee-text should-scroll' : ''}
            style={{
              fontSize: '12px',
              fontWeight: 500,
              color: 'var(--color-text-primary)',
              whiteSpace: 'nowrap',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              display: 'block'
            }}
          >
            {album.name}
          </span>
        </div>
        <span
          style={{
            fontSize: '11px',
            color: 'var(--color-text-muted)'
          }}
        >
          {trackLabel}
        </span>
      </div>

      {/* Delete button — visible on hover */}
      {isHovered && (
        <button
          className="delete-button"
          onClick={(e) => {
            e.stopPropagation();
            onDelete?.(album);
          }}
          disabled={isLoading}
          title="Delete playlist"
          aria-label={`Delete playlist ${album.name}`}
          style={{
            background: 'none',
            border: 'none',
            color: 'var(--color-text-muted)',
            cursor: 'pointer',
            padding: '3px',
            borderRadius: '4px',
            flexShrink: 0,
            display: 'flex',
            transition: 'all 0.12s'
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.color = 'var(--color-danger)';
            e.currentTarget.style.backgroundColor = 'rgba(232,122,122,0.1)';
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.color = 'var(--color-text-muted)';
            e.currentTarget.style.backgroundColor = 'transparent';
          }}
        >
          <Remove size={12} />
        </button>
      )}
    </div>
  );
}

export default AlbumItem;
