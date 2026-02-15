import { useState, useRef, useEffect, useCallback } from 'react';
import { useAuth } from '../context/AuthContext';

// Debounce helper
function useDebounce(value, delay) {
  const [debouncedValue, setDebouncedValue] = useState(value);

  useEffect(() => {
    const timer = setTimeout(() => setDebouncedValue(value), delay);
    return () => clearTimeout(timer);
  }, [value, delay]);

  return debouncedValue;
}

// Format duration from seconds to mm:ss
function formatDuration(seconds) {
  if (!seconds) return '--:--';
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${mins}:${secs.toString().padStart(2, '0')}`;
}

// Search icon SVG
function SearchIcon({ className = '' }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <circle cx="11" cy="11" r="8" />
      <path d="M21 21l-4.35-4.35" />
    </svg>
  );
}

// Loading spinner
function LoadingSpinner({ className = '' }) {
  return (
    <svg
      className={`animate-spin ${className}`}
      viewBox="0 0 24 24"
      fill="none"
    >
      <circle
        className="opacity-25"
        cx="12"
        cy="12"
        r="10"
        stroke="currentColor"
        strokeWidth="3"
      />
      <path
        className="opacity-75"
        fill="currentColor"
        d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
      />
    </svg>
  );
}

// Music note icon for fallback thumbnail
function MusicNoteIcon({ className = '' }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="currentColor"
    >
      <path d="M12 3v10.55c-.59-.34-1.27-.55-2-.55-2.21 0-4 1.79-4 4s1.79 4 4 4 4-1.79 4-4V7h4V3h-6z" />
    </svg>
  );
}

// Suggestion item component
function SuggestionItem({ track, onSelect, isHighlighted, id }) {
  return (
    <button
      type="button"
      id={id}
      onClick={() => onSelect(track)}
      role="option"
      aria-selected={isHighlighted}
      className={`
        w-full flex items-center gap-3 px-3 py-2.5 text-left transition-all
        min-h-[48px] focus-ring
        ${isHighlighted
          ? 'bg-accent-muted'
          : 'hover:bg-[var(--color-bg-elevated)]'
        }
      `}
      style={{
        borderRadius: 'var(--radius-md)',
      }}
    >
      {/* Thumbnail */}
      <div
        className="relative flex-shrink-0 overflow-hidden"
        style={{
          width: '48px',
          height: '36px',
          borderRadius: 'var(--radius-sm)',
          backgroundColor: 'var(--color-bg-elevated)',
        }}
      >
        {track.thumbnail ? (
          <img
            src={track.thumbnail}
            alt=""
            className="w-full h-full object-cover"
            loading="lazy"
          />
        ) : (
          <div className="w-full h-full flex items-center justify-center">
            <MusicNoteIcon className="w-5 h-5 text-muted" />
          </div>
        )}
        {/* Duration badge */}
        {track.duration && (
          <span
            className="absolute bottom-0.5 right-0.5 px-1 text-[10px] font-mono"
            style={{
              backgroundColor: 'rgba(0,0,0,0.8)',
              borderRadius: 'var(--radius-sm)',
              color: 'var(--color-text-primary)',
            }}
          >
            {formatDuration(track.duration)}
          </span>
        )}
      </div>

      {/* Track info */}
      <div className="flex-1 min-w-0">
        <p
          className="text-sm font-medium truncate"
          style={{ color: 'var(--color-text-primary)' }}
        >
          {track.title}
        </p>
        {track.artist && (
          <p
            className="text-xs truncate"
            style={{ color: 'var(--color-text-secondary)' }}
          >
            {track.artist}
          </p>
        )}
      </div>
    </button>
  );
}

export function SearchBar({ onAdd, disabled }) {
  const { token } = useAuth();
  const [query, setQuery] = useState('');
  const [loading, setLoading] = useState(false);
  const [suggestions, setSuggestions] = useState([]);
  const [showSuggestions, setShowSuggestions] = useState(false);
  const [highlightedIndex, setHighlightedIndex] = useState(-1);
  const [isFocused, setIsFocused] = useState(false);

  const inputRef = useRef(null);
  const containerRef = useRef(null);
  const suggestionsRef = useRef(null);

  const debouncedQuery = useDebounce(query, 300);

  // Fetch suggestions when query changes
  useEffect(() => {
    const fetchSuggestions = async () => {
      // Don't search for URLs or very short queries
      if (!debouncedQuery || debouncedQuery.length < 2 || isUrl(debouncedQuery)) {
        setSuggestions([]);
        return;
      }

      try {
        const response = await fetch(
          `/api/queue/search?q=${encodeURIComponent(debouncedQuery)}&limit=5`,
          {
            headers: {
              Authorization: `Bearer ${token}`,
            },
          }
        );

        if (response.ok) {
          const data = await response.json();
          setSuggestions(data.results || []);
        }
      } catch (error) {
        console.error('Search suggestions error:', error);
        setSuggestions([]);
      }
    };

    fetchSuggestions();
  }, [debouncedQuery, token]);

  // Check if string is a URL
  const isUrl = (str) => {
    return str.startsWith('http://') ||
           str.startsWith('https://') ||
           str.includes('youtube.com') ||
           str.includes('youtu.be') ||
           str.includes('spotify.com');
  };

  // Handle click outside to close suggestions
  useEffect(() => {
    const handleClickOutside = (event) => {
      if (containerRef.current && !containerRef.current.contains(event.target)) {
        setShowSuggestions(false);
      }
    };

    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  // Handle form submission
  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!query.trim() || loading) return;

    setLoading(true);
    setShowSuggestions(false);
    try {
      await onAdd(query);
      setQuery('');
      setSuggestions([]);
    } finally {
      setLoading(false);
    }
  };

  // Handle suggestion selection
  const handleSelectSuggestion = useCallback(async (track) => {
    setLoading(true);
    setShowSuggestions(false);
    setQuery('');
    setSuggestions([]);

    try {
      // Add the track URL directly
      await onAdd(track.url);
    } finally {
      setLoading(false);
    }
  }, [onAdd]);

  // Keyboard navigation
  const handleKeyDown = (e) => {
    if (!showSuggestions || suggestions.length === 0) {
      if (e.key === 'Escape') {
        inputRef.current?.blur();
      }
      return;
    }

    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        setHighlightedIndex((prev) =>
          prev < suggestions.length - 1 ? prev + 1 : 0
        );
        break;
      case 'ArrowUp':
        e.preventDefault();
        setHighlightedIndex((prev) =>
          prev > 0 ? prev - 1 : suggestions.length - 1
        );
        break;
      case 'Enter':
        if (highlightedIndex >= 0 && suggestions[highlightedIndex]) {
          e.preventDefault();
          handleSelectSuggestion(suggestions[highlightedIndex]);
        }
        break;
      case 'Escape':
        setShowSuggestions(false);
        setHighlightedIndex(-1);
        break;
    }
  };

  // Reset highlighted index when suggestions change
  useEffect(() => {
    setHighlightedIndex(-1);
  }, [suggestions]);

  const hasSuggestions = suggestions.length > 0 && showSuggestions;

  return (
    <div ref={containerRef} className="relative">
      <form onSubmit={handleSubmit} className="relative">
        {/* Search input container */}
        <div
          className={`
            relative flex items-center overflow-hidden transition-all
            ${isFocused ? 'glow-accent' : ''}
          `}
          style={{
            backgroundColor: 'var(--color-bg-elevated)',
            borderRadius: hasSuggestions ? 'var(--radius-lg) var(--radius-lg) 0 0' : 'var(--radius-lg)',
            border: `1px solid ${isFocused ? 'var(--color-accent)' : 'var(--color-border)'}`,
            transition: 'all var(--transition-base)',
          }}
        >
          {/* Search icon */}
          <div
            className="flex-shrink-0 pl-4 pr-2 flex items-center justify-center transition-all"
            style={{
              color: isFocused ? 'var(--color-accent)' : 'var(--color-text-muted)',
              transition: 'all var(--transition-base)',
            }}
          >
            <SearchIcon
              className={`w-5 h-5 transition-transform ${isFocused ? 'scale-110' : 'scale-100'}`}
              style={{ transitionDuration: '200ms' }}
            />
          </div>

          {/* Input field */}
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setShowSuggestions(true);
            }}
            onFocus={() => {
              setIsFocused(true);
              if (suggestions.length > 0) setShowSuggestions(true);
            }}
            onBlur={() => setIsFocused(false)}
            onKeyDown={handleKeyDown}
            placeholder="Search for songs, artists, or paste a URL..."
            disabled={disabled || loading}
            className="flex-1 bg-transparent py-3.5 pr-2 outline-none disabled:opacity-50"
            style={{
              fontFamily: 'var(--font-body)',
              fontSize: '0.9375rem',
              color: 'var(--color-text-primary)',
            }}
            autoComplete="off"
            spellCheck="false"
            aria-label="Search for music"
            aria-autocomplete="list"
            aria-expanded={hasSuggestions}
            aria-controls={hasSuggestions ? 'search-suggestions' : undefined}
            aria-activedescendant={highlightedIndex >= 0 ? `suggestion-${highlightedIndex}` : undefined}
            role="combobox"
          />

          {/* Add button */}
          <button
            type="submit"
            disabled={disabled || loading || !query.trim()}
            aria-label={loading ? 'Adding track...' : 'Add track to queue'}
            className="
              flex-shrink-0 px-5 py-2 mr-1.5 font-medium
              min-h-[40px] min-w-[60px]
              disabled:opacity-40 disabled:cursor-not-allowed
              transition-all active:scale-95 focus-ring
            "
            style={{
              fontFamily: 'var(--font-heading)',
              fontWeight: 'var(--font-weight-semibold)',
              fontSize: '0.875rem',
              backgroundColor: disabled || loading || !query.trim()
                ? 'var(--color-bg-raised)'
                : 'var(--color-accent)',
              color: disabled || loading || !query.trim()
                ? 'var(--color-text-muted)'
                : 'var(--color-text-inverse)',
              borderRadius: 'var(--radius-full)',
              transition: 'all var(--transition-base)',
            }}
            onMouseEnter={(e) => {
              if (!e.currentTarget.disabled) {
                e.currentTarget.style.backgroundColor = 'var(--color-accent-hover)';
                e.currentTarget.style.transform = 'scale(1.02)';
              }
            }}
            onMouseLeave={(e) => {
              if (!e.currentTarget.disabled) {
                e.currentTarget.style.backgroundColor = 'var(--color-accent)';
                e.currentTarget.style.transform = 'scale(1)';
              }
            }}
          >
            {loading ? (
              <LoadingSpinner className="w-4 h-4" />
            ) : (
              'Add'
            )}
          </button>
        </div>

        {/* Placeholder styling override */}
        <style>{`
          input::placeholder {
            color: var(--color-text-muted);
            font-style: normal;
            opacity: 1;
          }
        `}</style>
      </form>

      {/* Suggestions dropdown */}
      {hasSuggestions && (
        <div
          ref={suggestionsRef}
          id="search-suggestions"
          role="listbox"
          aria-label="Search suggestions"
          className="absolute left-0 right-0 z-50 animate-fade-in"
          style={{
            backgroundColor: 'var(--color-bg-elevated)',
            borderRadius: '0 0 var(--radius-lg) var(--radius-lg)',
            borderLeft: '1px solid var(--color-accent)',
            borderRight: '1px solid var(--color-accent)',
            borderBottom: '1px solid var(--color-accent)',
            boxShadow: '0 8px 32px rgba(0, 0, 0, 0.4)',
            overflow: 'hidden',
          }}
        >
          {/* Subtle separator */}
          <div
            className="mx-3"
            style={{
              height: '1px',
              backgroundColor: 'var(--color-border)',
            }}
            aria-hidden="true"
          />

          {/* Suggestions list */}
          <div className="p-1.5 max-h-80 overflow-y-auto">
            <div
              className="px-2 py-1.5 text-label"
              style={{
                fontSize: '0.6875rem',
                letterSpacing: '0.1em',
              }}
              id="search-results-label"
            >
              SEARCH RESULTS
            </div>

            {suggestions.map((track, index) => (
              <SuggestionItem
                key={track.url || index}
                track={track}
                onSelect={handleSelectSuggestion}
                isHighlighted={index === highlightedIndex}
                id={`suggestion-${index}`}
              />
            ))}
          </div>

          {/* Keyboard hint */}
          <div
            className="flex items-center justify-end gap-3 px-3 py-2 text-xs"
            style={{
              borderTop: '1px solid var(--color-border)',
              color: 'var(--color-text-muted)',
            }}
          >
            <span className="flex items-center gap-1">
              <kbd
                className="px-1.5 py-0.5 text-[10px] font-mono rounded"
                style={{
                  backgroundColor: 'var(--color-bg-raised)',
                  border: '1px solid var(--color-border)',
                }}
              >
                ↑↓
              </kbd>
              navigate
            </span>
            <span className="flex items-center gap-1">
              <kbd
                className="px-1.5 py-0.5 text-[10px] font-mono rounded"
                style={{
                  backgroundColor: 'var(--color-bg-raised)',
                  border: '1px solid var(--color-border)',
                }}
              >
                ↵
              </kbd>
              select
            </span>
            <span className="flex items-center gap-1">
              <kbd
                className="px-1.5 py-0.5 text-[10px] font-mono rounded"
                style={{
                  backgroundColor: 'var(--color-bg-raised)',
                  border: '1px solid var(--color-border)',
                }}
              >
                esc
              </kbd>
              close
            </span>
          </div>
        </div>
      )}
    </div>
  );
}
