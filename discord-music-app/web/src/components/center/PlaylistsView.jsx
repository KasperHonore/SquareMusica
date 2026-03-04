/**
 * PlaylistsView - Card grid with "New Playlist" dashed card + playlist cards
 * Matches new_ui/player.html `.pl-grid`, `.pl-card`
 */

const CHIP_COLORS = ['#e8c87a', '#9b7fe8', '#7ec87a', '#e87a7a', '#7ac4e8', '#e8a87a'];

export function PlaylistsView({ albums = [], onCreateAlbum, onLoadAlbum }) {
  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fill, minmax(140px, 1fr))',
        gap: '14px',
        padding: '2px',
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
          fontFamily: 'var(--font-body)',
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
          onClick={() => onLoadAlbum?.(album)}
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
            fontFamily: 'var(--font-body)',
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
              overflow: 'hidden',
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
              textOverflow: 'ellipsis',
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
