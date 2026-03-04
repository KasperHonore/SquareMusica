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

  const modalBgStyle = {
    position: 'fixed',
    inset: 0,
    background: 'rgba(0,0,0,0.7)',
    zIndex: 80,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    padding: '16px',
  };

  const modalBoxStyle = {
    background: 'var(--color-bg-raised)',
    border: '1px solid var(--color-border-strong)',
    borderRadius: '14px',
    padding: '28px',
    width: '520px',
    maxWidth: '100%',
    maxHeight: '85vh',
    display: 'flex',
    flexDirection: 'column',
    gap: '14px',
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
    fontFamily: 'var(--font-body)',
  };

  const btnGhostStyle = {
    ...btnBaseStyle,
    background: 'var(--color-bg-elevated)',
    color: 'var(--color-text-secondary)',
    border: '1px solid var(--color-border)',
  };

  const btnAccentStyle = {
    ...btnBaseStyle,
    background: 'var(--color-accent)',
    color: '#0d0d0f',
  };

  const resultAddStyle = {
    background: 'var(--color-accent-muted)',
    border: '1px solid rgba(232,200,122,0.2)',
    color: 'var(--color-accent)',
    borderRadius: '6px',
    padding: '5px 10px',
    fontSize: '11px',
    fontWeight: 600,
    cursor: 'pointer',
    fontFamily: 'var(--font-body)',
    transition: 'background 0.12s',
    whiteSpace: 'nowrap',
    flexShrink: 0,
  };

  return createPortal(
    <div
      style={modalBgStyle}
      className={isClosing ? 'animate-fade-out' : 'animate-fade-in'}
      onClick={handleBackdropClick}
      role="dialog"
      aria-modal="true"
      aria-labelledby="playlist-detail-title"
    >
      <div
        ref={modalRef}
        style={modalBoxStyle}
        className={isClosing ? 'animate-scale-out' : 'animate-scale-in'}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: '14px', flexShrink: 0 }}>
          {/* Cover image */}
          <div style={{
            width: '80px',
            height: '80px',
            borderRadius: '7px',
            overflow: 'hidden',
            background: 'var(--color-bg-surface3)',
            flexShrink: 0,
          }}>
            {playlist?.coverImage ? (
              <img
                src={playlist.coverImage}
                alt={playlist.name}
                style={{ width: '100%', height: '100%', objectFit: 'cover' }}
              />
            ) : (
              <div style={{
                width: '100%',
                height: '100%',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                color: 'var(--color-text-muted)',
              }}>
                <AlbumIcon size={32} />
              </div>
            )}
          </div>

          {/* Title and info */}
          <div style={{ flex: 1, minWidth: 0, paddingTop: '4px' }}>
            <h2
              id="playlist-detail-title"
              style={{
                fontFamily: 'var(--font-heading)',
                fontSize: '20px',
                color: 'var(--color-text-primary)',
                lineHeight: 1.2,
                margin: 0,
                whiteSpace: 'nowrap',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
              }}
            >
              {playlist?.name || 'Playlist'}
            </h2>
            <p style={{
              fontSize: '12px',
              color: 'var(--color-text-muted)',
              margin: '6px 0 0',
            }}>
              {isLoading ? 'Loading...' : `${tracks.length} ${tracks.length === 1 ? 'track' : 'tracks'}`}
            </p>
          </div>

          {/* Close button */}
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
              transition: 'color 0.12s',
              flexShrink: 0,
            }}
            aria-label="Close modal"
            onMouseEnter={(e) => e.currentTarget.style.color = 'var(--color-text-primary)'}
            onMouseLeave={(e) => e.currentTarget.style.color = 'var(--color-text-muted)'}
          >
            <CloseIcon size={18} />
          </button>
        </div>

        {/* Track list - scrollable */}
        <div style={{
          flex: 1,
          overflowY: 'auto',
          minHeight: 0,
          margin: '0 -8px',
          padding: '0 8px',
        }}>
          {isLoading ? (
            <div style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              padding: '40px 0',
              gap: '10px',
              color: 'var(--color-text-muted)',
            }}>
              <Spinner size={20} />
              <span style={{ fontSize: '13px' }}>Loading tracks...</span>
            </div>
          ) : error ? (
            <div style={{ textAlign: 'center', padding: '40px 0' }}>
              <p style={{ color: 'var(--color-danger)', marginBottom: '12px', fontSize: '13px' }}>{error}</p>
              <button
                onClick={fetchTracks}
                style={{
                  ...btnGhostStyle,
                  display: 'inline-flex',
                }}
              >
                Retry
              </button>
            </div>
          ) : tracks.length === 0 ? (
            <div style={{
              textAlign: 'center',
              padding: '40px 20px',
              color: 'var(--color-text-muted)',
              fontSize: '13px',
            }}>
              <MusicNoteIcon size={32} className="text-muted" />
              <p style={{ marginTop: '12px' }}>No tracks in this playlist</p>
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column' }}>
              {tracks.map((track, index) => (
                <div
                  key={track.spotifyId || index}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: '12px',
                    padding: '9px 10px',
                    borderRadius: '9px',
                    cursor: 'pointer',
                    transition: 'background 0.1s',
                  }}
                  onMouseEnter={(e) => e.currentTarget.style.background = 'var(--color-bg-elevated)'}
                  onMouseLeave={(e) => e.currentTarget.style.background = 'transparent'}
                >
                  {/* Thumbnail */}
                  <div style={{
                    width: '48px',
                    height: '36px',
                    borderRadius: '5px',
                    flexShrink: 0,
                    overflow: 'hidden',
                    background: 'var(--color-bg-surface3)',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                  }}>
                    {track.albumArt ? (
                      <img
                        src={track.albumArt}
                        alt=""
                        style={{ width: '100%', height: '100%', objectFit: 'cover' }}
                        loading="lazy"
                      />
                    ) : (
                      <MusicNoteIcon size={14} className="text-muted" />
                    )}
                  </div>

                  {/* Track info */}
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <p style={{
                      fontSize: '13px',
                      fontWeight: 500,
                      color: 'var(--color-text-primary)',
                      margin: 0,
                      whiteSpace: 'nowrap',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                    }}>
                      {track.title}
                    </p>
                    <p style={{
                      fontSize: '11px',
                      color: 'var(--color-text-muted)',
                      margin: '2px 0 0',
                      whiteSpace: 'nowrap',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                    }}>
                      {track.artists?.join(', ') || 'Unknown artist'}
                    </p>
                  </div>

                  {/* Duration */}
                  <span style={{
                    fontSize: '11px',
                    color: 'var(--color-text-muted)',
                    flexShrink: 0,
                  }}>
                    {formatDuration(track.durationMs || 0)}
                  </span>

                  {/* Add button */}
                  <button
                    onClick={() => handleAddTrack(track.spotifyUrl)}
                    style={resultAddStyle}
                    onMouseEnter={(e) => e.currentTarget.style.background = 'rgba(232,200,122,0.18)'}
                    onMouseLeave={(e) => e.currentTarget.style.background = 'var(--color-accent-muted)'}
                    aria-label={`Add ${track.title} to queue`}
                    title="Add to queue"
                  >
                    + Add
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Footer */}
        <div style={{
          display: 'flex',
          gap: '8px',
          justifyContent: 'flex-end',
          paddingTop: '14px',
          borderTop: '1px solid var(--color-border)',
          flexShrink: 0,
        }}>
          <button
            type="button"
            onClick={handleClose}
            style={btnGhostStyle}
            className="btn-ghost"
          >
            Close
          </button>
          <button
            type="button"
            onClick={handleAddAll}
            disabled={isLoading || tracks.length === 0}
            style={{
              ...btnAccentStyle,
              opacity: (isLoading || tracks.length === 0) ? 0.5 : 1,
              cursor: (isLoading || tracks.length === 0) ? 'not-allowed' : 'pointer',
            }}
            className="btn-accent"
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
