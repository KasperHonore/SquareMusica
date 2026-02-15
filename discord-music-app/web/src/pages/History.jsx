import { useState, useEffect, useCallback } from 'react';
import { useAuth } from '../context/AuthContext';
import { formatTime } from '../utils/formatTime';

/**
 * Format a timestamp into a relative or absolute time string
 * @param {string} timestamp - ISO timestamp
 * @returns {string} Formatted time string
 */
function formatPlayedAt(timestamp) {
  const date = new Date(timestamp);
  const now = new Date();
  const diffMs = now - date;
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMs / 3600000);
  const diffDays = Math.floor(diffMs / 86400000);

  if (diffMins < 1) return 'Just now';
  if (diffMins < 60) return `${diffMins}m ago`;
  if (diffHours < 24) return `${diffHours}h ago`;
  if (diffDays < 7) return `${diffDays}d ago`;

  return date.toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit'
  });
}

/**
 * HistoryItem component for displaying a single history entry
 */
function HistoryItem({ track, onPlayAgain }) {
  return (
    <article
      className="flex items-center gap-4 p-4 rounded-lg transition-colors hover:bg-white/5"
      style={{ backgroundColor: 'var(--color-bg-elevated)' }}
      aria-label={`${track.title}, played ${formatPlayedAt(track.played_at)}`}
    >
      {/* Thumbnail */}
      {track.thumbnail ? (
        <img
          src={track.thumbnail}
          alt=""
          className="w-14 h-14 rounded-lg object-cover flex-shrink-0"
        />
      ) : (
        <div
          className="w-14 h-14 rounded-lg flex items-center justify-center flex-shrink-0"
          style={{ backgroundColor: 'var(--color-bg-raised)' }}
        >
          <svg className="w-6 h-6" style={{ color: 'var(--color-text-muted)' }} fill="currentColor" viewBox="0 0 24 24">
            <path d="M12 3v10.55c-.59-.34-1.27-.55-2-.55-2.21 0-4 1.79-4 4s1.79 4 4 4 4-1.79 4-4V7h4V3h-6z"/>
          </svg>
        </div>
      )}

      {/* Track Info */}
      <div className="flex-1 min-w-0">
        <p className="font-medium truncate">{track.title}</p>
        <div className="flex items-center gap-2 text-sm" style={{ color: 'var(--color-text-secondary)' }}>
          <span>{formatTime(track.duration, '--:--')}</span>
          <span>-</span>
          <span className="truncate">Requested by {track.requested_by}</span>
        </div>
      </div>

      {/* Played At */}
      <div className="text-sm text-right flex-shrink-0" style={{ color: 'var(--color-text-muted)' }}>
        {formatPlayedAt(track.played_at)}
      </div>

      {/* Play Again Button */}
      <button
        onClick={() => onPlayAgain(track)}
        className="p-2 rounded-full transition-colors hover:bg-accent/20 text-accent focus-ring min-w-[44px] min-h-[44px] flex items-center justify-center"
        title="Play again"
        aria-label={`Play ${track.title} again`}
      >
        <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 24 24" aria-hidden="true">
          <path d="M8 5v14l11-7z"/>
        </svg>
      </button>
    </article>
  );
}

