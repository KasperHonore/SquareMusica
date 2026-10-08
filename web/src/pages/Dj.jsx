import { useEffect, useState } from 'react';
import { useSocketContext } from '../context/SocketContext';
import { ListenerList } from '../components/dj/ListenerList';

const INTERVALS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
const LOOKAHEADS = [5, 10];

/** "HH:MM" from `caps.resetsAt`, which already carries the server's local offset. */
function resetTime(resetsAt) {
  const match = typeof resetsAt === 'string' ? resetsAt.match(/T(\d{2}:\d{2})/) : null;
  return match ? match[1] : '00:00';
}

/**
 * Dj - the AI DJ controls page.
 *
 * Driven entirely by the `dj:state` broadcast: a change from any surface (this
 * page, another tab, Discord) re-renders here without a refresh, and a rejected
 * change leaves the shown settings as they were. Never shows DJ line text
 * (FR-001a).
 */
export function Dj() {
  const { djState, setDjSettings, listeners, shoutoutsEnabled, setShoutoutsEnabled, setShoutouts } =
    useSocketContext();
  const [shoutoutsError, setShoutoutsError] = useState(null);
  const available = djState?.available === true;

  // Load this member's preference once; dj:shoutouts pushes keep it current.
  useEffect(() => {
    if (!available) return undefined;
    let cancelled = false;
    fetch('/api/dj/shoutouts/me', { credentials: 'include' })
      .then((response) => {
        if (!response.ok) throw new Error('Failed to load your shout-out setting.');
        return response.json();
      })
      .then((body) => {
        if (!cancelled) setShoutoutsEnabled(body.enabled);
      })
      .catch((err) => {
        if (!cancelled) setShoutoutsError(err.message);
      });
    return () => {
      cancelled = true;
    };
  }, [available, setShoutoutsEnabled]);

  if (!djState) {
    return (
      <p style={{ color: 'var(--color-text-muted)', fontSize: '13px', padding: '20px 0' }}>
        Loading DJ…
      </p>
    );
  }

  if (djState.available === false) {
    return (
      <p style={{ color: 'var(--color-text-muted)', fontSize: '13px', padding: '20px 0' }}>
        The DJ isn&apos;t set up on this server.
      </p>
    );
  }

  const { enabled, interval, lookahead, health, caps } = djState;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '18px', minWidth: 0 }}>
      <section>
        <SectionHeading>DJ</SectionHeading>
        <Row label="Talk between songs">
          <button
            type="button"
            role="switch"
            aria-checked={enabled}
            onClick={() => setDjSettings({ enabled: !enabled })}
            style={{
              ...pillStyle(enabled),
              minWidth: '56px'
            }}
          >
            {enabled ? 'On' : 'Off'}
          </button>
        </Row>
        <Row label="Speak every">
          <select
            aria-label="Interval"
            value={interval}
            onChange={(e) => setDjSettings({ interval: Number(e.target.value) })}
            style={selectStyle}
          >
            {INTERVALS.map((n) => (
              <option key={n} value={n}>
                {n === 1 ? 'track' : `${n} tracks`}
              </option>
            ))}
          </select>
        </Row>
        <Row label="Themed lookahead">
          <div role="group" aria-label="Lookahead" style={{ display: 'inline-flex', gap: '4px' }}>
            {LOOKAHEADS.map((n) => (
              <button
                key={n}
                type="button"
                aria-pressed={lookahead === n}
                onClick={() => setDjSettings({ lookahead: n })}
                style={pillStyle(lookahead === n)}
              >
                {n}
              </button>
            ))}
          </div>
        </Row>
      </section>

      <section>
        <SectionHeading>You</SectionHeading>
        <Row label="Shout-outs about me">
          {shoutoutsEnabled === null ? (
            <span style={{ fontSize: '12px', color: 'var(--color-text-muted)' }}>
              {shoutoutsError ?? 'Loading…'}
            </span>
          ) : (
            <button
              type="button"
              role="switch"
              aria-checked={shoutoutsEnabled}
              onClick={() => setShoutouts(!shoutoutsEnabled)}
              style={{
                ...pillStyle(shoutoutsEnabled),
                minWidth: '56px'
              }}
            >
              {shoutoutsEnabled ? 'On' : 'Off'}
            </button>
          )}
        </Row>
      </section>

      <section>
        <SectionHeading>Listening now</SectionHeading>
        <ListenerList listeners={listeners} />
      </section>

      <section>
        <SectionHeading>Status</SectionHeading>
        <Row label="Health">
          <span
            style={{
              fontSize: '12px',
              fontWeight: 600,
              padding: '3px 8px',
              borderRadius: '6px',
              color: health === 'ok' ? 'var(--color-accent)' : 'var(--color-danger)',
              background: health === 'ok' ? 'var(--color-accent-muted)' : 'rgba(255,90,90,0.1)'
            }}
          >
            {health === 'ok' ? 'OK' : 'Degraded'}
          </span>
        </Row>
        <CapRow label="Lines today" cap={caps.lines} resetsAt={caps.resetsAt} />
        <CapRow label="Themed tracks today" cap={caps.themedTracks} resetsAt={caps.resetsAt} />
      </section>
    </div>
  );
}

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

function pillStyle(active) {
  return {
    padding: '6px 12px',
    borderRadius: '7px',
    border: '1px solid var(--color-border)',
    background: active ? 'var(--color-accent-muted)' : 'var(--color-bg-elevated)',
    color: active ? 'var(--color-accent)' : 'var(--color-text-secondary)',
    fontSize: '12px',
    fontWeight: active ? 600 : 400,
    fontFamily: 'var(--font-body)',
    cursor: 'pointer',
    transition: 'all 0.12s'
  };
}

const selectStyle = {
  padding: '6px 10px',
  borderRadius: '7px',
  border: '1px solid var(--color-border)',
  background: 'var(--color-bg-elevated)',
  color: 'var(--color-text-primary)',
  fontSize: '12px',
  fontFamily: 'var(--font-body)'
};

function SectionHeading({ children }) {
  return (
    <div
      style={{
        fontSize: '11px',
        fontWeight: 600,
        letterSpacing: '0.8px',
        textTransform: 'uppercase',
        color: 'var(--color-text-secondary)',
        padding: '0 0 6px'
      }}
    >
      {children}
    </div>
  );
}
