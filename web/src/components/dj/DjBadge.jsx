/**
 * DjBadge - shown instead of a member name on tracks the DJ's themed mode
 * added (FR-027).
 */
export function DjBadge({ compact = false }) {
  return (
    <span
      title="Picked by the DJ"
      aria-label="Picked by the DJ"
      style={{
        fontSize: compact ? '9px' : '10px',
        fontWeight: 600,
        letterSpacing: '0.6px',
        textTransform: 'uppercase',
        padding: compact ? '0 5px' : '1px 6px',
        borderRadius: '999px',
        color: 'var(--color-accent)',
        backgroundColor: 'var(--color-accent-muted)'
      }}
    >
      DJ
    </span>
  );
}