export function History() {
  const { token } = useAuth();
  const [history, setHistory] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [hasMore, setHasMore] = useState(true);
  const [offset, setOffset] = useState(0);
  const LIMIT = 50;

  const fetchHistory = useCallback(async (newOffset = 0, append = false) => {
    if (!token) return;

    try {
      setLoading(true);
      setError(null);

      const response = await fetch(`/api/queue/history?limit=${LIMIT}&offset=${newOffset}`, {
        headers: {
          Authorization: `Bearer ${token}`
        }
      });

      if (!response.ok) {
        throw new Error('Failed to fetch history');
      }

      const data = await response.json();
      const newHistory = data.history || [];

      if (append) {
        setHistory(prev => [...prev, ...newHistory]);
      } else {
        setHistory(newHistory);
      }

      setHasMore(newHistory.length === LIMIT);
      setOffset(newOffset);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [token]);

  useEffect(() => {
    fetchHistory(0, false);
  }, [fetchHistory]);

  const loadMore = () => {
    if (!loading && hasMore) {
      fetchHistory(offset + LIMIT, true);
    }
  };

  const handlePlayAgain = async (track) => {
    if (!token) return;

    try {
      const response = await fetch('/api/queue/add', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`
        },
        body: JSON.stringify({ url: track.url })
      });

      if (!response.ok) {
        throw new Error('Failed to add track');
      }
    } catch (err) {
      console.error('Failed to play again:', err);
    }
  };

  return (
    <div
      className="min-h-screen transition-colors duration-200"
      style={{ backgroundColor: 'var(--color-bg)', color: 'var(--color-text-primary)' }}
      role="main"
      aria-label="Listening history"
    >
      <div className="max-w-4xl mx-auto px-4 py-8">
        {/* Page Header */}
        <header className="mb-8">
          <h1 className="text-2xl font-bold mb-2">Recently Played</h1>
          <p style={{ color: 'var(--color-text-secondary)' }}>
            Your listening history
          </p>
        </header>

        {/* History List */}
        <div
          className="rounded-xl shadow-soft overflow-hidden"
          style={{
            backgroundColor: 'var(--color-bg-raised)',
            border: '1px solid var(--color-border)'
          }}
        >
          {error && (
            <div className="p-6 text-center">
              <p className="text-red-400 mb-4">{error}</p>
              <button
                onClick={() => fetchHistory(0, false)}
                className="px-4 py-2 bg-accent hover:bg-accent-hover text-white rounded-lg transition-colors focus-ring min-h-[44px]"
                aria-label="Retry loading history"
              >
                Retry
              </button>
            </div>
          )}

          {!error && history.length === 0 && !loading && (
            <div className="relative p-16 text-center overflow-hidden">
              {/* Animated background gradient orbs */}
              <div
                className="absolute inset-0 opacity-30"
                style={{
                  background: 'radial-gradient(circle at 30% 20%, var(--color-accent-muted) 0%, transparent 50%), radial-gradient(circle at 70% 80%, rgba(139, 92, 246, 0.1) 0%, transparent 50%)',
                  animation: 'pulse-subtle 8s ease-in-out infinite',
                }}
              />

              {/* Vinyl record illustration */}
              <div className="relative mx-auto mb-8 w-32 h-32">
                {/* Outer ring with grooves */}
                <div
                  className="absolute inset-0 rounded-full"
                  style={{
                    background: 'conic-gradient(from 0deg, var(--color-bg-elevated), var(--color-bg-raised), var(--color-bg-elevated), var(--color-bg-raised), var(--color-bg-elevated))',
                    boxShadow: 'inset 0 0 20px rgba(0,0,0,0.5), 0 4px 20px rgba(0,0,0,0.3)',
                    animation: 'spin-slow 20s linear infinite',
                  }}
                />

                {/* Inner grooves */}
                <div
                  className="absolute rounded-full"
                  style={{
                    top: '15%',
                    left: '15%',
                    right: '15%',
                    bottom: '15%',
                    background: 'repeating-radial-gradient(circle at center, transparent 0px, transparent 2px, rgba(255,255,255,0.03) 2px, rgba(255,255,255,0.03) 4px)',
                    animation: 'spin-slow 20s linear infinite',
                  }}
                />

                {/* Label center */}
                <div
                  className="absolute rounded-full flex items-center justify-center"
                  style={{
                    top: '30%',
                    left: '30%',
                    right: '30%',
                    bottom: '30%',
                    background: 'linear-gradient(135deg, var(--color-accent) 0%, #15803d 100%)',
                    boxShadow: 'inset 0 2px 4px rgba(255,255,255,0.2), 0 2px 8px rgba(0,0,0,0.3)',
                  }}
                >
                  {/* Center hole */}
                  <div
                    className="w-3 h-3 rounded-full"
                    style={{ backgroundColor: 'var(--color-bg)' }}
                  />
                </div>

                {/* Floating music notes */}
                <div
                  className="absolute -right-2 -top-2"
                  style={{
                    color: 'var(--color-accent)',
                    opacity: 0.6,
                    animation: 'float-note 3s ease-in-out infinite',
                  }}
                >
                  <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 24 24">
                    <path d="M12 3v10.55c-.59-.34-1.27-.55-2-.55-2.21 0-4 1.79-4 4s1.79 4 4 4 4-1.79 4-4V7h4V3h-6z"/>
                  </svg>
                </div>
                <div
                  className="absolute -left-3 top-1/4"
                  style={{
                    color: 'var(--color-text-muted)',
                    opacity: 0.4,
                    animation: 'float-note 3s ease-in-out infinite 1s',
                  }}
                >
                  <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 24 24">
                    <path d="M12 3v10.55c-.59-.34-1.27-.55-2-.55-2.21 0-4 1.79-4 4s1.79 4 4 4 4-1.79 4-4V7h4V3h-6z"/>
                  </svg>
                </div>
              </div>

              {/* Copy with personality */}
              <div className="relative z-10">
                <h3
                  className="text-xl font-bold mb-3"
                  style={{
                    fontFamily: 'var(--font-heading)',
                    color: 'var(--color-text-primary)',
                  }}
                >
                  Your musical journey starts here
                </h3>
                <p
                  className="text-base mb-2 max-w-xs mx-auto"
                  style={{ color: 'var(--color-text-secondary)' }}
                >
                  Every track you play becomes part of your story.
                </p>
                <p
                  className="text-sm"
                  style={{ color: 'var(--color-text-muted)' }}
                >
                  Go play something
                  <span
                    className="inline-block ml-1"
                    style={{ animation: 'bounce-gentle 1.5s ease-in-out infinite' }}
                  >
                    and make some memories.
                  </span>
                </p>
              </div>

              {/* Decorative timeline dots */}
              <div className="flex justify-center gap-2 mt-8">
                {[0, 1, 2, 3, 4].map((i) => (
                  <div
                    key={i}
                    className="rounded-full"
                    style={{
                      width: '6px',
                      height: '6px',
                      backgroundColor: i === 2 ? 'var(--color-accent)' : 'var(--color-bg-elevated)',
                      opacity: i === 2 ? 1 : 0.5,
                      animation: `pulse-dot 2s ease-in-out infinite ${i * 0.2}s`,
                    }}
                  />
                ))}
              </div>

              {/* Inline keyframes */}
              <style>{`
                @keyframes spin-slow {
                  from { transform: rotate(0deg); }
                  to { transform: rotate(360deg); }
                }
                @keyframes float-note {
                  0%, 100% { transform: translateY(0) rotate(0deg); }
                  50% { transform: translateY(-8px) rotate(10deg); }
                }
                @keyframes pulse-subtle {
                  0%, 100% { opacity: 0.2; }
                  50% { opacity: 0.35; }
                }
                @keyframes bounce-gentle {
                  0%, 100% { transform: translateY(0); }
                  50% { transform: translateY(-2px); }
                }
                @keyframes pulse-dot {
                  0%, 100% { transform: scale(1); opacity: 0.5; }
                  50% { transform: scale(1.2); opacity: 0.8; }
                }
              `}</style>
            </div>
          )}

          {history.length > 0 && (
            <div className="divide-y" style={{ borderColor: 'var(--color-border)' }}>
              {history.map((track) => (
                <HistoryItem
                  key={`${track.id}-${track.played_at}`}
                  track={track}
                  onPlayAgain={handlePlayAgain}
                />
              ))}
            </div>
          )}

          {/* Loading State */}
          {loading && (
            <div className="p-8 text-center" style={{ color: 'var(--color-text-muted)' }} role="status" aria-live="polite">
              <div className="inline-block w-6 h-6 border-2 border-current border-t-transparent rounded-full animate-spin mb-2" aria-hidden="true" />
              <p>Loading history...</p>
            </div>
          )}

          {/* Load More */}
          {!loading && hasMore && history.length > 0 && (
            <div className="p-4 text-center" style={{ borderTop: '1px solid var(--color-border)' }}>
              <button
                onClick={loadMore}
                className="px-6 py-2 rounded-full transition-colors hover:bg-white/5 focus-ring min-h-[44px]"
                style={{ color: 'var(--color-text-secondary)' }}
                aria-label="Load more history items"
              >
                Load more
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
