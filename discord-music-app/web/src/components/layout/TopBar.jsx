import { useState, useRef, useEffect, useCallback } from 'react';
import { Speaker } from '../icons/index.jsx';
import { useAuth } from '../../context/AuthContext';
import { formatTime } from '../../utils/formatTime.js';

/**
 * TopBar component with integrated search
 *
 * New layout following UI-REWORK.md:
 * ┌─────────────────────────────────────────────────────────────────────────┐
 * │ Logo | [────────── Search Field ──────────] | Server Name | User Avatar │
 * └─────────────────────────────────────────────────────────────────────────┘
 */

// Debounce helper
function useDebounce(value, delay) {
  const [debouncedValue, setDebouncedValue] = useState(value);

  useEffect(() => {
    const timer = setTimeout(() => setDebouncedValue(value), delay);
    return () => clearTimeout(timer);
  }, [value, delay]);

  return debouncedValue;
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
    <svg className={`animate-spin ${className}`} viewBox="0 0 24 24" fill="none">
      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" />
      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
    </svg>
  );
}

// Music note icon for fallback thumbnail
function MusicNoteIcon({ className = '' }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="currentColor">
      <path d="M12 3v10.55c-.59-.34-1.27-.55-2-.55-2.21 0-4 1.79-4 4s1.79 4 4 4 4-1.79 4-4V7h4V3h-6z" />
    </svg>
  );
}

