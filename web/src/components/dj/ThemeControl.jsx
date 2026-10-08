import { useEffect, useState } from 'react';
import { useSocketContext } from '../../context/SocketContext';

const MAX_THEME = 200;
const LOOKAHEADS = [5, 10];

// ThemeState.reason → member-facing text (contracts §1).
const REASON_TEXT = {
  NO_LISTENERS: 'Paused: nobody is listening in the voice channel.',
  NOT_IN_VOICE: "Paused: the bot isn't in a voice channel.",
  CAP_REACHED: "Paused: today's themed-track limit is reached.",
  SERVICE_UNAVAILABLE: "Paused: the DJ's music brain is unavailable right now.",
  THEME_EXHAUSTED: "Paused: the DJ can't find more tracks for this theme."
};

/**
 * ThemeControl - start, change and stop themed mode.
 *
 * Emits dj:theme:start / dj:theme:stop and shows whatever the dj:state
 * broadcast says, so a theme started in Discord or another tab shows here
 * too. A rejected start arrives as the socket's error toast.
 */
export function ThemeControl({ theme, lookahead }) {
  const { startTheme, stopTheme } = useSocketContext();
  const [text, setText] = useState('');
  const [size, setSize] = useState(lookahead ?? 5);

  useEffect(() => {
    if (lookahead) setSize(lookahead);
  }, [lookahead]);

  const trimmed = text.trim();
  const canSubmit = trimmed.length > 0 && trimmed.length <= MAX_THEME;
  const running = Boolean(theme);

  const submit = (e) => {
    e.preventDefault();
    if (!canSubmit) return;
    startTheme(trimmed, size);
    setText('');
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '10px', padding: '10px 0' }}>
      {running ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '4px', minWidth: 0 }}>
          <span style={{ fontSize: '13px', color: 'var(--color-text-primary)' }}>
            <strong>{theme.theme}</strong>
          </span>
          <span style={{ fontSize: '12px', color: 'var(--color-text-secondary)' }}>
            Started by {theme.startedBy?.name ?? 'a member'}
            {' · '}
            <span
              style={{
                color: theme.status === 'running' ? 'var(--color-accent)' : 'var(--color-danger)'
              }}
            >
              {theme.status}
            </span>
          </span>
          {theme.status === 'stalled' && (
            <span style={{ fontSize: '12px', color: 'var(--color-danger)' }}>
              {REASON_TEXT[theme.reason] ?? 'Paused.'}
            </span>
          )}
        </div>
      ) : (
        <span style={{ fontSize: '12px', color: 'var(--color-text-muted)' }}>
          Themed mode is off.
        </span>
      )}

      <form onSubmit={submit} style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
        <input
          type="text"
          aria-label="Theme"
          placeholder={running ? 'New theme' : 'e.g. classic rock road trip'}
          value={text}
          maxLength={MAX_THEME}
          onChange={(e) => setText(e.target.value)}
          style={{ ...fieldStyle, flex: '1 1 200px', minWidth: 0 }}
        />
        <select
          aria-label="Themed lookahead"
          value={size}
          onChange={(e) => setSize(Number(e.target.value))}
          style={fieldStyle}
        >
          {LOOKAHEADS.map((n) => (
            <option key={n} value={n}>
              {n} queued
            </option>
          ))}
        </select>
        <button type="submit" disabled={!canSubmit} style={buttonStyle(canSubmit, true)}>
          {running ? 'Change' : 'Start'}
        </button>
        {running && (
          <button type="button" onClick={() => stopTheme()} style={buttonStyle(true, false)}>
            Stop
          </button>
        )}
      </form>
    </div>
  );
}

const fieldStyle = {
  background: 'var(--color-bg-elevated)',
  color: 'var(--color-text-primary)',
  border: '1px solid var(--color-border)',
  borderRadius: '7px',
  padding: '6px 10px',
  fontSize: '12px',
  fontFamily: 'var(--font-body)'
};

function buttonStyle(enabled, primary) {
  return {
    padding: '6px 14px',
    borderRadius: '7px',
    border: '1px solid var(--color-border)',
    background: primary ? 'var(--color-accent-muted)' : 'transparent',
    color: primary ? 'var(--color-accent)' : 'var(--color-text-secondary)',
    fontSize: '12px',
    fontWeight: 600,
    fontFamily: 'var(--font-body)',
    cursor: enabled ? 'pointer' : 'not-allowed',
    opacity: enabled ? 1 : 0.5
  };
}
