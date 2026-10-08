import { useEffect, useState } from 'react';

const MAX_THEME_CHARS = 200;
const LOOKAHEADS = [5, 10];

// Why themed mode is paused, as members should read it (FR-029).
const STALL_REASONS = {
  NO_LISTENERS: 'Paused: nobody is listening.',
  NOT_IN_VOICE: "Paused: the bot isn't in a voice channel.",
  CAP_REACHED: "Paused: the DJ has hit today's limit.",
  SERVICE_UNAVAILABLE: "Paused: the DJ's music brain is unavailable right now.",
  THEME_EXHAUSTED: 'Paused: no more tracks can be found for this theme.'
};

/**
 * ThemeControl - start, change and stop themed DJ mode.
 *
 * Driven by `djState.theme` from the `dj:state` broadcast, so a change made on
 * Discord or another tab shows up here too. Errors (e.g. no tracks for the
 * theme) arrive as socket `error` events and use the app's error banner.
 */
export function ThemeControl({ themeState, lookahead, onStart, onStop }) {
  const [draft, setDraft] = useState('');
  const [size, setSize] = useState(lookahead ?? 5);
  const [busy, setBusy] = useState(false);
  const running = Boolean(themeState);
  const trimmed = draft.trim();

  // Keep the selector on the saved lookahead when it changes elsewhere.
  useEffect(() => {
    if (lookahead) setSize(lookahead);
  }, [lookahead]);

  // A broadcast (success or not) ends the wait; the first top-up can take a while.
  useEffect(() => {
    setBusy(false);
  }, [themeState]);

  useEffect(() => {
    if (!busy) return undefined;
    const timer = setTimeout(() => setBusy(false), 25000);
    return () => clearTimeout(timer);
  }, [busy]);

  const submit = (event) => {
    event.preventDefault();
    if (!trimmed || trimmed.length > MAX_THEME_CHARS) return;
    setBusy(true);
    onStart(trimmed, size);
    setDraft('');
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '10px', padding: '10px 0' }}>
      {running && (
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            gap: '4px',
            padding: '10px 12px',
            borderRadius: '8px',
            border: '1px solid var(--color-border)',
            background: 'var(--color-bg-elevated)'
          }}
        >
          <span style={{ fontSize: '13px', color: 'var(--color-text-primary)', fontWeight: 600 }}>
            “{themeState.theme}”
          </span>
          <span style={{ fontSize: '12px', color: 'var(--color-text-muted)' }}>
            {themeState.startedBy?.name ? `Started by ${themeState.startedBy.name}` : 'Running'}
          </span>
          <span
            role="status"
            style={{
              fontSize: '12px',
              color: themeState.status === 'stalled' ? 'var(--color-danger)' : 'var(--color-accent)'
            }}
          >
            {themeState.status === 'stalled'
              ? (STALL_REASONS[themeState.reason] ?? 'Paused.')
              : 'Running: keeping the queue topped up.'}
          </span>
        </div>
      )}

      <form onSubmit={submit} style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
        <input
          type="text"
          aria-label="Theme"
          placeholder={running ? 'Change the theme…' : 'e.g. classic rock road trip'}
          value={draft}
          maxLength={MAX_THEME_CHARS}
          onChange={(e) => setDraft(e.target.value)}
          style={inputStyle}
        />
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
          <div
            role="group"
            aria-label="Theme lookahead"
            style={{ display: 'inline-flex', gap: '4px' }}
          >
            {LOOKAHEADS.map((n) => (
              <button
                key={n}
                type="button"
                aria-pressed={size === n}
                onClick={() => setSize(n)}
                style={pillStyle(size === n)}
              >
                {n} ahead
              </button>
            ))}
          </div>
          <span style={{ flex: 1 }} />
          <button type="submit" disabled={!trimmed || busy} style={actionStyle(!trimmed || busy)}>
            {busy ? 'Finding tracks…' : running ? 'Change theme' : 'Start'}
          </button>
          {running && (
            <button type="button" onClick={onStop} style={actionStyle(false, true)}>
              Stop
            </button>
          )}
        </div>
      </form>
    </div>
  );
}

const inputStyle = {
  padding: '8px 10px',
  borderRadius: '7px',
  border: '1px solid var(--color-border)',
  background: 'var(--color-bg-elevated)',
  color: 'var(--color-text-primary)',
  fontSize: '13px',
  fontFamily: 'var(--font-body)'
};

function pillStyle(active) {
  return {
    padding: '6px 10px',
    borderRadius: '7px',
    border: '1px solid var(--color-border)',
    background: active ? 'var(--color-accent-muted)' : 'var(--color-bg-elevated)',
    color: active ? 'var(--color-accent)' : 'var(--color-text-secondary)',
    fontSize: '12px',
    fontWeight: active ? 600 : 400,
    fontFamily: 'var(--font-body)',
    cursor: 'pointer'
  };
}

function actionStyle(disabled, danger = false) {
  return {
    padding: '6px 14px',
    borderRadius: '7px',
    border: '1px solid var(--color-border)',
    background: danger ? 'rgba(255,90,90,0.1)' : 'var(--color-accent-muted)',
    color: danger ? 'var(--color-danger)' : 'var(--color-accent)',
    fontSize: '12px',
    fontWeight: 600,
    fontFamily: 'var(--font-body)',
    cursor: disabled ? 'not-allowed' : 'pointer',
    opacity: disabled ? 0.5 : 1
  };
}
