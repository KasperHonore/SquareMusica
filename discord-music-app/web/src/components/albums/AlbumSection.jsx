import { useState } from 'react';
import { Album, Plus } from '../icons';
import { AlbumItem } from './AlbumItem';
import { AddAlbumModal } from './AddAlbumModal';
import { PlaylistDetailModal } from './PlaylistDetailModal';

/**
 * AlbumSection - Container for the "Your Albums" section in the sidebar
 *
 * Features:
 * - Header with album count badge
 * - Add album button (green plus icon)
 * - Scrollable album list with staggered animations
 * - Empty state with inviting visuals
 * - AddAlbumModal integration
 *
 * @param {Object[]} albums - Array of album objects
 * @param {function} onLoadAlbum - Called when album should be loaded into queue
 * @param {function} onDeleteAlbum - Called when album should be deleted
 * @param {function} onCreateAlbum - Called when new album is created (name, spotifyUrl, coverImage)
 */
export function AlbumSection({
  albums = [],
  onLoadAlbum,
  onDeleteAlbum,
  onCreateAlbum,
  onAddToQueue,
}) {
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [loadingAlbumId, setLoadingAlbumId] = useState(null);
  const [inspectedPlaylist, setInspectedPlaylist] = useState(null);

  const handleLoadAlbum = async (album) => {
    setLoadingAlbumId(album.id);
    try {
      await onLoadAlbum?.(album);
    } finally {
      // Brief delay for visual feedback
      setTimeout(() => setLoadingAlbumId(null), 300);
    }
  };

  const handleDeleteAlbum = (album) => {
    onDeleteAlbum?.(album.id);
  };

  const handleCreateAlbum = (name, spotifyUrl, coverImage) => {
    onCreateAlbum?.(name, spotifyUrl, coverImage);
  };

  // Handle opening detail modal
  const handleInspect = (album) => {
    setInspectedPlaylist(album);
  };

  // Handle adding single track from detail modal
  const handleAddTrack = (spotifyUrl) => {
    onAddToQueue?.(spotifyUrl);
  };

  // Handle adding all tracks to queue (appends, doesn't replace)
  const handleAddAll = () => {
    if (inspectedPlaylist?.spotifyUrl) {
      onAddToQueue?.(inspectedPlaylist.spotifyUrl);
      setInspectedPlaylist(null);
    }
  };

  const isEmpty = albums.length === 0;

  return (
    <>
      {/* Section container */}
      <div className="flex flex-col min-h-0 h-full">
        {/* Section header */}
        <div className="flex items-center justify-between px-3 py-2">
          <div className="flex items-center gap-2">
            <span
              className="text-xs font-semibold uppercase tracking-wider"
              style={{ color: 'var(--color-text-muted)' }}
            >
              Your Playlists
            </span>
            {albums.length > 0 && (
              <span className="px-1.5 py-0.5 text-xs font-medium rounded-md bg-accent-muted text-accent">
                {albums.length}
              </span>
            )}
          </div>
          <button
            onClick={() => setIsModalOpen(true)}
            className="p-1.5 rounded-md text-accent hover:text-accent-hover hover:bg-accent-subtle transition-all duration-200 focus-ring"
            title="Create new playlist"
            aria-label="Create new playlist"
          >
            <Plus size={16} />
          </button>
        </div>

        {/* Album list or empty state */}
        {isEmpty ? (
          <EmptyState onClick={() => setIsModalOpen(true)} />
        ) : (
          <div
            className="flex-1 overflow-y-auto px-2 pb-2"
            role="list"
            aria-label="Saved playlists"
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

      {/* Add Album Modal */}
      <AddAlbumModal
        isOpen={isModalOpen}
        onClose={() => setIsModalOpen(false)}
        onCreate={handleCreateAlbum}
      />

      {/* Playlist Detail Modal */}
      <PlaylistDetailModal
        isOpen={!!inspectedPlaylist}
        onClose={() => setInspectedPlaylist(null)}
        playlist={inspectedPlaylist}
        onAddTrack={handleAddTrack}
        onAddAll={handleAddAll}
      />
    </>
  );
}

/**
 * Empty state component for albums section
 */
function EmptyState({ onClick }) {
  return (
    <button
      onClick={onClick}
      className="group mx-2 mb-2 p-4 rounded-lg bg-white/[0.02] hover:bg-white/[0.05] border border-dashed border-white/10 hover:border-accent/30 transition-all duration-300 cursor-pointer focus-ring"
      aria-label="Create your first album"
    >
      <div className="flex flex-col items-center text-center">
        {/* Album icon with glow */}
        <div className="relative mb-3">
          <div className="w-12 h-12 rounded-xl bg-accent-subtle flex items-center justify-center group-hover:bg-accent-muted transition-colors duration-300">
            <Album
              size={24}
              className="text-accent group-hover:text-accent-hover transition-colors duration-300"
            />
          </div>
          {/* Subtle glow ring on hover */}
          <div
            className="absolute inset-0 rounded-xl opacity-0 group-hover:opacity-100 animate-pulse-glow-album transition-opacity duration-500 pointer-events-none"
            aria-hidden="true"
          />
        </div>

        <p
          className="text-sm font-medium mb-1"
          style={{ color: 'var(--color-text-secondary)' }}
        >
          No saved playlists
        </p>
        <p
          className="text-xs leading-relaxed"
          style={{ color: 'var(--color-text-muted)' }}
        >
          Create playlists to quickly load your favorites
        </p>
      </div>
    </button>
  );
}

export default AlbumSection;
