/**
 * Winner face for a member award: Discord avatar with an initial fallback.
 *
 * Not rendered at all for most_played_song, whose winner is a track.
 */
function WinnerAvatar({ userId, avatar, displayName, size = 28 }) {
  const letter = displayName ? displayName.charAt(0).toUpperCase() : '?';

  const placeholder = (
    <div
      style={{
        width: size,
        height: size,
        borderRadius: '50%',
        flexShrink: 0,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: 'var(--color-accent-muted)',
        color: 'var(--color-accent)',
        fontSize: `${Math.round(size * 0.42)}px`,
        fontWeight: 500
      }}
    >
      {letter}
    </div>
  );

  if (!avatar || !userId) return placeholder;

  return (
    <div style={{ position: 'relative', width: size, height: size, flexShrink: 0 }}>
      <img
        src={`https://cdn.discordapp.com/avatars/${userId}/${avatar}.png?size=${size * 2}`}
        alt={displayName}
        style={{ width: size, height: size, borderRadius: '50%', objectFit: 'cover' }}
        onError={(e) => {
          e.currentTarget.style.display = 'none';
          if (e.currentTarget.nextSibling) {
            e.currentTarget.nextSibling.style.display = 'flex';
          }
        }}
      />
      <div style={{ display: 'none', position: 'absolute', inset: 0 }}>{placeholder}</div>
    </div>
  );
}

/** Square thumbnail for the one award whose winner is a track. */
function TrackThumbnail({ thumbnail, title, size = 28 }) {
  if (!thumbnail) {
    return (
      <div
        style={{
          width: size,
          height: size,
          borderRadius: '5px',
          flexShrink: 0,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          backgroundColor: 'var(--color-bg-surface3)',
          color: 'var(--color-text-muted)',
          fontSize: '12px'
        }}
      >
        ♪
      </div>
    );
  }

  return (
    <img
      src={thumbnail}
      alt={title}
      style={{ width: size, height: size, borderRadius: '5px', objectFit: 'cover', flexShrink: 0 }}
      onError={(e) => {
        e.currentTarget.style.visibility = 'hidden';
      }}
    />
  );
}

function AwardCard({ award }) {
  const hasWinner = Boolean(award.winner);
  // most_played_song is the only award whose winner is a track rather than a
  // member: its userId is null and displayName carries the track title, so it
  // must not be rendered as a member avatar.
  const winnerIsTrack = hasWinner && award.winner.userId === null;

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: '10px',
        padding: '14px',
        borderRadius: '10px',
        background: 'var(--color-bg-elevated)',
        border: '1px solid var(--color-border)',
        minWidth: 0
      }}
    >
      <div style={{ minWidth: 0 }}>
        <div
          style={{
            fontSize: '13px',
            fontWeight: 600,
            color: 'var(--color-text-primary)',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap'
          }}
        >
          {award.name}
        </div>
        <div
          style={{
            fontSize: '11px',
            color: 'var(--color-text-muted)',
            lineHeight: 1.5,
            marginTop: '2px'
          }}
        >
          {award.description}
        </div>
      </div>

      {hasWinner ? (
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px', minWidth: 0 }}>
          {winnerIsTrack ? (
            <TrackThumbnail thumbnail={award.winner.avatar} title={award.winner.displayName} />
          ) : (
            <WinnerAvatar
              userId={award.winner.userId}
              avatar={award.winner.avatar}
              displayName={award.winner.displayName}
            />
          )}

          <div style={{ flex: 1, minWidth: 0 }}>
            <div
              style={{
                fontSize: '13px',
                fontWeight: 500,
                color: 'var(--color-text-primary)',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap'
              }}
              title={award.winner.displayName}
            >
              {award.winner.displayName}
            </div>
            <div style={{ fontSize: '11px', color: 'var(--color-accent)' }}>
              {award.value} {award.valueLabel}
            </div>
          </div>
        </div>
      ) : (
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: '8px',
            fontSize: '12px',
            color: 'var(--color-text-muted)'
          }}
        >
          <span
            style={{
              width: '28px',
              height: '28px',
              borderRadius: '50%',
              flexShrink: 0,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              border: '1px dashed var(--color-border-strong, var(--color-border))'
            }}
          >
            —
          </span>
          {/* The unit still shows here, so the card reads as "nothing yet",
              not as a card that is missing information. */}
          <span>No winner yet · {award.valueLabel}</span>
        </div>
      )}
    </div>
  );
}

/**
 * StatsAwards - responsive card grid.
 *
 * auto-fit + minmax reflows to fewer columns as the panel narrows and lands on a
 * single column on a phone, with no media query to keep in sync.
 */
export function StatsAwards({ awards }) {
  if (!awards || awards.length === 0) return null;

  return (
    <div
      style={{
        display: 'grid',
        // min(190px, 100%) rather than a bare 190px: a bare minimum wider than the
        // container makes the track overflow instead of shrinking, which is how a
        // responsive grid still produces a horizontal scrollbar on a phone.
        gridTemplateColumns: 'repeat(auto-fit, minmax(min(190px, 100%), 1fr))',
        gap: '10px'
      }}
    >
      {/* Keyed off `key`, never array position: the registry order is stable but
          the key is what identifies an award. */}
      {awards.map((award) => (
        <AwardCard key={award.key} award={award} />
      ))}
    </div>
  );
}
