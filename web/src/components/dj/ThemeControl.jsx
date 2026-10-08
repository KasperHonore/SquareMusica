import { useEffect, useState } from 'react';

const MAX_THEME_CHARS = 200;
const LOOKAHEADS = [5, 10];

/** Plain-language reasons for a stalled theme (FR-029). */
const STALL_TEXT = {
  NO_LISTENERS: 'Nobody is in the voice channel.',
  NOT_IN_VOICE: "The bot isn't in a voice channel.",
  CAP_REACHED: "Today's themed-track limit is reached.",
  SERVICE_UNAVAILABLE: "The DJ's music brain is unavailable right now.",
  THEME_EXHAUSTED: "Can't find any more tracks for this theme."
};

const inputStyle = {
  flex: 1,
  minWidth: 0,
  background: 'var(--color-bg-surface3)',
  color: 'var(--color-text-primary)',
  border: '1px solid var(--color-border)',
  borderRadius: '8px',
  padding: '6px 10px',
  fontSize: '13px',
  fontFamily: 'var(--font-body)'
};

const buttonStyle = {
  border: '1px solid var(--color-border)',
  borderRadius: '8px',
  padding: '6px 14px',
  fontSize: '13px',
  fontWeight: 500,
  cursor: 'pointer',
  fontFamily: 'var(--font-body)'
};

/**
 * ThemeControl - start, change or stop themed DJ mode.
 *
 * Shows the active theme, who started it and whether it is running or stalled
 * (with the reason), all from dj:state, so a change made in Discord shows here
 * without a refresh. Writes through dj:theme:start / dj:theme:stop.
 */
export function ThemeControl({ theme, lookahead, onStart, onStop, cardStyle, selectStyle }) {
  const [text, setText] = useState('');
  const [size, setSize] = useState(lookahead ?? 5);

  useEffect(() => {
    if (lookahead) setSize(lookahead);
  }, [lookahead]);

  const trimmed = text.trim();
  const canSubmit = trimmed.length > 0 && trimmed.length <= MAX_THEME_CHARS;
  const stalled = theme?.status === 'stalled';

  const submit = (e) => {
    e.preventDefault();
    if (!canSubmit) return;
    onStart(trimmed, size);
    setText('');
  };

  return (
    <div style={{ ...cardStyle, flexDirection: 'column', alignItems: 'stretch', gap: '10px' }}>
      <div>
        <div style={{ fontSize: '13px', color: 'var(--color-text-primary)' }}>Themed mode</div>
        <div style={{ fontSize: '11px', color: 'var(--color-text-muted)', marginTop: '2px' }}>
          The DJ builds the queue from a theme and keeps it topped up. Your own requests still play
          first.
        </div>
      </div>

      {theme && (
        <div style={{ fontSize: '13px', color: 'var(--color-text-secondary)' }} aria-live="polite">
          <div>
            &ldquo;{theme.theme}&rdquo;
            {theme.startedBy?.name && <> · started by {theme.startedBy.name}</>}
          </div>
          <div style={{ marginTop: '2px' }}>
            <span
              style={{
                fontSize: '11px',
                fontWeight: 600,
                letterSpacing: '0.6px',
                textTransform: 'uppercase',
                color: stalled ? 'var(--color-danger)' : 'var(--color-accent)'
              }}
            >
              {stalled ? 'stalled' : 'running'}
            </span>
            {stalled && theme.reason && (
              <span style={{ marginLeft: '6px' }}>{STALL_TEXT[theme.reason] ?? theme.reason}</span>
            )}
          </div>
        </div>
      )}

      <form onSubmit={submit} style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
        <input
          type="text"
          aria-label="Theme"
          placeholder={theme ? 'New theme' : 'e.g. classic rock road trip'}
          value={text}
          maxLength={MAX_THEME_CHARS}
          onChange={(e) => setText(e.target.value)}
          style={inputStyle}
        />
        <select
          aria-label="Themed lookahead"
          value={size}
          onChange={(e) => setSize(Number(e.target.value))}
          style={selectStyle}
        >
          {LOOKAHEADS.map((n) => (
            <option key={n} value={n}>
              {n} ahead
            </option>
          ))}
        </select>
        <button
          type="submit"
          disabled={!canSubmit}
          style={{
            ...buttonStyle,
            background: 'var(--color-accent)',
            color: '#0d0d0f',
            opacity: canSubmit ? 1 : 0.5,
            cursor: canSubmit ? 'pointer' : 'not-allowed'
          }}
        >
          {theme ? 'Change' : 'Start'}
        </button>
        {theme && (
          <button
            type="button"
            onClick={onStop}
            style={{
              ...buttonStyle,
              background: 'var(--color-bg-surface3)',
              color: 'var(--color-text-secondary)'
            }}
          >
            Stop
          </button>
        )}
      </form>
    </div>
  );
}
