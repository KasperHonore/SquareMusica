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
    <div
      className="flex items-center gap-4 p-4 rounded-lg transition-colors hover:bg-white/5"
      style={{ backgroundColor: 'var(--color-bg-elevated)' }}
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
        className="p-2 rounded-full transition-colors hover:bg-accent/20 text-accent"
        title="Play again"
        aria-label={`Play ${track.title} again`}
      >
        <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 24 24">
          <path d="M8 5v14l11-7z"/>
        </svg>
      </button>
    </div>
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
    >
      <div className="max-w-4xl mx-auto px-4 py-8">
        {/* Page Header */}
        <div className="mb-8">
          <h1 className="text-2xl font-bold mb-2">Recently Played</h1>
          <p style={{ color: 'var(--color-text-secondary)' }}>
            Your listening history
          </p>
        </div>

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
                className="px-4 py-2 bg-accent hover:bg-accent-hover text-white rounded-lg transition-colors"
              >
                Retry
              </button>
            </div>
          )}

          {!error && history.length === 0 && !loading && (
            <div className="p-12 text-center" style={{ color: 'var(--color-text-muted)' }}>
              <svg className="w-16 h-16 mx-auto mb-4 opacity-50" fill="currentColor" viewBox="0 0 24 24">
                <path d="M12 3v10.55c-.59-.34-1.27-.55-2-.55-2.21 0-4 1.79-4 4s1.79 4 4 4 4-1.79 4-4V7h4V3h-6z"/>
              </svg>
              <p className="text-lg font-medium mb-2">No history yet</p>
              <p>Tracks you play will appear here</p>
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
            <div className="p-8 text-center" style={{ color: 'var(--color-text-muted)' }}>
              <div className="inline-block w-6 h-6 border-2 border-current border-t-transparent rounded-full animate-spin mb-2" />
              <p>Loading history...</p>
            </div>
          )}

          {/* Load More */}
          {!loading && hasMore && history.length > 0 && (
            <div className="p-4 text-center" style={{ borderTop: '1px solid var(--color-border)' }}>
              <button
                onClick={loadMore}
                className="px-6 py-2 rounded-full transition-colors hover:bg-white/5"
                style={{ color: 'var(--color-text-secondary)' }}
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
