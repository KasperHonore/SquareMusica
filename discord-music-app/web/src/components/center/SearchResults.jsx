import { formatTime } from '../../utils/formatTime';

/**
 * SearchResults - Inline result rows replacing dropdown autocomplete
 * Matches new_ui/player.html `.result-item`
 */
export function SearchResults({ results, loading, highlightedIndex, onAdd, onHighlight }) {
  if (loading) {
    return (
      <div style={{ padding: '40px 20px', textAlign: 'center' }}>
        <div
          style={{
            width: '14px',
            height: '14px',
            border: '2px solid var(--color-border)',
            borderTopColor: 'var(--color-accent)',
            borderRadius: '50%',
            animation: 'spin 0.7s linear infinite',
            display: 'inline-block'
          }}
        />
        <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
      </div>
    );
  }

  if (results.length === 0) {
    return (
      <div
        style={{
          padding: '40px 20px',
          textAlign: 'center',
          color: 'var(--color-text-muted)',
          fontSize: '13px',
          lineHeight: 1.7
        }}
      >
        No results found. Try a different search term.
      </div>
    );
  }

  return (
    <div role="listbox" aria-label="Search results">
      {results.map((track, index) => (
        <div
          key={track.url || index}
          role="option"
          aria-selected={index === highlightedIndex}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: '12px',
            padding: '9px 10px',
            borderRadius: '9px',
            cursor: 'pointer',
            transition: 'background 0.1s',
            background: index === highlightedIndex ? 'var(--color-bg-elevated)' : 'transparent',
            animationDelay: `${index * 50}ms`
          }}
          className="wave-result-item"
          onMouseEnter={(e) => {
            e.currentTarget.style.background = 'var(--color-bg-elevated)';
            onHighlight?.(index);
          }}
          onMouseLeave={(e) => {
            if (index !== highlightedIndex) {
              e.currentTarget.style.background = 'transparent';
            }
          }}
          onClick={() => onAdd(track.url)}
        >
          {/* Thumbnail */}
          <div
            style={{
              width: '48px',
              height: '36px',
              borderRadius: '5px',
              flexShrink: 0,
              overflow: 'hidden',
              background: 'var(--color-bg-surface3)'
            }}
          >
            {track.thumbnail ? (
              <img
                src={track.thumbnail}
                alt=""
                loading="lazy"
                style={{ width: '100%', height: '100%', objectFit: 'cover' }}
              />
            ) : (
              <div
                style={{
                  width: '100%',
                  height: '100%',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  color: 'var(--color-text-muted)',
                  fontSize: '14px'
                }}
              >
                &#9835;
              </div>
            )}
          </div>

          {/* Info */}
          <div style={{ flex: 1, minWidth: 0 }}>
            <div
              style={{
                fontSize: '13px',
                fontWeight: 500,
                whiteSpace: 'nowrap',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                color: 'var(--color-text-primary)'
              }}
            >
              {track.title}
            </div>
            <div
              style={{
                fontSize: '11px',
                color: 'var(--color-text-muted)',
                marginTop: '2px'
              }}
            >
              {track.artist || track.channel || ''}
            </div>
          </div>

          {/* Duration */}
          <div
            style={{
              fontSize: '11px',
              color: 'var(--color-text-muted)',
              flexShrink: 0
            }}
          >
            {formatTime(track.duration)}
          </div>

          {/* Add button */}
          <button
            onClick={(e) => {
              e.stopPropagation();
              onAdd(track.url);
            }}
            style={{
              background: 'rgba(232,200,122,0.1)',
              border: '1px solid rgba(232,200,122,0.2)',
              color: 'var(--color-accent)',
              borderRadius: '6px',
              padding: '5px 10px',
              fontSize: '11px',
              fontWeight: 600,
              cursor: 'pointer',
              fontFamily: 'var(--font-body)',
              transition: 'background 0.12s',
              whiteSpace: 'nowrap'
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.background = 'rgba(232,200,122,0.18)';
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.background = 'rgba(232,200,122,0.1)';
            }}
          >
            + Add
          </button>
        </div>
      ))}
    </div>
  );
}
