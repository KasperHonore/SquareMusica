/**
 * DjBadge - shown in place of a member's name on tracks the AI DJ picked in
 * themed mode (FR-027).
 */
export function DjBadge({ size = 10 }) {
  return (
    <span
      title="Picked by the DJ"
      aria-label="Picked by the DJ"
      style={{
        fontSize: `${size}px`,
        fontWeight: 600,
        letterSpacing: '0.4px',
        padding: '1px 5px',
        borderRadius: '4px',
        color: 'var(--color-accent)',
        background: 'var(--color-accent-muted)',
        flexShrink: 0
      }}
    >
      DJ
    </span>
  );
}
