import { useSocketContext } from '../context/SocketContext';

const INTERVALS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
const LOOKAHEADS = [5, 10];

/** HH:MM of a resetsAt string; it carries the server's local offset already. */
function resetTime(resetsAt) {
  const match = typeof resetsAt === 'string' ? /T(\d{2}:\d{2})/.exec(resetsAt) : null;
  return match ? match[1] : 'midnight';
}

const cardStyle = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: '12px',
  padding: '14px 16px',
  backgroundColor: 'var(--color-bg-elevated)',
  border: '1px solid var(--color-border)',
  borderRadius: '10px'
};

const labelStyle = { fontSize: '13px', color: 'var(--color-text-primary)' };
const hintStyle = { fontSize: '11px', color: 'var(--color-text-muted)', marginTop: '2px' };

const selectStyle = {
  background: 'var(--color-bg-surface3)',
  color: 'var(--color-text-primary)',
  border: '1px solid var(--color-border)',
  borderRadius: '8px',
  padding: '6px 10px',
  fontSize: '13px',
  fontFamily: 'var(--font-body)',
  cursor: 'pointer'
};

function Row({ label, hint, children }) {
  return (
    <div style={cardStyle}>
      <div style={{ minWidth: 0 }}>
        <div style={labelStyle}>{label}</div>
        {hint && <div style={hintStyle}>{hint}</div>}
      </div>
      {children}
    </div>
  );
}

function CapLine({ label, cap, resetsAt }) {
  return (
    <div style={{ fontSize: '13px', color: 'var(--color-text-secondary)' }}>
      {label}: {cap.used} / {cap.limit}
      {cap.reached && (
        <span style={{ color: 'var(--color-danger)' }}>
          {' '}
          · limit reached, resets at {resetTime(resetsAt)}
        </span>
      )}
    </div>
  );
}

/**
 * Dj - the AI DJ control page.
 *
 * Reads djState from the socket (initial:state, then every dj:state broadcast)
 * so changes from Discord or another tab show without a refresh, and writes
 * through dj:settings. Never displays DJ line text (FR-001a).
 */
export function Dj() {
  const { djState, setDjSettings } = useSocketContext();

  if (!djState) {
    return (
      <p
        style={{
          padding: '40px 20px',
          textAlign: 'center',
          color: 'var(--color-text-muted)',
          fontSize: '13px'
        }}
      >
        Loading DJ settings...
      </p>
    );
  }

  if (djState.available === false) {
    return (
      <p
        style={{
          padding: '40px 20px',
          textAlign: 'center',
          color: 'var(--color-text-muted)',
          fontSize: '13px'
        }}
      >
        The DJ isn&apos;t set up on this server.
      </p>
    );
  }

  const { enabled, interval, lookahead, health, caps } = djState;
  const degraded = health === 'degraded';

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '10px', minWidth: 0 }}>
      <Row label="DJ" hint="Speaks between songs over the start of the next track.">
        <button
          role="switch"
          aria-checked={enabled}
          onClick={() => setDjSettings({ enabled: !enabled })}
          style={{
            background: enabled ? 'var(--color-accent)' : 'var(--color-bg-surface3)',
            color: enabled ? '#0d0d0f' : 'var(--color-text-secondary)',
            border: '1px solid var(--color-border)',
            borderRadius: '8px',
            padding: '6px 14px',
            fontSize: '13px',
            fontWeight: 500,
            cursor: 'pointer',
            fontFamily: 'var(--font-body)',
            minWidth: '56px'
          }}
        >
          {enabled ? 'On' : 'Off'}
        </button>
      </Row>

      <Row label="Interval" hint="How many track changes between DJ lines.">
        <select
          aria-label="Interval"
          value={interval}
          onChange={(e) => setDjSettings({ interval: Number(e.target.value) })}
          style={selectStyle}
        >
          {INTERVALS.map((n) => (
            <option key={n} value={n}>
              Every {n} track{n === 1 ? '' : 's'}
            </option>
          ))}
        </select>
      </Row>

      <Row label="Lookahead" hint="How many tracks themed mode keeps queued ahead.">
        <select
          aria-label="Lookahead"
          value={lookahead}
          onChange={(e) => setDjSettings({ lookahead: Number(e.target.value) })}
          style={selectStyle}
        >
          {LOOKAHEADS.map((n) => (
            <option key={n} value={n}>
              {n} tracks
            </option>
          ))}
        </select>
      </Row>

      <Row label="Health">
        <span
          style={{
            fontSize: '11px',
            fontWeight: 600,
            letterSpacing: '0.6px',
            textTransform: 'uppercase',
            padding: '3px 8px',
            borderRadius: '999px',
            color: degraded ? 'var(--color-danger)' : 'var(--color-accent)',
            backgroundColor: degraded ? 'rgba(255,90,90,0.12)' : 'var(--color-accent-muted)'
          }}
        >
          {degraded ? 'degraded' : 'ok'}
        </span>
      </Row>

      {caps && (
        <div
          style={{ ...cardStyle, flexDirection: 'column', alignItems: 'flex-start', gap: '4px' }}
        >
          <div style={labelStyle}>Today&apos;s usage</div>
          <CapLine label="Lines" cap={caps.lines} resetsAt={caps.resetsAt} />
          <CapLine label="Themed tracks" cap={caps.themedTracks} resetsAt={caps.resetsAt} />
        </div>
      )}
    </div>
  );
}
