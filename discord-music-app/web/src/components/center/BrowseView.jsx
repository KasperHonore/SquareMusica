/**
 * BrowseView - Default home screen with 2-column card grid
 * Matches new_ui/player.html `.default-grid`, `.default-card`
 */
export function BrowseView({ onViewChange, albums = [] }) {
  const cards = [
    {
      icon: '\u2764\uFE0F',
      label: 'Liked Songs',
      sub: 'Your favourites',
      onClick: () => {},
    },
    {
      icon: '\uD83D\uDD50',
      label: 'Recently Played',
      sub: 'Play history',
      onClick: () => onViewChange?.('history'),
    },
    ...albums.map((al) => ({
      icon: '\uD83C\uDFB5',
      label: al.name,
      sub: 'Playlist',
      onClick: () => {},
    })),
  ];

  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: '1fr 1fr',
        gap: '10px',
      }}
    >
      {cards.map((card, i) => (
        <button
          key={i}
          onClick={card.onClick}
          style={{
            background: 'var(--color-bg-elevated)',
            border: '1px solid var(--color-border)',
            borderRadius: '10px',
            padding: '16px',
            cursor: 'pointer',
            transition: 'all 0.12s',
            display: 'flex',
            alignItems: 'center',
            gap: '12px',
            textAlign: 'left',
            color: 'var(--color-text-primary)',
            fontFamily: 'var(--font-body)',
            animationDelay: `${i * 50}ms`,
          }}
          className="wave-default-card"
          onMouseEnter={(e) => {
            e.currentTarget.style.borderColor = 'var(--color-border-strong)';
            e.currentTarget.style.background = 'var(--color-bg-surface3)';
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.borderColor = 'var(--color-border)';
            e.currentTarget.style.background = 'var(--color-bg-elevated)';
          }}
        >
          <span style={{ fontSize: '22px', flexShrink: 0 }}>{card.icon}</span>
          <div>
            <div style={{ fontSize: '13px', fontWeight: 500 }}>{card.label}</div>
            <div
              style={{
                fontSize: '11px',
                color: 'var(--color-text-muted)',
                marginTop: '2px',
              }}
            >
              {card.sub}
            </div>
          </div>
        </button>
      ))}
    </div>
  );
}
