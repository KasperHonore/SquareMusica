import { useSocketContext } from '../context/SocketContext';

const INTERVALS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
const LOOKAHEADS = [5, 10];

/** HH:MM from the server's resetsAt, read as written so it matches Discord. */
function resetTime(resetsAt) {
  const match = typeof resetsAt === 'string' ? /T(\d{2}:\d{2})/.exec(resetsAt) : null;
  return match ? match[1] : '00:00';
}

/**
 * Dj - the AI DJ control page.
 *
 * Driven entirely by `djState` from the socket (initial:state, then dj:state
 * broadcasts), so a change made in Discord or another tab shows here without a
 * refresh. Changes go out as `dj:settings`; the page never updates itself
 * optimistically, it waits for the broadcast. DJ line text is never shown
 * (FR-001a): lines are speech only.
 */
export function Dj() {
  const { djState, setDjSettings } = useSocketContext();

  if (!djState?.available) {
    return (
      <div
        style={{
          padding: '32px 20px',
          textAlign: 'center',
          color: 'var(--color-text-muted)',
          fontSize: '13px'
        }}
      >
        The DJ isn&apos;t set up on this server.
      </div>
    );
  }

  const { enabled, interval, lookahead, health, caps } = djState;
  const resetsAt = resetTime(caps?.resetsAt);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '18px', minWidth: 0 }}>
      <section style={{ minWidth: 0 }}>
        <SectionHeading>Commentary</SectionHeading>
        <Card>
          <Row label="DJ">
            <button
              type="button"
              role="switch"
              aria-checked={enabled}
              onClick={() => setDjSettings({ enabled: !enabled })}
              style={{
                padding: '6px 14px',
                borderRadius: '8px',
                border: 'none',
                background: enabled ? 'var(--color-accent)' : 'var(--color-bg-surface3)',
                color: enabled ? '#0d0d0f' : 'var(--color-text-secondary)',
                fontSize: '12px',
                fontWeight: 600,
                fontFamily: 'var(--font-body)',
                cursor: 'pointer',
                transition: 'all 0.12s'
              }}
            >
              {enabled ? 'On' : 'Off'}
            </button>
          </Row>

          <Row label="Speak every">
            <Select
              ariaLabel="DJ interval"
              value={interval}
              options={INTERVALS}
              format={(n) => `${n} ${n === 1 ? 'track' : 'tracks'}`}
              onChange={(n) => setDjSettings({ interval: n })}
            />
          </Row>

          <Row label="Themed lookahead">
            <Select
              ariaLabel="DJ lookahead"
              value={lookahead}
              options={LOOKAHEADS}
              format={(n) => `${n} tracks`}
              onChange={(n) => setDjSettings({ lookahead: n })}
            />
          </Row>
        </Card>
      </section>

      <section style={{ minWidth: 0 }}>
        <SectionHeading>Status</SectionHeading>
        <Card>
          <Row label="Health">
            <span
              style={{
                padding: '3px 10px',
                borderRadius: '999px',
                fontSize: '11px',
                fontWeight: 600,
                letterSpacing: '0.4px',
                textTransform: 'uppercase',
                background:
                  health === 'ok' ? 'var(--color-accent-muted)' : 'rgba(232,122,122,0.12)',
                color: health === 'ok' ? 'var(--color-accent)' : 'var(--color-danger)'
              }}
            >
              {health === 'ok' ? 'OK' : 'Degraded'}
            </span>
          </Row>
          <CapRow label="Lines today" cap={caps?.lines} resetsAt={resetsAt} />
          <CapRow label="Themed tracks today" cap={caps?.themedTracks} resetsAt={resetsAt} />
        </Card>
      </section>
    </div>
  );
}

function CapRow({ label, cap, resetsAt }) {
  if (!cap) return null;
  return (
    <Row label={label}>
      <span style={{ fontSize: '13px', color: 'var(--color-text-primary)' }}>
        {cap.used} / {cap.limit}
        {cap.reached && (
          <span style={{ marginLeft: '8px', fontSize: '12px', color: 'var(--color-danger)' }}>
            limit reached, resets at {resetsAt}
          </span>
        )}
      </span>
    </Row>
  );
}

function Select({ ariaLabel, value, options, format, onChange }) {
  return (
    <select
      aria-label={ariaLabel}
      value={value}
      onChange={(e) => onChange(Number(e.target.value))}
      style={{
        padding: '6px 10px',
        borderRadius: '8px',
        border: '1px solid var(--color-border)',
        background: 'var(--color-bg-elevated)',
        color: 'var(--color-text-primary)',
        fontSize: '12px',
        fontFamily: 'var(--font-body)',
        cursor: 'pointer'
      }}
    >
      {options.map((n) => (
        <option key={n} value={n}>
          {format(n)}
        </option>
      ))}
    </select>
  );
}

function Card({ children }) {
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        borderRadius: '10px',
        border: '1px solid var(--color-border)',
        background: 'var(--color-bg-elevated)',
        overflow: 'hidden'
      }}
    >
      {children}
    </div>
  );
}

function Row({ label, children }) {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: '12px',
        padding: '12px 16px',
        borderBottom: '1px solid var(--color-border)',
        flexWrap: 'wrap'
      }}
    >
      <span style={{ fontSize: '13px', color: 'var(--color-text-secondary)' }}>{label}</span>
      {children}
    </div>
  );
}

function SectionHeading({ children }) {
  return (
    <div
      style={{
        fontSize: '11px',
        fontWeight: 600,
        letterSpacing: '0.8px',
        textTransform: 'uppercase',
        color: 'var(--color-text-secondary)',
        padding: '0 0 10px'
      }}
    >
      {children}
    </div>
  );
}
