import { useState, useEffect } from 'react';

/**
 * PlaylistsView - Card grid with "New Playlist" dashed card + playlist cards
 * When a playlist is selected, shows an inline detail view with tracks.
 */

const CHIP_COLORS = ['#e8c87a', '#9b7fe8', '#7ec87a', '#e87a7a', '#7ac4e8', '#e8a87a'];

function formatDuration(ms) {
  const minutes = Math.floor(ms / 60000);
  const seconds = Math.floor((ms % 60000) / 1000);
  return `${minutes}:${seconds.toString().padStart(2, '0')}`;
}

export function PlaylistsView({
  albums = [],
  onCreateAlbum,
  selectedPlaylist,
  onSelectPlaylist,
  onAddToQueue,
  onBack
}) {
  // If a playlist is selected, show the detail view
  if (selectedPlaylist) {
    return (
      <PlaylistDetailView playlist={selectedPlaylist} onBack={onBack} onAddToQueue={onAddToQueue} />
    );
  }

  // Otherwise show the card grid
  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fill, minmax(140px, 1fr))',
        gap: '14px',
        padding: '2px'
      }}
    >
      {/* New Playlist dashed card */}
      <button
        onClick={() => onCreateAlbum?.()}
        style={{
          background: 'var(--color-bg-elevated)',
          border: '1px dashed var(--color-border)',
          borderRadius: '10px',
          padding: '14px',
          cursor: 'pointer',
          transition: 'all 0.15s',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          gap: '8px',
          color: 'var(--color-text-muted)',
          minHeight: '140px',
          fontFamily: 'var(--font-body)'
        }}
        className="wave-pl-card-new"
        onMouseEnter={(e) => {
          e.currentTarget.style.color = 'var(--color-accent)';
          e.currentTarget.style.borderColor = 'rgba(232,200,122,0.3)';
          e.currentTarget.style.background = 'rgba(232,200,122,0.1)';
        }}
        onMouseLeave={(e) => {
          e.currentTarget.style.color = 'var(--color-text-muted)';
          e.currentTarget.style.borderColor = 'var(--color-border)';
          e.currentTarget.style.background = 'var(--color-bg-elevated)';
        }}
      >
        <svg
          width="24"
          height="24"
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
          strokeWidth="1.5"
        >
          <line x1="12" y1="5" x2="12" y2="19" />
          <line x1="5" y1="12" x2="19" y2="12" />
        </svg>
        <div style={{ fontSize: '12px', fontWeight: 500 }}>New Playlist</div>
      </button>

      {/* Playlist cards */}
      {albums.map((album, i) => (
        <button
          key={album.id}
          onClick={() => onSelectPlaylist?.(album)}
          style={{
            background: 'var(--color-bg-elevated)',
            border: '1px solid var(--color-border)',
            borderRadius: '10px',
            padding: '14px',
            cursor: 'pointer',
            transition: 'all 0.15s',
            display: 'flex',
            flexDirection: 'column',
            gap: '10px',
            textAlign: 'left',
            color: 'var(--color-text-primary)',
            fontFamily: 'var(--font-body)'
          }}
          className="wave-pl-card"
          onMouseEnter={(e) => {
            e.currentTarget.style.borderColor = 'var(--color-border-strong)';
            e.currentTarget.style.background = 'var(--color-bg-surface3)';
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.borderColor = 'var(--color-border)';
            e.currentTarget.style.background = 'var(--color-bg-elevated)';
          }}
        >
          {/* Art */}
          <div
            style={{
              width: '100%',
              aspectRatio: '1',
              borderRadius: '7px',
              background: `${CHIP_COLORS[i % CHIP_COLORS.length]}18`,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              fontSize: '32px',
              color: CHIP_COLORS[i % CHIP_COLORS.length],
              overflow: 'hidden'
            }}
          >
            {album.coverImage ? (
              <img
                src={album.coverImage}
                alt=""
                style={{ width: '100%', height: '100%', objectFit: 'cover' }}
              />
            ) : (
              '\uD83C\uDFB5'
            )}
          </div>

          <div
            style={{
              fontSize: '13px',
              fontWeight: 500,
              whiteSpace: 'nowrap',
              overflow: 'hidden',
              textOverflow: 'ellipsis'
            }}
          >
            {album.name}
          </div>
          <div style={{ fontSize: '11px', color: 'var(--color-text-muted)' }}>
            {album.spotifyUrl ? 'Spotify' : 'Playlist'}
          </div>
        </button>
      ))}
    </div>
  );
}

/**
 * PlaylistDetailView - Inline detail view showing playlist tracks
 */
