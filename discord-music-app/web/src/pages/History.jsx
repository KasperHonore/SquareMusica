import { useState, useEffect, useCallback } from 'react';
import { useAuth } from '../context/AuthContext';
import { useSocket } from '../hooks/useSocket';
import { HistoryItem } from '../components/HistoryItem';
import { MusicNote } from '../components/icons';

/**
 * Empty state component matching Queue's empty state pattern
 */
function EmptyHistory() {
  return (
    <div className="flex-1 flex flex-col items-center justify-center py-8 animate-fade-in">
      {/* Animated music notes container */}
      <div className="relative w-24 h-24 mb-6">
        {/* Background circle */}
        <div className="absolute inset-0 rounded-full bg-accent-subtle animate-pulse-glow" />

        {/* Floating notes animation */}
        <div className="absolute inset-0 flex items-center justify-center">
          <div className="relative">
            <MusicNote size={36} className="text-accent" />
            {/* Orbiting mini notes */}
            <div className="absolute -top-2 -left-3 animate-wave">
              <MusicNote size={14} className="text-accent/60" />
            </div>
            <div className="absolute -bottom-1 -right-3 animate-wave-delay-2">
              <MusicNote size={16} className="text-accent/40" />
            </div>
          </div>
        </div>

        {/* Sound wave rings */}
        <div
          className="absolute inset-0 rounded-full border border-accent/20"
          style={{ animation: 'ring-pulse 2s ease-out infinite' }}
        />
        <div
          className="absolute inset-0 rounded-full border border-accent/10"
          style={{ animation: 'ring-pulse 2s ease-out infinite 0.5s' }}
        />
      </div>

      <p className="text-heading text-sm text-text-secondary mb-2">No listening history yet</p>
      <p className="text-body text-xs text-text-muted text-center max-w-[200px]">
        Play some tracks and they'll appear here
      </p>
    </div>
  );
}

export function History() {
  const { token } = useAuth();
  const { historyVersion } = useSocket();
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

  // Refetch when history is cleared (bot left server)
  useEffect(() => {
    if (historyVersion > 0) {
      console.log('[History] historyVersion changed to', historyVersion, '- refetching');
      fetchHistory(0, false);
    }
  }, [historyVersion, fetchHistory]);

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
      className="h-full flex-1 min-h-0 flex flex-col"
      role="region"
      aria-labelledby="history-heading"
    >
      {/* Header */}
      <div className="flex items-center justify-between mb-3 px-1">
        <div className="flex items-center gap-2">
          <h3 className="text-heading text-lg" id="history-heading">Recently Played</h3>
          {history.length > 0 && (
            <span
              className="text-mono text-xs px-2 py-0.5 rounded-full bg-accent-subtle text-accent"
              aria-label={`${history.length} tracks in history`}
            >
              {history.length}
            </span>
          )}
        </div>
      </div>

      {/* Error state */}
      {error && (
        <div className="flex-1 flex flex-col items-center justify-center py-8">
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

      {/* Empty state */}
      {!error && history.length === 0 && !loading && <EmptyHistory />}

      {/* History list */}
      {history.length > 0 && (
        <div
          className="flex-1 min-h-0 space-y-1.5 overflow-y-auto pr-1"
          style={{ scrollbarGutter: 'stable' }}
          role="list"
          aria-label="History items"
        >
          {history.map((track, index) => (
            <HistoryItem
              key={`${track.id}-${track.played_at}`}
              track={track}
              index={index}
              onPlayAgain={handlePlayAgain}
            />
          ))}

          {/* Load More button inside the list */}
          {!loading && hasMore && (
            <div className="pt-4 pb-2 text-center">
              <button
                onClick={loadMore}
                className="px-6 py-2 rounded-full text-text-secondary hover:text-text-primary transition-colors hover:bg-white/5 focus-ring min-h-[44px]"
                aria-label="Load more history items"
              >
                Load more
              </button>
            </div>
          )}
        </div>
      )}

      {/* Loading state */}
      {loading && (
        <div className="flex-1 flex items-center justify-center" role="status" aria-live="polite">
          <div className="text-center">
            <div className="inline-block w-6 h-6 border-2 border-text-muted border-t-transparent rounded-full animate-spin mb-2" aria-hidden="true" />
            <p className="text-text-muted text-sm">Loading history...</p>
          </div>
        </div>
      )}
    </div>
  );
}
