import { useSocketContext } from '../context/SocketContext';
import { ThemeControl } from '../components/dj/ThemeControl';

const INTERVALS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
const LOOKAHEADS = [5, 10];

/** HH:MM from a local ISO timestamp such as caps.resetsAt. */
function resetTime(iso) {
  const match = typeof iso === 'string' ? iso.match(/T(\d{2}):(\d{2})/) : null;
  return match ? `${match[1]}:${match[2]}` : '00:00';
}

/**
 * Dj - the DJ controls page.
 *
 * State comes only from the dj:state broadcast, so a change made in Discord or
 * another tab shows here without a refresh. Controls emit dj:settings and wait
 * for that broadcast rather than updating optimistically; a rejected change
 * leaves the shown value as it was. Never displays DJ line text (FR-001a).
 */
export function Dj() {
  const { djState, setDjSettings } = useSocketContext();

  if (!djState) {
    return <Muted>Loading DJ…</Muted>;
  }

  if (djState.available === false) {
    return <Muted>The DJ isn&apos;t set up on this server.</Muted>;
  }

  const { enabled, interval, lookahead, health, caps } = djState;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '18px', minWidth: 0 }}>
      <section style={{ minWidth: 0 }}>
        <SectionHeading>DJ</SectionHeading>
        <Card>
          <Row label="DJ">
            <Segmented
              label="DJ on or off"
              options={[
                { value: true, label: 'On' },
                { value: false, label: 'Off' }
              ]}
              value={enabled}
              onChange={(value) => setDjSettings({ enabled: value })}
            />
          </Row>
          <Row label="Speaks every">
            <select
              aria-label="DJ interval"
              value={interval}
              onChange={(e) => setDjSettings({ interval: Number(e.target.value) })}
              style={selectStyle}
            >
              {INTERVALS.map((n) => (
                <option key={n} value={n}>
                  {n} {n === 1 ? 'track' : 'tracks'}
                </option>
              ))}
            </select>
          </Row>
          <Row label="Lookahead">
            <Segmented
              label="DJ lookahead"
              options={LOOKAHEADS.map((n) => ({ value: n, label: String(n) }))}
              value={lookahead}
              onChange={(value) => setDjSettings({ lookahead: value })}
            />
          </Row>
          <Row label="Health">
            <span
              style={{
                fontSize: '12px',
                fontWeight: 600,
                padding: '3px 9px',
                borderRadius: '999px',
                background: health === 'ok' ? 'var(--color-accent-muted)' : 'rgba(232,90,90,0.12)',
                color: health === 'ok' ? 'var(--color-accent)' : 'var(--color-danger)'
              }}
            >
              {health}
            </span>
          </Row>
        </Card>
      </section>

      <section style={{ minWidth: 0 }}>
        <SectionHeading>Themed mode</SectionHeading>
        <Card>
          <ThemeControl theme={djState.theme} lookahead={lookahead} />
        </Card>
      </section>

      <section style={{ minWidth: 0 }}>
        <SectionHeading>Today</SectionHeading>
        <Card>
          <CapRow label="Lines spoken" cap={caps.lines} resetsAt={caps.resetsAt} />
          <CapRow label="Themed tracks" cap={caps.themedTracks} resetsAt={caps.resetsAt} />
        </Card>
      </section>
    </div>
  );
}

const selectStyle = {
  background: 'var(--color-bg-elevated)',
  color: 'var(--color-text-primary)',
  border: '1px solid var(--color-border)',
  borderRadius: '7px',
  padding: '6px 10px',
  fontSize: '12px',
  fontFamily: 'var(--font-body)'
};

function CapRow({ label, cap, resetsAt }) {
  return (
    <Row label={label}>
      <span style={{ fontSize: '13px', color: 'var(--color-text-primary)' }}>
        {cap.used} / {cap.limit}
        {cap.reached && (
          <span style={{ color: 'var(--color-danger)', marginLeft: '8px' }}>
            limit reached, resets at {resetTime(resetsAt)}
          </span>
        )}
      </span>
    </Row>
  );
}

function Segmented({ label, options, value, onChange }) {
  return (
    <div
      role="group"
      aria-label={label}
      style={{
        display: 'inline-flex',
        padding: '2px',
        borderRadius: '9px',
        background: 'var(--color-bg-elevated)',
        border: '1px solid var(--color-border)'
      }}
    >
      {options.map((option) => {
        const isActive = value === option.value;
        return (
          <button
            key={String(option.value)}
            type="button"
            aria-pressed={isActive}
            onClick={() => {
              if (!isActive) onChange(option.value);
            }}
            style={{
              padding: '6px 12px',
              borderRadius: '7px',
              border: 'none',
              background: isActive ? 'var(--color-accent-muted)' : 'transparent',
              color: isActive ? 'var(--color-accent)' : 'var(--color-text-secondary)',
              fontSize: '12px',
              fontWeight: isActive ? 600 : 400,
              fontFamily: 'var(--font-body)',
              cursor: 'pointer',
              transition: 'all 0.12s',
              whiteSpace: 'nowrap'
            }}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}

function Card({ children }) {
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        background: 'var(--color-bg-elevated)',
        border: '1px solid var(--color-border)',
        borderRadius: '10px',
        padding: '4px 14px'
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
        padding: '10px 0',
        flexWrap: 'wrap'
      }}
    >
      <span style={{ fontSize: '13px', color: 'var(--color-text-secondary)' }}>{label}</span>
      {children}
    </div>
  );
}

function Muted({ children }) {
  return (
    <p
      style={{
        padding: '32px 20px',
        textAlign: 'center',
        color: 'var(--color-text-muted)',
        fontSize: '13px'
      }}
    >
      {children}
    </p>
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
