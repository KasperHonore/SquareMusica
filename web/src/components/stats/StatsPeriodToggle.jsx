/**
 * The three periods the API supports, in display order. Values match the API's
 * `period` query parameter exactly — an unrecognised value is a 400, not a
 * silent fallback, so these strings are part of the contract.
 */
const PERIODS = [
  { value: 'all', label: 'All Time' },
  { value: 'month', label: 'This Month' },
  { value: 'week', label: 'This Week' }
];

/**
 * StatsPeriodToggle - segmented control over the three stats periods.
 *
 * `value` is driven by the page, which sets it from the API response rather than
 * from its own click state, so a slow response can never leave the control
 * labelling data from a different period.
 */
export function StatsPeriodToggle({ value, onChange, disabled = false }) {
  return (
    <div
      role="group"
      aria-label="Stats period"
      style={{
        display: 'inline-flex',
        padding: '2px',
        borderRadius: '9px',
        background: 'var(--color-bg-elevated)',
        border: '1px solid var(--color-border)',
        // Allows the control to wrap rather than push the header wide at 400px.
        flexWrap: 'wrap'
      }}
    >
      {PERIODS.map((period) => {
        const isActive = value === period.value;
        return (
          <button
            key={period.value}
            type="button"
            onClick={() => onChange?.(period.value)}
            disabled={disabled}
            aria-pressed={isActive}
            style={{
              padding: '6px 12px',
              borderRadius: '7px',
              border: 'none',
              background: isActive ? 'var(--color-accent-muted)' : 'transparent',
              color: isActive ? 'var(--color-accent)' : 'var(--color-text-secondary)',
              fontSize: '12px',
              fontWeight: isActive ? 600 : 400,
              fontFamily: 'var(--font-body)',
              cursor: disabled ? 'default' : 'pointer',
              opacity: disabled && !isActive ? 0.6 : 1,
              transition: 'all 0.12s',
              whiteSpace: 'nowrap'
            }}
            onMouseEnter={(e) => {
              if (!isActive && !disabled) {
                e.currentTarget.style.color = 'var(--color-text-primary)';
              }
            }}
            onMouseLeave={(e) => {
              if (!isActive) {
                e.currentTarget.style.color = 'var(--color-text-secondary)';
              }
            }}
          >
            {period.label}
          </button>
        );
      })}
    </div>
  );
}

export { PERIODS };
