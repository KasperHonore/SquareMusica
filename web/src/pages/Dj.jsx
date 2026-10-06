import { useSocketContext } from '../context/SocketContext';

const INTERVALS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
const LOOKAHEADS = [5, 10];

/** A reset timestamp as local HH:MM, matching what Discord shows. */
function formatResetTime(iso) {
  const d = iso ? new Date(iso) : null;
  if (!d || Number.isNaN(d.getTime())) return '00:00';
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/**
 * Dj - the AI DJ control page.
 *
 * Reads the live DjState from the socket and changes it with `dj:settings`; the
 * server answers every change with a dj:state broadcast, so this page never
 * holds its own copy of the settings. DJ line text is never shown (FR-001a).
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
  const resetsAt = formatResetTime(caps?.resetsAt);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '18px', minWidth: 0 }}>
      <section>
        <SectionHeading>DJ</SectionHeading>
        <Row label="Commentary">
          <button
            type="button"
            role="switch"
            aria-checked={enabled}
            onClick={() => setDjSettings({ enabled: !enabled })}
            style={{
              background: enabled ? 'var(--color-accent)' : 'var(--color-bg-elevated)',
              color: enabled ? '#0d0d0f' : 'var(--color-text-secondary)',
              border: '1px solid var(--color-border)',
              borderRadius: '8px',
              padding: '6px 14px',
              fontSize: '13px',
              fontWeight: 500,
              cursor: 'pointer',
              fontFamily: 'var(--font-body)',
              minWidth: '64px'
            }}
          >
            {enabled ? 'On' : 'Off'}
          </button>
        </Row>
        <Row label="Speak every">
          <Select
            value={interval}
            options={INTERVALS}
            suffix={(n) => (n === 1 ? 'track' : 'tracks')}
            onChange={(value) => setDjSettings({ interval: value })}
          />
        </Row>
        <Row label="Themed lookahead">
          <Select
            value={lookahead}
            options={LOOKAHEADS}
            suffix={() => 'tracks'}
            onChange={(value) => setDjSettings({ lookahead: value })}
          />
        </Row>
      </section>

      <section>
        <SectionHeading>Status</SectionHeading>
        <Row label="Health">
          <span
            style={{
              fontSize: '12px',
              fontWeight: 500,
              padding: '3px 10px',
              borderRadius: '999px',
              color: health === 'ok' ? 'var(--color-accent)' : 'var(--color-danger)',
              backgroundColor:
                health === 'ok' ? 'var(--color-accent-muted)' : 'rgba(255, 90, 90, 0.12)'
            }}
          >
            {health === 'ok' ? 'OK' : 'Degraded'}
          </span>
        </Row>
        {caps && (
          <>
            <Row label="Lines today">
              <CapValue cap={caps.lines} resetsAt={resetsAt} />
            </Row>
            <Row label="Themed tracks today">
              <CapValue cap={caps.themedTracks} resetsAt={resetsAt} />
            </Row>
          </>
        )}
      </section>
    </div>
  );
}

function CapValue({ cap, resetsAt }) {
  return (
    <span style={{ fontSize: '13px', color: 'var(--color-text-primary)' }}>
      {cap.used} / {cap.limit}
      {cap.reached && (
        <span style={{ color: 'var(--color-danger)', marginLeft: '8px' }}>
          limit reached, resets at {resetsAt}
        </span>
      )}
    </span>
  );
}

function Select({ value, options, suffix, onChange }) {
  return (
    <select
      value={value}
      onChange={(e) => onChange(Number(e.target.value))}
      style={{
        background: 'var(--color-bg-elevated)',
        color: 'var(--color-text-primary)',
        border: '1px solid var(--color-border)',
        borderRadius: '8px',
        padding: '6px 10px',
        fontSize: '13px',
        fontFamily: 'var(--font-body)',
        cursor: 'pointer'
      }}
    >
      {options.map((n) => (
        <option key={n} value={n}>
          {n} {suffix(n)}
        </option>
      ))}
    </select>
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
        padding: '10px 0',
        borderBottom: '1px solid var(--color-border)'
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
