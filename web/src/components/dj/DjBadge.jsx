/**
 * DjBadge - shown in place of a member's name on tracks themed mode queued
 * (FR-027): the DJ picked them, not a member.
 */
export function DjBadge({ compact = false }) {
  return (
    <span
      title="Picked by the DJ"
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        padding: compact ? '0 5px' : '1px 7px',
        borderRadius: '999px',
        fontSize: compact ? '9px' : '10px',
        fontWeight: 600,
        letterSpacing: '0.4px',
        background: 'var(--color-accent-muted)',
        color: 'var(--color-accent)'
      }}
    >
      DJ
    </span>
  );
}