// Integrated search bar for TopBar
function IntegratedSearchBar({ onAdd, disabled }) {
  const { token } = useAuth();
  const [query, setQuery] = useState('');
  const [loading, setLoading] = useState(false);
  const [suggestions, setSuggestions] = useState([]);
  const [showSuggestions, setShowSuggestions] = useState(false);
  const [highlightedIndex, setHighlightedIndex] = useState(-1);
  const [isFocused, setIsFocused] = useState(false);

  const inputRef = useRef(null);
  const containerRef = useRef(null);

  const debouncedQuery = useDebounce(query, 300);

  // Check if string is a URL
  const isUrl = (str) => {
    return str.startsWith('http://') ||
           str.startsWith('https://') ||
           str.includes('youtube.com') ||
           str.includes('youtu.be') ||
           str.includes('spotify.com');
  };

  // Fetch suggestions when query changes
  useEffect(() => {
    const fetchSuggestions = async () => {
      if (!debouncedQuery || debouncedQuery.length < 2 || isUrl(debouncedQuery)) {
        setSuggestions([]);
        return;
      }

      try {
        const response = await fetch(
          `/api/queue/search?q=${encodeURIComponent(debouncedQuery)}&limit=5`,
          { headers: { Authorization: `Bearer ${token}` } }
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
        setHighlightedIndex((prev) => prev < suggestions.length - 1 ? prev + 1 : 0);
        break;
      case 'ArrowUp':
        e.preventDefault();
        setHighlightedIndex((prev) => prev > 0 ? prev - 1 : suggestions.length - 1);
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
    <div ref={containerRef} className="relative flex-1 max-w-xl">
      <form onSubmit={handleSubmit} className="relative">
        <div
          className={`relative flex items-center overflow-hidden transition-all duration-200 ${
            isFocused ? 'ring-2 ring-accent/50' : ''
          }`}
          style={{
            backgroundColor: isFocused ? 'var(--color-bg-elevated)' : 'var(--color-bg)',
            borderRadius: hasSuggestions ? '12px 12px 0 0' : '12px',
            border: `1px solid ${isFocused ? 'var(--color-accent)' : 'var(--color-border)'}`,
          }}
        >
          <div
            className="flex-shrink-0 pl-4 pr-2 flex items-center justify-center transition-all duration-200"
            style={{ color: isFocused ? 'var(--color-accent)' : 'var(--color-text-muted)' }}
          >
            <SearchIcon className={`w-4 h-4 transition-transform duration-200 ${isFocused ? 'scale-110' : 'scale-100'}`} />
          </div>

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
            placeholder="Search for songs or paste a URL..."
            disabled={disabled || loading}
            className="flex-1 bg-transparent py-2.5 pr-2 outline-none disabled:opacity-50 text-sm"
            style={{
              fontFamily: 'var(--font-body)',
              color: 'var(--color-text-primary)',
            }}
            autoComplete="off"
            spellCheck="false"
            aria-label="Search for music"
            aria-autocomplete="list"
            aria-expanded={hasSuggestions}
            role="combobox"
          />

          <button
            type="submit"
            disabled={disabled || loading || !query.trim()}
            className="flex-shrink-0 px-4 py-1.5 mr-1.5 font-medium text-sm min-h-[32px] disabled:opacity-40 disabled:cursor-not-allowed transition-all duration-200 active:scale-95"
            style={{
              fontFamily: 'var(--font-heading)',
              fontWeight: 600,
              backgroundColor: disabled || loading || !query.trim()
                ? 'var(--color-bg-raised)'
                : 'var(--color-accent)',
              color: disabled || loading || !query.trim()
                ? 'var(--color-text-muted)'
                : 'var(--color-text-inverse)',
              borderRadius: '8px',
            }}
          >
            {loading ? <LoadingSpinner className="w-4 h-4" /> : 'Add'}
          </button>
        </div>

        <style>{`
          input::placeholder {
            color: var(--color-text-muted);
            opacity: 1;
          }
        `}</style>
      </form>

      {/* Suggestions dropdown */}
      {hasSuggestions && (
        <div
          className="absolute left-0 right-0 z-50 animate-fade-in"
          style={{
            backgroundColor: 'var(--color-bg-elevated)',
            borderRadius: '0 0 12px 12px',
            borderLeft: '1px solid var(--color-accent)',
            borderRight: '1px solid var(--color-accent)',
            borderBottom: '1px solid var(--color-accent)',
            boxShadow: '0 8px 32px rgba(0, 0, 0, 0.4)',
          }}
        >
          <div className="mx-3" style={{ height: '1px', backgroundColor: 'var(--color-border)' }} />

          <div className="p-1.5 max-h-80 overflow-y-auto">
            <div className="px-2 py-1.5 text-[10px] font-semibold uppercase tracking-wider" style={{ color: 'var(--color-text-muted)' }}>
              SEARCH RESULTS
            </div>

            {suggestions.map((track, index) => (
              <button
                key={track.url || index}
                type="button"
                onClick={() => handleSelectSuggestion(track)}
                className={`w-full flex items-center gap-3 px-2.5 py-2 text-left transition-all duration-150 rounded-lg ${
                  index === highlightedIndex ? 'bg-accent-muted' : 'hover:bg-[var(--color-bg)]'
                }`}
              >
                <div className="relative flex-shrink-0 overflow-hidden rounded" style={{ width: '40px', height: '30px', backgroundColor: 'var(--color-bg)' }}>
                  {track.thumbnail ? (
                    <img src={track.thumbnail} alt="" className="w-full h-full object-cover" loading="lazy" />
                  ) : (
                    <div className="w-full h-full flex items-center justify-center">
                      <MusicNoteIcon className="w-4 h-4 text-muted" />
                    </div>
                  )}
                  {track.duration && (
                    <span className="absolute bottom-0.5 right-0.5 px-1 text-[9px] font-mono rounded" style={{ backgroundColor: 'rgba(0,0,0,0.8)', color: 'white' }}>
                      {formatTime(track.duration)}
                    </span>
                  )}
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium truncate" style={{ color: 'var(--color-text-primary)' }}>{track.title}</p>
                  {track.artist && <p className="text-xs truncate" style={{ color: 'var(--color-text-secondary)' }}>{track.artist}</p>}
                </div>
              </button>
            ))}
          </div>

          <div className="flex items-center justify-end gap-3 px-3 py-2 text-xs" style={{ borderTop: '1px solid var(--color-border)', color: 'var(--color-text-muted)' }}>
            <span className="flex items-center gap-1">
              <kbd className="px-1 py-0.5 text-[9px] font-mono rounded" style={{ backgroundColor: 'var(--color-bg-raised)', border: '1px solid var(--color-border)' }}>↑↓</kbd>
              navigate
            </span>
            <span className="flex items-center gap-1">
              <kbd className="px-1 py-0.5 text-[9px] font-mono rounded" style={{ backgroundColor: 'var(--color-bg-raised)', border: '1px solid var(--color-border)' }}>↵</kbd>
              select
            </span>
          </div>
        </div>
      )}
    </div>
  );
}

export function TopBar({ voiceContext, connected, user, onLogout, onAdd, searchDisabled }) {
  const getAvatarUrl = () => {
    if (!user?.avatar || !user?.discord_id) return null;
    return `https://cdn.discordapp.com/avatars/${user.discord_id}/${user.avatar}.png`;
  };

  const avatarUrl = getAvatarUrl();

  return (
    <header
      className="h-16 flex items-center justify-between px-4 sm:px-6 flex-shrink-0 border-b gap-4"
      style={{
        backgroundColor: 'var(--color-bg-elevated)',
        borderColor: 'var(--color-border)'
      }}
    >
      {/* Left section: Connection status */}
      <div className="flex items-center gap-3 flex-shrink-0">
        {voiceContext?.channelName ? (
          <div className="flex items-center gap-2">
            {/* Connection indicator */}
            <div className={`w-2 h-2 rounded-full ${connected ? 'bg-accent animate-pulse' : 'bg-red-500'}`} />

            {/* Server info */}
            {voiceContext.guildIcon ? (
              <img src={voiceContext.guildIcon} alt="" className="w-6 h-6 rounded-full" />
            ) : (
              <div className="w-6 h-6 rounded-full flex items-center justify-center text-xs font-medium" style={{ backgroundColor: 'var(--color-bg)', color: 'var(--color-text-secondary)' }}>
                {voiceContext.guildName?.charAt(0) || '?'}
              </div>
            )}

            {/* Channel name - hidden on mobile */}
            <div className="hidden sm:flex items-center gap-2" style={{ color: 'var(--color-text-secondary)' }}>
              <Speaker size={14} className="text-accent/70" />
              <span className="text-sm font-medium">{voiceContext.channelName}</span>
            </div>
          </div>
        ) : (
          <span className="text-xs sm:text-sm" style={{ color: 'var(--color-text-muted)' }}>
            Not connected
          </span>
        )}
      </div>

      {/* Center: Search bar */}
      <IntegratedSearchBar onAdd={onAdd} disabled={searchDisabled} />

      {/* Right section: User info */}
      <div className="flex items-center gap-2 sm:gap-3 flex-shrink-0">
        {user && (
          <>
            <span className="hidden sm:block text-sm" style={{ color: 'var(--color-text-secondary)' }}>{user.username}</span>
            {avatarUrl ? (
              <img src={avatarUrl} alt={user.username} className="w-8 h-8 rounded-full" />
            ) : (
              <div className="w-8 h-8 rounded-full flex items-center justify-center text-sm font-medium" style={{ backgroundColor: 'var(--color-bg)', color: 'var(--color-text-secondary)' }}>
                {user.username?.charAt(0) || '?'}
              </div>
            )}
            <button
              onClick={onLogout}
              className="hidden sm:block text-xs transition-colors px-2.5 py-1.5 rounded-lg hover:bg-white/10"
              style={{ color: 'var(--color-text-secondary)' }}
            >
              Logout
            </button>
          </>
        )}
      </div>
    </header>
  );
}
