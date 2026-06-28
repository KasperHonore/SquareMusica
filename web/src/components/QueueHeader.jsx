import { useState, useEffect } from 'react';
import { Shuffle, Trash } from './icons';

/**
 * QueueHeader - "Up Next" title, count badge, resolution indicator,
 * and the shuffle / clear controls (with inline clear confirmation).
 */
export function QueueHeader({ count, isEmpty, hasUnresolved, isRightPanel, onShuffle, onClear }) {
  const [showClearConfirm, setShowClearConfirm] = useState(false);

  // Auto-dismiss confirmation after 3 seconds
  useEffect(() => {
    if (showClearConfirm) {
      const timer = setTimeout(() => setShowClearConfirm(false), 3000);
      return () => clearTimeout(timer);
    }
  }, [showClearConfirm]);

  const handleClearClick = () => {
    setShowClearConfirm(true);
  };

  const handleClearConfirm = () => {
    onClear();
    setShowClearConfirm(false);
  };

  const handleClearCancel = () => {
    setShowClearConfirm(false);
  };

  return (
    <div
      className="flex items-center justify-between flex-shrink-0"
      style={{ padding: isRightPanel ? '11px 20px 9px' : '8px 4px 12px' }}
    >
      <div className="flex items-center gap-2">
        <span
          style={{
            fontSize: isRightPanel ? '10px' : '11px',
            fontWeight: 600,
            letterSpacing: isRightPanel ? '1px' : '0.8px',
            textTransform: 'uppercase',
            color: 'var(--color-text-muted)'
          }}
          id="queue-heading"
        >
          Up Next
        </span>
        {!isEmpty && (
          <span
            className="text-mono"
            style={{
              fontSize: '10px',
              padding: '1px 6px',
              borderRadius: '9999px',
              backgroundColor: 'var(--color-accent-subtle)',
              color: 'var(--color-accent)'
            }}
          >
            {count}
          </span>
        )}
        {hasUnresolved && (
          <span
            className="flex items-center gap-1"
            title="Resolving Spotify tracks"
            aria-label="Resolving Spotify tracks"
          >
            <svg
              className="w-4 h-4 animate-pulse"
              fill="#1DB954"
              viewBox="0 0 24 24"
              aria-hidden="true"
            >
              <path d="M12 0C5.4 0 0 5.4 0 12s5.4 12 12 12 12-5.4 12-12S18.66 0 12 0zm5.521 17.34c-.24.359-.66.48-1.021.24-2.82-1.74-6.36-2.101-10.561-1.141-.418.122-.779-.179-.899-.539-.12-.421.18-.78.54-.9 4.56-1.021 8.52-.6 11.64 1.32.42.18.479.659.301 1.02zm1.44-3.3c-.301.42-.841.6-1.262.3-3.239-1.98-8.159-2.58-11.939-1.38-.479.12-1.02-.12-1.14-.6-.12-.48.12-1.021.6-1.141C9.6 9.9 15 10.561 18.72 12.84c.361.181.54.78.241 1.2zm.12-3.36C15.24 8.4 8.82 8.16 5.16 9.301c-.6.179-1.2-.181-1.38-.721-.18-.601.18-1.2.72-1.381 4.26-1.26 11.28-1.02 15.721 1.621.539.3.719 1.02.419 1.56-.299.421-1.02.599-1.559.3z" />
            </svg>
          </span>
        )}
      </div>
      <div className="flex items-center" style={{ gap: isRightPanel ? '10px' : '4px' }}>
        {/* Clear button with inline confirmation */}
        {showClearConfirm ? (
          <div
            className="flex items-center gap-1 animate-fade-in"
            style={{
              background: 'var(--color-bg-elevated)',
              borderRadius: '9999px',
              padding: '2px 8px'
            }}
          >
            <span
              style={{
                fontSize: '11px',
                color: 'var(--color-text-secondary)',
                whiteSpace: 'nowrap'
              }}
            >
              Clear?
            </span>
            <button
              onClick={handleClearConfirm}
              className="flex items-center justify-center"
              style={{
                padding: '4px',
                color: 'var(--color-success)',
                borderRadius: '50%',
                border: 'none',
                background: 'none',
                cursor: 'pointer',
                transition: 'background 0.12s',
                minWidth: '24px',
                minHeight: '24px'
              }}
              title="Confirm clear"
              aria-label="Confirm clear queue"
            >
              <svg width={14} height={14} viewBox="0 0 24 24" fill="currentColor">
                <path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z" />
              </svg>
            </button>
            <button
              onClick={handleClearCancel}
              className="flex items-center justify-center"
              style={{
                padding: '4px',
                color: 'var(--color-danger)',
                borderRadius: '50%',
                border: 'none',
                background: 'none',
                cursor: 'pointer',
                transition: 'background 0.12s',
                minWidth: '24px',
                minHeight: '24px'
              }}
              title="Cancel"
              aria-label="Cancel clear queue"
            >
              <svg width={14} height={14} viewBox="0 0 24 24" fill="currentColor">
                <path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z" />
              </svg>
            </button>
          </div>
        ) : isRightPanel ? (
          <>
            <button
              onClick={onShuffle}
              disabled={isEmpty}
              style={{
                background: 'none',
                border: 'none',
                fontSize: '11px',
                color: isEmpty ? 'var(--color-text-muted)' : 'var(--color-text-muted)',
                cursor: isEmpty ? 'not-allowed' : 'pointer',
                fontFamily: 'var(--font-body)',
                transition: 'color 0.12s',
                padding: 0,
                opacity: isEmpty ? 0.5 : 1
              }}
              className="wave-queue-action"
              title="Shuffle queue"
              aria-label="Shuffle queue"
            >
              Shuffle
            </button>
            <button
              onClick={handleClearClick}
              disabled={isEmpty}
              style={{
                background: 'none',
                border: 'none',
                fontSize: '11px',
                color: isEmpty ? 'var(--color-text-muted)' : 'var(--color-text-muted)',
                cursor: isEmpty ? 'not-allowed' : 'pointer',
                fontFamily: 'var(--font-body)',
                transition: 'color 0.12s',
                padding: 0,
                opacity: isEmpty ? 0.5 : 1
              }}
              className="wave-queue-action-danger"
              title="Clear queue"
              aria-label="Clear queue"
            >
              Clear
            </button>
          </>
        ) : (
          <>
            <button
              onClick={handleClearClick}
              disabled={isEmpty}
              className="flex items-center justify-center"
              style={{
                padding: '8px',
                color: 'var(--color-text-secondary)',
                opacity: isEmpty ? 0.5 : 1,
                cursor: isEmpty ? 'not-allowed' : 'pointer',
                borderRadius: '9999px',
                border: 'none',
                background: 'none',
                transition: 'color 0.12s, background 0.12s',
                minWidth: '44px',
                minHeight: '44px'
              }}
              title="Clear queue"
              aria-label="Clear queue"
            >
              <Trash size={20} />
            </button>
            <button
              onClick={onShuffle}
              disabled={isEmpty}
              className="flex items-center justify-center"
              style={{
                padding: '8px',
                color: 'var(--color-text-secondary)',
                opacity: isEmpty ? 0.5 : 1,
                cursor: isEmpty ? 'not-allowed' : 'pointer',
                borderRadius: '9999px',
                border: 'none',
                background: 'none',
                transition: 'color 0.12s, background 0.12s',
                minWidth: '44px',
                minHeight: '44px'
              }}
              title="Shuffle queue"
              aria-label="Shuffle queue"
            >
              <Shuffle size={20} />
            </button>
          </>
        )}
      </div>
    </div>
  );
}