function PlaylistDetailView({ playlist, onBack, onAddToQueue }) {
  const [tracks, setTracks] = useState([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!playlist?.id) return;
    setTracks([]);
    setError('');
    setIsLoading(true);

    fetch(`/api/playlists/${playlist.id}/tracks`, { credentials: 'include' })
      .then((res) => {
        if (!res.ok)
          return res.json().then((d) => {
            throw new Error(d.error || 'Failed to fetch tracks');
          });
        return res.json();
      })
      .then((data) => setTracks(data.tracks || []))
      .catch((err) => setError(err.message))
      .finally(() => setIsLoading(false));
  }, [playlist?.id]);

  const handleAddAll = () => {
    if (playlist?.spotifyUrl) {
      onAddToQueue?.(playlist.spotifyUrl);
    }
  };

  const handleAddTrack = (spotifyUrl) => {
    onAddToQueue?.(spotifyUrl);
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
    flexShrink: 0
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
      {/* Back button */}
      <button
        onClick={onBack}
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: '6px',
          background: 'none',
          border: 'none',
          color: 'var(--color-text-secondary)',
          cursor: 'pointer',
          padding: '4px 0',
          fontSize: '13px',
          fontFamily: 'var(--font-body)',
          transition: 'color 0.12s',
          alignSelf: 'flex-start'
        }}
        onMouseEnter={(e) => {
          e.currentTarget.style.color = 'var(--color-accent)';
        }}
        onMouseLeave={(e) => {
          e.currentTarget.style.color = 'var(--color-text-secondary)';
        }}
      >
        <svg
          width="16"
          height="16"
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
          strokeWidth="2"
        >
          <path d="M19 12H5M12 19l-7-7 7-7" />
        </svg>
        Playlists
      </button>

      {/* Playlist header */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '16px' }}>
        <div
          style={{
            width: '80px',
            height: '80px',
            borderRadius: '8px',
            overflow: 'hidden',
            background: 'var(--color-bg-surface3)',
            flexShrink: 0,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            fontSize: '36px'
          }}
        >
          {playlist?.coverImage ? (
            <img
              src={playlist.coverImage}
              alt={playlist.name}
              style={{ width: '100%', height: '100%', objectFit: 'cover' }}
            />
          ) : (
            '\uD83C\uDFB5'
          )}
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <h2
            style={{
              fontFamily: 'var(--font-heading)',
              fontSize: '20px',
              color: 'var(--color-text-primary)',
              margin: 0,
              lineHeight: 1.2,
              whiteSpace: 'nowrap',
              overflow: 'hidden',
              textOverflow: 'ellipsis'
            }}
          >
            {playlist?.name || 'Playlist'}
          </h2>
          <p
            style={{
              fontSize: '12px',
              color: 'var(--color-text-muted)',
              margin: '6px 0 0'
            }}
          >
            {isLoading
              ? 'Loading...'
              : `${tracks.length} ${tracks.length === 1 ? 'track' : 'tracks'}`}
          </p>
        </div>
        <button
          onClick={handleAddAll}
          disabled={isLoading || tracks.length === 0}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: '6px',
            padding: '8px 14px',
            borderRadius: '8px',
            fontSize: '13px',
            fontWeight: 500,
            cursor: isLoading || tracks.length === 0 ? 'not-allowed' : 'pointer',
            transition: 'all 0.12s',
            border: 'none',
            fontFamily: 'var(--font-body)',
            background: 'var(--color-accent)',
            color: '#0d0d0f',
            opacity: isLoading || tracks.length === 0 ? 0.5 : 1,
            flexShrink: 0
          }}
        >
          Add All to Queue
        </button>
      </div>

      {/* Track list */}
      {isLoading ? (
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            padding: '40px 0',
            gap: '10px',
            color: 'var(--color-text-muted)'
          }}
        >
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" className="animate-spin">
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
          <span style={{ fontSize: '13px' }}>Loading tracks...</span>
        </div>
      ) : error ? (
        <div style={{ textAlign: 'center', padding: '40px 0' }}>
          <p style={{ color: 'var(--color-danger)', marginBottom: '12px', fontSize: '13px' }}>
            {error}
          </p>
        </div>
      ) : tracks.length === 0 ? (
        <div
          style={{
            textAlign: 'center',
            padding: '40px 20px',
            color: 'var(--color-text-muted)',
            fontSize: '13px'
          }}
        >
          <svg
            width="32"
            height="32"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M9 18V5l12-2v13" />
            <circle cx="6" cy="18" r="3" />
            <circle cx="18" cy="16" r="3" />
          </svg>
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
                cursor: 'default',
                transition: 'background 0.1s'
              }}
              onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--color-bg-elevated)')}
              onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
            >
              {/* Thumbnail */}
              <div
                style={{
                  width: '48px',
                  height: '36px',
                  borderRadius: '5px',
                  flexShrink: 0,
                  overflow: 'hidden',
                  background: 'var(--color-bg-surface3)',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center'
                }}
              >
                {track.albumArt ? (
                  <img
                    src={track.albumArt}
                    alt=""
                    style={{ width: '100%', height: '100%', objectFit: 'cover' }}
                    loading="lazy"
                  />
                ) : (
                  <svg
                    width="14"
                    height="14"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    style={{ color: 'var(--color-text-muted)' }}
                  >
                    <path d="M9 18V5l12-2v13" />
                    <circle cx="6" cy="18" r="3" />
                    <circle cx="18" cy="16" r="3" />
                  </svg>
                )}
              </div>

              {/* Track info */}
              <div style={{ flex: 1, minWidth: 0 }}>
                <p
                  style={{
                    fontSize: '13px',
                    fontWeight: 500,
                    color: 'var(--color-text-primary)',
                    margin: 0,
                    whiteSpace: 'nowrap',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis'
                  }}
                >
                  {track.title}
                </p>
                <p
                  style={{
                    fontSize: '11px',
                    color: 'var(--color-text-muted)',
                    margin: '2px 0 0',
                    whiteSpace: 'nowrap',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis'
                  }}
                >
                  {track.artists?.join(', ') || 'Unknown artist'}
                </p>
              </div>

              {/* Duration */}
              <span
                style={{
                  fontSize: '11px',
                  color: 'var(--color-text-muted)',
                  flexShrink: 0
                }}
              >
                {formatDuration(track.durationMs || 0)}
              </span>

              {/* Add button */}
              <button
                onClick={() => handleAddTrack(track.spotifyUrl)}
                style={resultAddStyle}
                onMouseEnter={(e) => (e.currentTarget.style.background = 'rgba(232,200,122,0.18)')}
                onMouseLeave={(e) =>
                  (e.currentTarget.style.background = 'var(--color-accent-muted)')
                }
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
  );
}
