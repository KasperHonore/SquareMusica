import { useState, useEffect, useRef, useCallback } from 'react';
import { useAuth } from '../../context/AuthContext';
import { useSocketContext } from '../../context/SocketContext';
import { BrowseView } from './BrowseView';
import { SearchResults } from './SearchResults';
import { PlaylistsView } from './PlaylistsView';
import { History } from '../../pages/History';

// Debounce hook
function useDebounce(value, delay) {
  const [debouncedValue, setDebouncedValue] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebouncedValue(value), delay);
    return () => clearTimeout(timer);
  }, [value, delay]);
  return debouncedValue;
}

// Time-aware greeting
function getGreeting() {
  const h = new Date().getHours();
  if (h < 12) return 'Good morning';
  if (h < 18) return 'Good afternoon';
  return 'Good evening';
}

// URL detection
function isUrl(str) {
  return (
    str.startsWith('http://') ||
    str.startsWith('https://') ||
    str.includes('youtube.com') ||
    str.includes('youtu.be') ||
    str.includes('spotify.com')
  );
}

/**
 * CenterPanel - Hero greeting, search bar, and content area
 * Matches new_ui/player.html center / discovery layout
 */
export function CenterPanel({
  activeView,
  onViewChange,
  selectedPlaylist,
  onSelectPlaylist,
  onClearSelectedPlaylist
}) {
  const { user, token } = useAuth();
  const { addToQueue, playerState, albums, createPlaylist, loadAlbum, historyVersion } =
    useSocketContext();
  const [query, setQuery] = useState('');
  const [searchResults, setSearchResults] = useState([]);
  const [searchLoading, setSearchLoading] = useState(false);
  const [highlightedIndex, setHighlightedIndex] = useState(-1);
  const [isSearching, setIsSearching] = useState(false);
  const inputRef = useRef(null);

  const debouncedQuery = useDebounce(query, 400);

  // Fetch search results
  useEffect(() => {
    const fetchResults = async () => {
      if (!debouncedQuery || debouncedQuery.length < 2 || isUrl(debouncedQuery)) {
        setSearchResults([]);
        setSearchLoading(false);
        if (!debouncedQuery) setIsSearching(false);
        return;
      }

      try {
        setSearchLoading(true);
        const response = await fetch(
          `/api/queue/search?q=${encodeURIComponent(debouncedQuery)}&limit=5`,
          { headers: { Authorization: `Bearer ${token}` } }
        );
        if (response.ok) {
          const data = await response.json();
          setSearchResults(data.results || []);
        }
      } catch (err) {
        console.error('Search error:', err);
        setSearchResults([]);
      } finally {
        setSearchLoading(false);
      }
    };

    fetchResults();
  }, [debouncedQuery, token]);

  // Handle adding a track
  const handleAdd = useCallback(
    (urlOrQuery) => {
      addToQueue?.(urlOrQuery);
    },
    [addToQueue]
  );

  // Handle search input change
  const handleInputChange = (e) => {
    const val = e.target.value;
    setQuery(val);
    if (val.trim()) {
      setIsSearching(true);
      setSearchLoading(true);
    } else {
      setIsSearching(false);
      setSearchResults([]);
    }
  };

  // Keyboard navigation
  const handleKeyDown = (e) => {
    if (e.key === 'Escape') {
      setQuery('');
      setIsSearching(false);
      setSearchResults([]);
      setHighlightedIndex(-1);
      inputRef.current?.blur();
      return;
    }

    if (!isSearching || searchResults.length === 0) return;

    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        setHighlightedIndex((prev) => (prev < searchResults.length - 1 ? prev + 1 : 0));
        break;
      case 'ArrowUp':
        e.preventDefault();
        setHighlightedIndex((prev) => (prev > 0 ? prev - 1 : searchResults.length - 1));
        break;
      case 'Enter':
        e.preventDefault();
        if (highlightedIndex >= 0 && searchResults[highlightedIndex]) {
          handleAdd(searchResults[highlightedIndex].url);
          setQuery('');
          setIsSearching(false);
          setSearchResults([]);
          setHighlightedIndex(-1);
        } else if (query.trim()) {
          // Direct URL or free-text submit
          handleAdd(query.trim());
          setQuery('');
          setIsSearching(false);
          setSearchResults([]);
        }
        break;
    }
  };

  // Reset highlight when results change
  useEffect(() => {
    setHighlightedIndex(-1);
  }, [searchResults]);

  // Handle URL paste / direct submit
  const handleSubmit = (e) => {
    e.preventDefault();
    if (!query.trim()) return;
    if (isUrl(query.trim())) {
      handleAdd(query.trim());
      setQuery('');
      setIsSearching(false);
      setSearchResults([]);
    }
  };

  // Section title based on current view
  const getSectionTitle = () => {
    if (isSearching) return 'RESULTS';
    switch (activeView) {
      case 'history':
        return 'PLAY HISTORY';
      case 'playlists':
        return selectedPlaylist ? selectedPlaylist.name : 'PLAYLISTS';
      default:
        return 'BROWSE';
    }
  };

  // Placeholder text
  const getPlaceholder = () => {
    switch (activeView) {
      case 'history':
        return 'Search YouTube \u2014 type to find any song\u2026';
      case 'playlists':
        return 'Search YouTube \u2014 type to find any song\u2026';
      default:
        return 'Search YouTube \u2014 type to find any song\u2026';
    }
  };

  // Render content area
  const renderContent = () => {
    if (isSearching) {
      return (
        <SearchResults
          results={searchResults}
          loading={searchLoading}
          highlightedIndex={highlightedIndex}
          onAdd={(url) => {
            handleAdd(url);
            setQuery('');
            setIsSearching(false);
            setSearchResults([]);
            setHighlightedIndex(-1);
          }}
          onHighlight={setHighlightedIndex}
        />
      );
    }

    switch (activeView) {
      case 'history':
        return <History addToQueue={addToQueue} historyVersion={historyVersion} />;
      case 'playlists':
        return (
          <PlaylistsView
            albums={albums}
            onCreateAlbum={createPlaylist}
            selectedPlaylist={selectedPlaylist}
            onSelectPlaylist={onSelectPlaylist}
            onAddToQueue={addToQueue}
            onBack={onClearSelectedPlaylist}
          />
        );
      default:
        return <BrowseView onViewChange={onViewChange} albums={albums} onLoadAlbum={loadAlbum} />;
    }
  };

  const userName = user?.username || 'there';

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
        padding: '28px 32px 0',
        gap: '20px',
        height: '100%'
      }}
    >
      {/* Voice connection warning */}
      {!playerState?.connected && (
        <div
          style={{
            background: 'rgba(232,200,122,0.1)',
            border: '1px solid rgba(232,200,122,0.25)',
            borderRadius: '8px',
            padding: '10px 16px',
            fontSize: '13px',
            color: 'var(--color-accent)',
            flexShrink: 0
          }}
        >
          Bot is not connected to a voice channel. Use{' '}
          <code
            style={{
              background: 'rgba(0,0,0,0.2)',
              padding: '1px 5px',
              borderRadius: '4px',
              fontSize: '12px'
            }}
          >
            /join
          </code>{' '}
          in Discord.
        </div>
      )}

      {/* Hero section */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: '14px', flexShrink: 0 }}>
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: '16px'
          }}
        >
          <h1
            style={{
              fontFamily: "'Instrument Serif', serif",
              fontSize: '32px',
              lineHeight: 1.1,
              letterSpacing: '-0.4px',
              color: 'var(--color-text-primary)',
              margin: 0,
              fontWeight: 'normal'
            }}
          >
            {getGreeting()},
            <br />
            <em style={{ fontStyle: 'italic', color: 'var(--color-accent)' }}>{userName}.</em>
          </h1>
        </div>

        {/* Search bar */}
        <form onSubmit={handleSubmit} style={{ position: 'relative' }}>
          {/* Search icon */}
          <svg
            style={{
              position: 'absolute',
              left: '15px',
              top: '50%',
              transform: 'translateY(-50%)',
              color: 'var(--color-text-muted)',
              pointerEvents: 'none'
            }}
            width="16"
            height="16"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
            strokeWidth="2"
          >
            <circle cx="11" cy="11" r="8" />
            <path d="m21 21-4.35-4.35" />
          </svg>

          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={handleInputChange}
            onKeyDown={handleKeyDown}
            placeholder={getPlaceholder()}
            autoComplete="off"
            spellCheck="false"
            aria-label="Search for music"
            style={{
              width: '100%',
              background: 'var(--color-bg-elevated)',
              border: '1px solid var(--color-border)',
              borderRadius: '10px',
              padding: '13px 44px',
              fontFamily: "'DM Sans', sans-serif",
              fontSize: '14px',
              color: 'var(--color-text-primary)',
              outline: 'none',
              transition: 'border-color 0.2s'
            }}
            onFocus={(e) => {
              e.target.style.borderColor = 'rgba(232,200,122,0.35)';
            }}
            onBlur={(e) => {
              e.target.style.borderColor = 'var(--color-border)';
            }}
          />

          {/* Search spinner */}
          {searchLoading && isSearching && (
            <div
              style={{
                position: 'absolute',
                right: '15px',
                top: '50%',
                transform: 'translateY(-50%)',
                width: '14px',
                height: '14px',
                border: '2px solid var(--color-border)',
                borderTopColor: 'var(--color-accent)',
                borderRadius: '50%',
                animation: 'wave-spin 0.7s linear infinite'
              }}
            />
          )}
          <style>{`
            @keyframes wave-spin { to { transform: translateY(-50%) rotate(360deg); } }
            input::placeholder { color: var(--color-text-muted); }
          `}</style>
        </form>
      </div>

      {/* Content area */}
      <div
        style={{
          flex: 1,
          overflow: 'hidden',
          display: 'flex',
          flexDirection: 'column',
          minHeight: 0,
          paddingBottom: '20px'
        }}
      >
        {/* Section header */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            padding: '4px 0 12px',
            flexShrink: 0
          }}
        >
          <span
            style={{
              fontSize: '11px',
              fontWeight: 600,
              letterSpacing: '0.8px',
              textTransform: 'uppercase',
              color: 'var(--color-text-secondary)'
            }}
          >
            {getSectionTitle()}
          </span>
        </div>

        {/* Scrollable content */}
        <div
          style={{
            flex: 1,
            overflowY: 'auto',
            scrollbarWidth: 'thin',
            scrollbarColor: 'var(--color-bg-elevated) transparent'
          }}
        >
          {renderContent()}
        </div>
      </div>
    </div>
  );
}
