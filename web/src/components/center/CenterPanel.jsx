import { useAuth } from '../../context/AuthContext';
import { useSocketContext } from '../../context/SocketContext';
import { BrowseView } from './BrowseView';
import { SearchResults } from './SearchResults';
import { PlaylistsView } from './PlaylistsView';
import { SearchBar } from './SearchBar';
import { useTrackSearch } from './useTrackSearch';
import { History } from '../../pages/History';

// Time-aware greeting
function getGreeting() {
  const h = new Date().getHours();
  if (h < 12) return 'Good morning';
  if (h < 18) return 'Good afternoon';
  return 'Good evening';
}

/**
 * CenterPanel - Hero greeting, search bar, and content area
 */
export function CenterPanel({
  activeView,
  onViewChange,
  selectedPlaylist,
  onSelectPlaylist,
  onClearSelectedPlaylist
}) {
  const { user } = useAuth();
  const { addToQueue, playerState, albums, createPlaylist, loadAlbum, historyVersion } =
    useSocketContext();

  const {
    query,
    searchResults,
    searchLoading,
    highlightedIndex,
    isSearching,
    inputRef,
    handleInputChange,
    handleKeyDown,
    handleSubmit,
    handleAdd,
    clearSearch,
    setHighlightedIndex
  } = useTrackSearch({ addToQueue });

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
        return 'Search YouTube — type to find any song…';
      case 'playlists':
        return 'Search YouTube — type to find any song…';
      default:
        return 'Search YouTube — type to find any song…';
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
            clearSearch();
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
        <SearchBar
          inputRef={inputRef}
          query={query}
          onInputChange={handleInputChange}
          onKeyDown={handleKeyDown}
          onSubmit={handleSubmit}
          placeholder={getPlaceholder()}
          searchLoading={searchLoading}
          isSearching={isSearching}
        />
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
