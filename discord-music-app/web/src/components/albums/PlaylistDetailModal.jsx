import { useState, useEffect, useRef, useCallback } from 'react';
import { createPortal } from 'react-dom';

/**
 * Close icon for modal
 */
function CloseIcon({ size = 20 }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <line x1="18" y1="6" x2="6" y2="18" />
      <line x1="6" y1="6" x2="18" y2="18" />
    </svg>
  );
}

/**
 * Plus icon for add button
 */
function PlusIcon({ size = 16 }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <line x1="12" y1="5" x2="12" y2="19" />
      <line x1="5" y1="12" x2="19" y2="12" />
    </svg>
  );
}

/**
 * Music note icon for track rows
 */
function MusicNoteIcon({ size = 16, className = '' }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
    >
      <path d="M9 18V5l12-2v13" />
      <circle cx="6" cy="18" r="3" />
      <circle cx="18" cy="16" r="3" />
    </svg>
  );
}

/**
 * Album/playlist icon for header fallback
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
 * Loading spinner
 */
function Spinner({ size = 20 }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      className="animate-spin"
    >
      <circle
        cx="12"
        cy="12"
        r="10"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeDasharray="32"
        strokeDashoffset="16"
      />
    </svg>
  );
}

/**
 * Format duration from milliseconds to mm:ss
 */
function formatDuration(ms) {
  const minutes = Math.floor(ms / 60000);
  const seconds = Math.floor((ms % 60000) / 1000);
  return `${minutes}:${seconds.toString().padStart(2, '0')}`;
}

/**
 * PlaylistDetailModal - Modal dialog for viewing playlist tracks
 *
 * @param {boolean} isOpen - Whether the modal is visible
 * @param {function} onClose - Callback when modal should close
 * @param {object} playlist - The playlist object { id, name, coverImage, spotifyUrl }
 * @param {function} onAddTrack - Callback(spotifyUrl) to add single track to queue
 * @param {function} onAddAll - Callback to add entire playlist to queue
 */
