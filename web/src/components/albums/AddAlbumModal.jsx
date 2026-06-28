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
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" className={className}>
      <path d="M12 0C5.4 0 0 5.4 0 12s5.4 12 12 12 12-5.4 12-12S18.66 0 12 0zm5.521 17.34c-.24.359-.66.48-1.021.24-2.82-1.74-6.36-2.101-10.561-1.141-.418.122-.779-.179-.899-.539-.12-.421.18-.78.54-.9 4.56-1.021 8.52-.6 11.64 1.32.42.18.479.659.301 1.02zm1.44-3.3c-.301.42-.841.6-1.262.3-3.239-1.98-8.159-2.58-11.939-1.38-.479.12-1.02-.12-1.14-.6-.12-.48.12-1.021.6-1.141C9.6 9.9 15 10.561 18.72 12.84c.361.181.54.78.241 1.2zm.12-3.36C15.24 8.4 8.82 8.16 5.16 9.301c-.6.179-1.2-.181-1.38-.721-.18-.601.18-1.2.72-1.381 4.26-1.26 11.28-1.02 15.721 1.621.539.3.719 1.02.419 1.56-.299.421-1.02.599-1.559.3z" />
    </svg>
  );
}

/**
 * Loading spinner
 */
function Spinner({ size = 20 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" className="animate-spin">
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
    const controller = new AbortController();

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
        const response = await fetch(`/api/spotify/info?url=${encodeURIComponent(spotifyUrl)}`, {
          credentials: 'include',
          signal: controller.signal
        });

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
        // A newer keystroke aborted this request — ignore it so the stale
        // response can't overwrite fresher state.
        if (err.name === 'AbortError') return;
        setError(err.message);
        setAlbumName('');
        setCoverImage('');
        setTrackCount(0);
        setContentType('');
      } finally {
        if (!controller.signal.aborted) {
          setIsLoading(false);
        }
      }
    };

    // Debounce the fetch
    const timer = setTimeout(fetchMetadata, 500);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
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
      setError('Please enter a playlist name');
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

  const modalBgStyle = {
    position: 'fixed',
    inset: 0,
    background: 'rgba(0,0,0,0.7)',
    zIndex: 80,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    padding: '16px'
  };

  const modalBoxStyle = {
    background: 'var(--color-bg-raised)',
    border: '1px solid var(--color-border-strong)',
    borderRadius: '14px',
    padding: '28px',
    width: '420px',
    maxWidth: '100%',
    display: 'flex',
    flexDirection: 'column',
    gap: '14px'
  };

  const modalTitleStyle = {
    fontFamily: 'var(--font-heading)',
    fontSize: '20px',
    color: 'var(--color-text-primary)',
    lineHeight: 1.2,
    margin: 0
  };

  const inputStyle = {
    width: '100%',
    background: 'var(--color-bg-elevated)',
    border: '1px solid var(--color-border)',
    borderRadius: '8px',
    padding: '10px 14px',
    fontFamily: 'var(--font-body)',
    fontSize: '14px',
    color: 'var(--color-text-primary)',
    outline: 'none',
    transition: 'border-color 0.2s',
    boxSizing: 'border-box'
  };

  const inputWithIconStyle = {
    ...inputStyle,
    paddingLeft: '40px',
    paddingRight: isLoading ? '40px' : '14px'
  };

  const btnBaseStyle = {
    display: 'flex',
    alignItems: 'center',
    gap: '6px',
    padding: '8px 14px',
    borderRadius: '8px',
    fontSize: '13px',
    fontWeight: 500,
    cursor: 'pointer',
    transition: 'all 0.12s',
    border: 'none',
    fontFamily: 'var(--font-body)'
  };

  const btnGhostStyle = {
    ...btnBaseStyle,
    background: 'var(--color-bg-elevated)',
    color: 'var(--color-text-secondary)',
    border: '1px solid var(--color-border)'
  };

  const btnAccentStyle = {
    ...btnBaseStyle,
    background: 'var(--color-accent)',
    color: '#0d0d0f'
  };

  return createPortal(
    <div
      style={modalBgStyle}
      className={isClosing ? 'animate-fade-out' : 'animate-fade-in'}
      onClick={handleBackdropClick}
      role="dialog"
      aria-modal="true"
      aria-labelledby="add-album-title"
    >
      <div
        ref={modalRef}
        style={modalBoxStyle}
        className={isClosing ? 'animate-scale-out' : 'animate-scale-in'}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header row */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <h2 id="add-album-title" style={modalTitleStyle}>
            New Playlist
          </h2>
          <button
            onClick={handleClose}
            style={{
              background: 'none',
              border: 'none',
              color: 'var(--color-text-muted)',
              cursor: 'pointer',
              padding: '4px',
              borderRadius: '6px',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              transition: 'color 0.12s'
            }}
            aria-label="Close modal"
            onMouseEnter={(e) => (e.currentTarget.style.color = 'var(--color-text-primary)')}
            onMouseLeave={(e) => (e.currentTarget.style.color = 'var(--color-text-muted)')}
          >
            <CloseIcon size={18} />
          </button>
        </div>

        {/* Form */}
        <form
          onSubmit={handleSubmit}
          style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}
        >
          {/* Spotify URL input */}
          <div style={{ position: 'relative' }}>
            <div
              style={{
                position: 'absolute',
                left: '14px',
                top: '50%',
                transform: 'translateY(-50%)',
                color: '#1DB954',
                display: 'flex',
                pointerEvents: 'none'
              }}
            >
              <SpotifyIcon size={16} />
            </div>
            <input
              ref={inputRef}
              type="text"
              value={spotifyUrl}
              onChange={(e) => {
                setSpotifyUrl(e.target.value);
                if (error) setError('');
              }}
              placeholder="Spotify playlist or album URL"
              style={inputWithIconStyle}
              onFocus={(e) => (e.target.style.borderColor = 'rgba(232,200,122,0.35)')}
              onBlur={(e) =>
                (e.target.style.borderColor = error ? 'var(--color-danger)' : 'var(--color-border)')
              }
              autoComplete="off"
            />
            {isLoading && (
              <div
                style={{
                  position: 'absolute',
                  right: '14px',
                  top: '50%',
                  transform: 'translateY(-50%)',
                  color: 'var(--color-text-muted)',
                  display: 'flex'
                }}
              >
                <Spinner size={16} />
              </div>
            )}
          </div>

          {/* Error message */}
          {error && (
            <p
              style={{
                fontSize: '12px',
                color: 'var(--color-danger)',
                margin: 0
              }}
            >
              {error}
            </p>
          )}

          {/* Metadata preview (shown after successful fetch) */}
          {metadataLoaded && (
            <div
              style={{
                display: 'flex',
                gap: '14px',
                padding: '14px',
                borderRadius: '10px',
                background: 'var(--color-bg-elevated)',
                border: '1px solid var(--color-border)'
              }}
              className="animate-fade-in"
            >
              {/* Cover image */}
              <div
                style={{
                  width: '80px',
                  height: '80px',
                  borderRadius: '7px',
                  overflow: 'hidden',
                  background: 'var(--color-bg-surface3)',
                  flexShrink: 0
                }}
              >
                {coverImage ? (
                  <img
                    src={coverImage}
                    alt={albumName}
                    style={{ width: '100%', height: '100%', objectFit: 'cover' }}
                  />
                ) : (
                  <div
                    style={{
                      width: '100%',
                      height: '100%',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center'
                    }}
                  >
                    <AlbumIcon size={32} className="text-muted" />
                  </div>
                )}
              </div>

              {/* Name input and info */}
              <div
                style={{
                  flex: 1,
                  minWidth: 0,
                  display: 'flex',
                  flexDirection: 'column',
                  justifyContent: 'center',
                  gap: '8px'
                }}
              >
                <input
                  type="text"
                  value={albumName}
                  onChange={(e) => setAlbumName(e.target.value)}
                  style={inputStyle}
                  onFocus={(e) => (e.target.style.borderColor = 'rgba(232,200,122,0.35)')}
                  onBlur={(e) => (e.target.style.borderColor = 'var(--color-border)')}
                  maxLength={100}
                  placeholder="Playlist name"
                />
                <p
                  style={{
                    fontSize: '11px',
                    color: 'var(--color-text-muted)',
                    margin: 0
                  }}
                >
                  {trackCount} {trackCount === 1 ? 'track' : 'tracks'} &bull;{' '}
                  {contentType === 'album' ? 'Album' : 'Playlist'}
                </p>
              </div>
            </div>
          )}

          {/* Buttons row */}
          <div style={{ display: 'flex', gap: '8px', justifyContent: 'flex-end' }}>
            <button type="button" onClick={handleClose} style={btnGhostStyle} className="btn-ghost">
              Cancel
            </button>
            <button
              type="submit"
              disabled={!metadataLoaded || isLoading}
              style={{
                ...btnAccentStyle,
                opacity: !metadataLoaded || isLoading ? 0.5 : 1,
                cursor: !metadataLoaded || isLoading ? 'not-allowed' : 'pointer'
              }}
              className="btn-accent"
            >
              Create
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
    </div>,
    document.body
  );
}

export default AddAlbumModal;
