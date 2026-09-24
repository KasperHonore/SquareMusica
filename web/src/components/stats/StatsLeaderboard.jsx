/**
 * Format a total listening time as a compact "3h 24m" / "24m" string.
 *
 * Distinct from formatTime, which renders a single track's m:ss. A leaderboard
 * total runs to hours, where "204:31" reads as nonsense.
 */
function formatListeningTime(seconds) {
  if (!seconds || Number.isNaN(seconds)) return '0m';
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (hours === 0) return `${minutes}m`;
  return `${hours}h ${minutes}m`;
}

/**
 * Member avatar with a placeholder fallback.
 *
 * A member who has left the guild may have an avatar hash that no longer
 * resolves, so a null hash and a failed load both fall back to the initial
 * rather than to a broken-image icon.
 */
function DjAvatar({ userId, avatar, displayName, size = 32 }) {
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
        fontSize: `${Math.round(size * 0.4)}px`,
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

/** One row. `pinned` renders the requester's own row below a truncated top 10. */
function LeaderboardRow({ entry, index, pinned = false }) {
  const highlight = entry.isSelf;

  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: '12px',
        padding: '10px 12px',
        borderRadius: '9px',
        background: highlight
          ? 'var(--color-accent-muted)'
          : index % 2 !== 0
            ? 'rgba(255,255,255,0.02)'
            : 'transparent',
        border: highlight ? '1px solid var(--color-accent)' : '1px solid transparent',
        // Let a long name shrink this row rather than widen the page.
        minWidth: 0
      }}
    >
      {/* Rank */}
      <div
        style={{
          width: '24px',
          flexShrink: 0,
          textAlign: 'right',
          fontSize: '13px',
          fontWeight: 600,
          fontVariantNumeric: 'tabular-nums',
          color: highlight ? 'var(--color-accent)' : 'var(--color-text-secondary)'
        }}
      >
        {entry.rank}
      </div>

      <DjAvatar
        userId={entry.userId}
        avatar={entry.avatar}
        displayName={entry.displayName}
        size={32}
      />

      {/* Name + secondary line */}
      <div style={{ flex: 1, minWidth: 0 }}>
        <div
          style={{
            fontSize: '14px',
            fontWeight: 500,
            color: 'var(--color-text-primary)',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap'
          }}
          title={entry.displayName}
        >
          {entry.displayName}
          {highlight && (
            <span
              style={{
                marginLeft: '8px',
                fontSize: '10px',
                fontWeight: 600,
                letterSpacing: '0.6px',
                textTransform: 'uppercase',
                color: 'var(--color-accent)'
              }}
            >
              You
            </span>
          )}
        </div>
        <div
          style={{
            fontSize: '11px',
            color: 'var(--color-text-muted)',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap'
          }}
        >
          {entry.uniqueTrackCount} unique · {formatListeningTime(entry.totalDurationSeconds)}
          {pinned ? ' · your position' : ''}
        </div>
      </div>

      {/* Track count */}
      <div style={{ flexShrink: 0, textAlign: 'right' }}>
        <div
          style={{
            fontSize: '15px',
            fontWeight: 600,
            fontVariantNumeric: 'tabular-nums',
            color: highlight ? 'var(--color-accent)' : 'var(--color-text-primary)'
          }}
        >
          {entry.trackCount}
        </div>
        <div style={{ fontSize: '10px', color: 'var(--color-text-muted)' }}>
          {entry.trackCount === 1 ? 'track' : 'tracks'}
        </div>
      </div>
    </div>
  );
}

/**
 * StatsLeaderboard - ranked top DJs, with the requester's own row pinned below
 * the list when they fall outside it.
 */
export function StatsLeaderboard({ leaderboard, selfEntry, truncated, periodPhrase }) {
  if (!leaderboard || leaderboard.length === 0) {
    return (
      <div
        style={{
          padding: '32px 20px',
          textAlign: 'center',
          color: 'var(--color-text-muted)',
          fontSize: '13px',
          lineHeight: 1.7
        }}
      >
        No tracks played {periodPhrase}. Queue something and the leaderboard will fill up.
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '2px' }}>
      {leaderboard.map((entry, index) => (
        <LeaderboardRow key={entry.userId} entry={entry} index={index} />
      ))}

      {truncated && !selfEntry && (
        <div
          style={{
            padding: '10px 12px',
            fontSize: '11px',
            color: 'var(--color-text-muted)',
            textAlign: 'center'
          }}
        >
          Showing the top {leaderboard.length} of more DJs.
        </div>
      )}

      {selfEntry && (
        <>
          {/* Visual separation: the pinned row is not rank 11. */}
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '8px',
              padding: '8px 12px 4px',
              fontSize: '11px',
              color: 'var(--color-text-muted)'
            }}
          >
            <span style={{ flex: 1, height: '1px', background: 'var(--color-border)' }} />
            <span>your position</span>
            <span style={{ flex: 1, height: '1px', background: 'var(--color-border)' }} />
          </div>
          <LeaderboardRow entry={selfEntry} index={0} pinned />
        </>
      )}
    </div>
  );
}
