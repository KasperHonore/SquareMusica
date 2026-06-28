import { useState } from 'react';
import { Plus } from '../icons';
import { AlbumItem } from './AlbumItem';
import { AddAlbumModal } from './AddAlbumModal';

/**
 * AlbumSection — Wave sidebar "My Playlists" compact list
 *
 * - Section label: 10px uppercase, muted color, 1.2px letter-spacing
 * - Scrollable list with thin 3px scrollbar
 * - Keeps all album/playlist functionality (load, delete, create, addToQueue)
 */
export function AlbumSection({
  albums = [],
  onLoadAlbum,
  onDeleteAlbum,
  onCreateAlbum,
  onSelectPlaylist
}) {
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [loadingAlbumId, setLoadingAlbumId] = useState(null);

  const handleLoadAlbum = async (album) => {
    setLoadingAlbumId(album.id);
    try {
      await onLoadAlbum?.(album);
    } finally {
      setTimeout(() => setLoadingAlbumId(null), 300);
    }
  };

  const handleDeleteAlbum = (album) => {
    onDeleteAlbum?.(album.id);
  };

  const handleCreateAlbum = (name, spotifyUrl, coverImage) => {
    onCreateAlbum?.(name, spotifyUrl, coverImage);
  };

  const handleInspect = (album) => {
    onSelectPlaylist?.(album);
  };

  const isEmpty = albums.length === 0;

  return (
    <>
      <div style={{ display: 'flex', flexDirection: 'column', minHeight: 0, height: '100%' }}>
        {/* Section header row */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            padding: '0 10px',
            marginBottom: '4px',
            flexShrink: 0
          }}
        >
          <span
            style={{
              fontSize: '10px',
              fontWeight: 600,
              letterSpacing: '1.2px',
              textTransform: 'uppercase',
              color: 'var(--color-text-muted)'
            }}
          >
            My Playlists
          </span>
          <button
            onClick={() => setIsModalOpen(true)}
            title="Create new playlist"
            aria-label="Create new playlist"
            style={{
              background: 'none',
              border: 'none',
              color: 'var(--color-text-muted)',
              cursor: 'pointer',
              padding: '2px',
              borderRadius: '4px',
              display: 'flex',
              alignItems: 'center',
              transition: 'color 0.12s'
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.color = 'var(--color-accent)';
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.color = 'var(--color-text-muted)';
            }}
          >
            <Plus size={14} />
          </button>
        </div>

        {/* Playlist list or empty state */}
        {isEmpty ? (
          <EmptyState onClick={() => setIsModalOpen(true)} />
        ) : (
          <div
            role="list"
            aria-label="Saved playlists"
            className="sidebar-scrollable"
            style={{
              flex: 1,
              overflowY: 'auto',
              minHeight: 0
            }}
          >
            {albums.map((album, index) => (
              <AlbumItem
                key={album.id}
                album={album}
                index={index}
                isLoading={loadingAlbumId === album.id}
                onPlay={handleLoadAlbum}
                onDelete={handleDeleteAlbum}
                onInspect={handleInspect}
              />
            ))}
          </div>
        )}
      </div>

      <AddAlbumModal
        isOpen={isModalOpen}
        onClose={() => setIsModalOpen(false)}
        onCreate={handleCreateAlbum}
      />
    </>
  );
}

/**
 * Empty state for playlists section
 */
function EmptyState({ onClick }) {
  return (
    <button
      onClick={onClick}
      aria-label="Create your first playlist"
      style={{
        margin: '0 4px',
        padding: '16px 10px',
        borderRadius: '8px',
        border: '1px dashed var(--color-border)',
        background: 'transparent',
        cursor: 'pointer',
        transition: 'all 0.15s',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        gap: '6px',
        color: 'var(--color-text-muted)',
        fontFamily: 'var(--font-body)',
        width: 'calc(100% - 8px)'
      }}
      onMouseEnter={(e) => {
        e.currentTarget.style.borderColor = 'rgba(232,200,122,0.3)';
        e.currentTarget.style.backgroundColor = 'var(--color-accent-muted)';
        e.currentTarget.style.color = 'var(--color-accent)';
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.borderColor = 'var(--color-border)';
        e.currentTarget.style.backgroundColor = 'transparent';
        e.currentTarget.style.color = 'var(--color-text-muted)';
      }}
    >
      <svg
        width="20"
        height="20"
        fill="none"
        viewBox="0 0 24 24"
        stroke="currentColor"
        strokeWidth="1.5"
      >
        <line x1="12" y1="5" x2="12" y2="19" />
        <line x1="5" y1="12" x2="19" y2="12" />
      </svg>
      <span style={{ fontSize: '12px', fontWeight: 500 }}>New Playlist</span>
    </button>
  );
}

export default AlbumSection;