export function PlaylistDetailModal({ isOpen, onClose, playlist, onAddTrack, onAddAll }) {
  const [tracks, setTracks] = useState([]);
  const [isLoading, setIsLoading] = useState(false);
  const [isClosing, setIsClosing] = useState(false);
  const [error, setError] = useState('');

  const modalRef = useRef(null);

  // Fetch tracks when modal opens
  useEffect(() => {
    if (isOpen && playlist?.id) {
      setIsClosing(false);
      setError('');
      setTracks([]);
      fetchTracks();
    }
  }, [isOpen, playlist?.id]);

  const fetchTracks = async () => {
    if (!playlist?.id) return;

    setIsLoading(true);
    setError('');

    try {
      const response = await fetch(
        `/api/playlists/${playlist.id}/tracks`,
        { credentials: 'include' }
      );

      if (!response.ok) {
        const data = await response.json();
        throw new Error(data.error || 'Failed to fetch tracks');
      }

      const data = await response.json();
      setTracks(data.tracks || []);
    } catch (err) {
      setError(err.message);
    } finally {
      setIsLoading(false);
    }
  };

  // Handle close with animation
  const handleClose = useCallback(() => {
    setIsClosing(true);
    setTimeout(() => {
      setIsClosing(false);
      onClose();
    }, 150);
  }, [onClose]);

  // Handle escape key
  useEffect(() => {
    if (!isOpen) return;

    const handleKeyDown = (e) => {
      if (e.key === 'Escape') {
        handleClose();
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, handleClose]);

  // Trap focus within modal
  useEffect(() => {
    if (!isOpen) return;

    const modal = modalRef.current;
    if (!modal) return;

    const focusableElements = modal.querySelectorAll(
      'button, input, [tabindex]:not([tabindex="-1"])'
    );
    const firstElement = focusableElements[0];
    const lastElement = focusableElements[focusableElements.length - 1];

    const handleTabKey = (e) => {
      if (e.key !== 'Tab') return;

      if (e.shiftKey) {
        if (document.activeElement === firstElement) {
          e.preventDefault();
          lastElement?.focus();
        }
      } else {
        if (document.activeElement === lastElement) {
          e.preventDefault();
          firstElement?.focus();
        }
      }
    };

    document.addEventListener('keydown', handleTabKey);
    return () => document.removeEventListener('keydown', handleTabKey);
  }, [isOpen]);

  // Prevent body scroll when modal is open
  useEffect(() => {
    if (isOpen) {
      document.body.style.overflow = 'hidden';
    } else {
      document.body.style.overflow = '';
    }
    return () => {
      document.body.style.overflow = '';
    };
  }, [isOpen]);

  // Handle backdrop click
  const handleBackdropClick = (e) => {
    if (e.target === e.currentTarget) {
      handleClose();
    }
  };

  // Handle add all
  // Note: Parent (AlbumSection) handles closing the modal via setInspectedPlaylist(null)
  const handleAddAll = () => {
    if (onAddAll) {
      onAddAll();
    }
    // Don't call handleClose() here - parent already closes the modal
  };

  // Handle add single track
  const handleAddTrack = (spotifyUrl) => {
    if (onAddTrack) {
      onAddTrack(spotifyUrl);
    }
  };

  if (!isOpen && !isClosing) return null;

  return createPortal(
    <div
      className={`
        fixed inset-0 z-50 flex items-center justify-center p-4
        bg-black/70 backdrop-blur-sm
        ${isClosing ? 'animate-fade-out' : 'animate-fade-in'}
      `}
      onClick={handleBackdropClick}
      role="dialog"
      aria-modal="true"
      aria-labelledby="playlist-detail-title"
    >
      {/* Modal card */}
      <div
        ref={modalRef}
        className={`
          card-glass w-full max-w-2xl max-h-[85vh]
          p-8 relative flex flex-col
          ${isClosing ? 'animate-scale-out' : 'animate-scale-in'}
        `}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-start gap-5 mb-6">
          {/* Cover image */}
          <div className="w-28 h-28 rounded-xl overflow-hidden bg-white/10 flex-shrink-0 shadow-lg">
            {playlist?.coverImage ? (
              <img
                src={playlist.coverImage}
                alt={playlist.name}
                className="w-full h-full object-cover"
              />
            ) : (
              <div className="w-full h-full flex items-center justify-center">
                <AlbumIcon size={48} className="text-text-muted" />
              </div>
            )}
          </div>

          {/* Title and info */}
          <div className="flex-1 min-w-0 py-1">
            <h2
              id="playlist-detail-title"
              className="text-xl font-heading font-semibold text-primary truncate mb-2"
            >
              {playlist?.name || 'Playlist'}
            </h2>
            <p className="text-sm text-text-muted">
              {isLoading ? 'Loading...' : `${tracks.length} ${tracks.length === 1 ? 'track' : 'tracks'}`}
            </p>
          </div>

          {/* Close button */}
          <button
            onClick={handleClose}
            className="
              p-2 rounded-lg text-text-muted hover:text-primary
              hover:bg-white/5 transition-colors focus-ring flex-shrink-0
            "
            aria-label="Close modal"
          >
            <CloseIcon size={20} />
          </button>
        </div>

        {/* Track list - scrollable */}
        <div className="flex-1 overflow-y-auto min-h-0 mb-6 -mx-2 px-2">
          {isLoading ? (
            <div className="flex items-center justify-center py-12">
              <Spinner size={32} />
              <span className="ml-3 text-text-muted">Loading tracks...</span>
            </div>
          ) : error ? (
            <div className="text-center py-12">
              <p className="text-red-400 mb-4">{error}</p>
              <button
                onClick={fetchTracks}
                className="
                  px-4 py-2 rounded-lg
                  text-sm font-medium text-secondary
                  hover:text-primary hover:bg-white/5
                  transition-all duration-200 focus-ring
                "
              >
                Retry
              </button>
            </div>
          ) : tracks.length === 0 ? (
            <div className="text-center py-12">
              <MusicNoteIcon size={48} className="mx-auto text-text-muted mb-4" />
              <p className="text-text-muted">No tracks in this playlist</p>
            </div>
          ) : (
            <div className="space-y-1">
              {tracks.map((track, index) => (
                <div
                  key={track.spotifyId || index}
                  className="
                    flex items-center gap-3 p-3 rounded-lg
                    hover:bg-white/5 transition-colors group
                  "
                >
                  {/* Track number / music icon */}
                  <div className="w-8 h-8 rounded-md bg-white/5 flex items-center justify-center flex-shrink-0">
                    <MusicNoteIcon size={14} className="text-text-muted" />
                  </div>

                  {/* Track info */}
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium text-primary truncate">
                      {track.title}
                    </p>
                    <p className="text-xs text-text-muted truncate">
                      {track.artists?.join(', ') || 'Unknown artist'}
                    </p>
                  </div>

                  {/* Duration */}
                  <span className="text-xs text-text-muted flex-shrink-0 w-12 text-right">
                    {formatDuration(track.durationMs || 0)}
                  </span>

                  {/* Add button */}
                  <button
                    onClick={() => handleAddTrack(track.spotifyUrl)}
                    className="
                      p-2 rounded-lg text-text-muted hover:text-[#8B5CF6]
                      hover:bg-[#8B5CF6]/10 transition-colors focus-ring
                      opacity-0 group-hover:opacity-100 flex-shrink-0
                    "
                    aria-label={`Add ${track.title} to queue`}
                    title="Add to queue"
                  >
                    <PlusIcon size={16} />
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end gap-3 pt-4 border-t border-white/10">
          <button
            type="button"
            onClick={handleClose}
            className="
              px-5 py-2.5 rounded-full
              text-sm font-medium text-secondary
              hover:text-primary hover:bg-white/5
              transition-all duration-200 focus-ring
            "
          >
            Close
          </button>
          <button
            type="button"
            onClick={handleAddAll}
            disabled={isLoading || tracks.length === 0}
            className={`
              px-6 py-2.5 rounded-full
              text-sm font-semibold text-white
              bg-[#8B5CF6] hover:bg-[#7C3AED]
              transition-all duration-200
              hover:shadow-lg hover:shadow-[#8B5CF6]/25
              active:scale-[0.98]
              focus-ring
              ${(isLoading || tracks.length === 0) ? 'opacity-50 cursor-not-allowed' : ''}
            `}
          >
            Add All to Queue
          </button>
        </div>
      </div>

      {/* CSS for close animations */}
      <style>{`
        @keyframes fade-out {
          from { opacity: 1; }
          to { opacity: 0; }
        }
        .animate-fade-out {
          animation: fade-out 0.15s ease-out forwards;
        }
        @keyframes scale-out {
          from {
            transform: scale(1);
            opacity: 1;
          }
          to {
            transform: scale(0.95);
            opacity: 0;
          }
        }
        .animate-scale-out {
          animation: scale-out 0.15s ease-out forwards;
        }
      `}</style>
    </div>,
    document.body
  );
}

export default PlaylistDetailModal;
