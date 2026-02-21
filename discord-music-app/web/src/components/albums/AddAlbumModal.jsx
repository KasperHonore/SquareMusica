import { useState, useEffect, useRef, useCallback } from 'react';

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
 * Album icon for header
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
 * Spotify icon for URL input
 */
function SpotifyIcon({ size = 20, className = '' }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="currentColor"
      className={className}
    >
      <path d="M12 0C5.4 0 0 5.4 0 12s5.4 12 12 12 12-5.4 12-12S18.66 0 12 0zm5.521 17.34c-.24.359-.66.48-1.021.24-2.82-1.74-6.36-2.101-10.561-1.141-.418.122-.779-.179-.899-.539-.12-.421.18-.78.54-.9 4.56-1.021 8.52-.6 11.64 1.32.42.18.479.659.301 1.02zm1.44-3.3c-.301.42-.841.6-1.262.3-3.239-1.98-8.159-2.58-11.939-1.38-.479.12-1.02-.12-1.14-.6-.12-.48.12-1.021.6-1.141C9.6 9.9 15 10.561 18.72 12.84c.361.181.54.78.241 1.2zm.12-3.36C15.24 8.4 8.82 8.16 5.16 9.301c-.6.179-1.2-.181-1.38-.721-.18-.601.18-1.2.72-1.381 4.26-1.26 11.28-1.02 15.721 1.621.539.3.719 1.02.419 1.56-.299.421-1.02.599-1.559.3z"/>
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
 * AddAlbumModal - Modal dialog for creating albums from Spotify URLs
 *
 * Features:
 * - Paste Spotify album or playlist URL
 * - Fetches metadata (name, cover, track count) from Spotify
 * - Editable album name
 * - Shows cover preview
 *
 * @param {boolean} isOpen - Whether the modal is visible
 * @param {function} onClose - Callback when modal should close
 * @param {function} onCreate - Callback(name, spotifyUrl, coverImage) when album is created
 */
export function AddAlbumModal({ isOpen, onClose, onCreate }) {
  const [spotifyUrl, setSpotifyUrl] = useState('');
  const [albumName, setAlbumName] = useState('');
  const [coverImage, setCoverImage] = useState('');
  const [trackCount, setTrackCount] = useState(0);
  const [contentType, setContentType] = useState(''); // 'album' or 'playlist'
  const [isLoading, setIsLoading] = useState(false);
  const [isClosing, setIsClosing] = useState(false);
  const [error, setError] = useState('');
  const [metadataLoaded, setMetadataLoaded] = useState(false);

  const inputRef = useRef(null);
  const modalRef = useRef(null);

  // Reset state when modal opens
  useEffect(() => {
    if (isOpen) {
      setSpotifyUrl('');
      setAlbumName('');
      setCoverImage('');
      setTrackCount(0);
      setContentType('');
      setIsLoading(false);
      setError('');
      setMetadataLoaded(false);
      setIsClosing(false);
      // Focus input after animation
      const timer = setTimeout(() => {
        inputRef.current?.focus();
      }, 100);
      return () => clearTimeout(timer);
    }
  }, [isOpen]);

  // Fetch Spotify metadata when URL changes
  useEffect(() => {
    const fetchMetadata = async () => {
      // Check if it looks like a Spotify URL
      if (!spotifyUrl.includes('spotify.com') && !spotifyUrl.startsWith('spotify:')) {
        if (spotifyUrl.trim()) {
          setError('Please enter a valid Spotify URL');
        }
        setMetadataLoaded(false);
        setAlbumName('');
        setCoverImage('');
        setTrackCount(0);
        setContentType('');
        return;
      }

      setIsLoading(true);
      setError('');
      setMetadataLoaded(false);

      try {
        const response = await fetch(
          `/api/spotify/info?url=${encodeURIComponent(spotifyUrl)}`,
          { credentials: 'include' }
        );

        if (!response.ok) {
          const data = await response.json();
          throw new Error(data.error || 'Failed to fetch Spotify data');
        }

        const data = await response.json();
        setAlbumName(data.name);
        setCoverImage(data.images?.[0]?.url || '');
        setTrackCount(data.trackCount || 0);
        setContentType(data.type);
        setMetadataLoaded(true);
      } catch (err) {
        setError(err.message);
        setAlbumName('');
        setCoverImage('');
        setTrackCount(0);
        setContentType('');
      } finally {
        setIsLoading(false);
      }
    };

    // Debounce the fetch
    const timer = setTimeout(fetchMetadata, 500);
    return () => clearTimeout(timer);
  }, [spotifyUrl]);

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

  // Handle form submission
  const handleSubmit = (e) => {
    e.preventDefault();

    if (!metadataLoaded) {
      setError('Please enter a valid Spotify URL');
      inputRef.current?.focus();
      return;
    }

    const trimmedName = albumName.trim();
    if (!trimmedName) {
      setError('Please enter an album name');
      return;
    }

    onCreate(trimmedName, spotifyUrl, coverImage);
    handleClose();
  };

  // Handle backdrop click
  const handleBackdropClick = (e) => {
    if (e.target === e.currentTarget) {
      handleClose();
    }
  };

  if (!isOpen && !isClosing) return null;

  return (
    <div
      className={`
        fixed inset-0 z-50 flex items-center justify-center p-4
        bg-black/70 backdrop-blur-sm
        ${isClosing ? 'animate-fade-out' : 'animate-fade-in'}
      `}
      onClick={handleBackdropClick}
      role="dialog"
      aria-modal="true"
      aria-labelledby="add-album-title"
    >
      {/* Modal card */}
      <div
        ref={modalRef}
        className={`
          card-glass w-full max-w-md
          p-6 relative
          ${isClosing ? 'animate-scale-out' : 'animate-scale-in'}
        `}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between mb-6">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-lg bg-[#8B5CF6]/20 flex items-center justify-center">
              <AlbumIcon size={22} className="text-[#8B5CF6]" />
            </div>
            <h2 id="add-album-title" className="text-xl font-heading font-semibold text-primary">
              Create Album
            </h2>
          </div>
          <button
            onClick={handleClose}
            className="
              p-2 rounded-lg text-text-muted hover:text-primary
              hover:bg-white/5 transition-colors focus-ring
            "
            aria-label="Close modal"
          >
            <CloseIcon size={20} />
          </button>
        </div>

        {/* Form */}
        <form onSubmit={handleSubmit}>
          {/* Spotify URL input */}
          <div className="mb-5">
            <label
              htmlFor="spotify-url"
              className="block text-sm font-medium text-secondary mb-2"
            >
              Spotify Album or Playlist URL
            </label>
            <div className="relative">
              <div className="absolute left-3 top-1/2 -translate-y-1/2 text-[#1DB954]">
                <SpotifyIcon size={18} />
              </div>
              <input
                ref={inputRef}
                id="spotify-url"
                type="text"
                value={spotifyUrl}
                onChange={(e) => {
                  setSpotifyUrl(e.target.value);
                  if (error) setError('');
                }}
                placeholder="https://open.spotify.com/album/..."
                className={`
                  w-full pl-10 pr-10 py-3 rounded-lg
                  bg-white/5 border
                  ${error ? 'border-red-500/50' : 'border-white/10 focus:border-[#8B5CF6]/50'}
                  text-primary placeholder:text-text-muted
                  focus:outline-none focus:ring-2 focus:ring-[#8B5CF6]/30
                  transition-all duration-200
                `}
                autoComplete="off"
              />
              {isLoading && (
                <div className="absolute right-3 top-1/2 -translate-y-1/2 text-text-muted">
                  <Spinner size={18} />
                </div>
              )}
            </div>
            {error && (
              <p className="mt-2 text-sm text-red-400 animate-fade-in">{error}</p>
            )}
          </div>

          {/* Metadata preview (shown after successful fetch) */}
          {metadataLoaded && (
            <div className="mb-5 p-4 rounded-lg bg-white/5 border border-white/10 animate-fade-in">
              <div className="flex gap-4">
                {/* Cover image */}
                <div className="w-20 h-20 rounded-lg overflow-hidden bg-white/10 flex-shrink-0">
                  {coverImage ? (
                    <img
                      src={coverImage}
                      alt={albumName}
                      className="w-full h-full object-cover"
                    />
                  ) : (
                    <div className="w-full h-full flex items-center justify-center">
                      <AlbumIcon size={32} className="text-text-muted" />
                    </div>
                  )}
                </div>

                {/* Name input and track count */}
                <div className="flex-1 min-w-0">
                  <label
                    htmlFor="album-name"
                    className="block text-xs font-medium text-text-muted mb-1"
                  >
                    Album Name
                  </label>
                  <input
                    id="album-name"
                    type="text"
                    value={albumName}
                    onChange={(e) => setAlbumName(e.target.value)}
                    className="
                      w-full px-3 py-2 rounded-lg
                      bg-white/5 border border-white/10
                      text-primary text-sm
                      focus:outline-none focus:ring-2 focus:ring-[#8B5CF6]/30 focus:border-[#8B5CF6]/50
                      transition-all duration-200
                    "
                    maxLength={100}
                  />
                  <p className="text-xs text-text-muted mt-2">
                    {trackCount} {trackCount === 1 ? 'track' : 'tracks'} &bull; {contentType === 'album' ? 'Album' : 'Playlist'}
                  </p>
                </div>
              </div>
            </div>
          )}

          {/* Action buttons */}
          <div className="flex items-center justify-end gap-3">
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
              Cancel
            </button>
            <button
              type="submit"
              disabled={!metadataLoaded || isLoading}
              className={`
                px-6 py-2.5 rounded-full
                text-sm font-semibold text-white
                bg-[#8B5CF6] hover:bg-[#7C3AED]
                transition-all duration-200
                hover:shadow-lg hover:shadow-[#8B5CF6]/25
                active:scale-[0.98]
                focus-ring
                ${(!metadataLoaded || isLoading) ? 'opacity-50 cursor-not-allowed' : ''}
              `}
            >
              Create Album
            </button>
          </div>
        </form>
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
    </div>
  );
}

export default AddAlbumModal;
