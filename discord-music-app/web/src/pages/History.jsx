import { useState, useEffect, useCallback } from 'react';
import { useAuth } from '../context/AuthContext';
import { HistoryItem } from '../components/HistoryItem';

export function History({ addToQueue, historyVersion }) {
  const { token } = useAuth();
  const [history, setHistory] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [hasMore, setHasMore] = useState(true);
  const [offset, setOffset] = useState(0);
  const LIMIT = 50;

  const fetchHistory = useCallback(
    async (newOffset = 0, append = false) => {
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
          setHistory((prev) => [...prev, ...newHistory]);
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
    },
    [token]
  );

  useEffect(() => {
    fetchHistory(0, false);
  }, [fetchHistory]);

  // Refetch when history is cleared (bot left server)
  useEffect(() => {
    if (historyVersion > 0) {
      fetchHistory(0, false);
    }
  }, [historyVersion, fetchHistory]);

  const loadMore = () => {
    if (!loading && hasMore) {
      fetchHistory(offset + LIMIT, true);
    }
  };

  const handlePlayAgain = (track) => {
    addToQueue?.(track.url);
  };

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        flex: 1,
        minHeight: 0
      }}
    >
      {/* Error state */}
      {error && (
        <div
          style={{
            padding: '40px 20px',
            textAlign: 'center',
            color: 'var(--color-text-muted)',
            fontSize: '13px'
          }}
        >
          <p style={{ color: 'var(--color-danger)', marginBottom: '16px' }}>{error}</p>
          <button
            onClick={() => fetchHistory(0, false)}
            style={{
              background: 'var(--color-accent)',
              color: '#0d0d0f',
              border: 'none',
              borderRadius: '8px',
              padding: '8px 14px',
              fontSize: '13px',
              fontWeight: 500,
              cursor: 'pointer',
              fontFamily: 'var(--font-body)'
            }}
          >
            Retry
          </button>
        </div>
      )}

      {/* Empty state */}
      {!error && history.length === 0 && !loading && (
        <div
          style={{
            padding: '40px 20px',
            textAlign: 'center',
            color: 'var(--color-text-muted)',
            fontSize: '13px',
            lineHeight: 1.7
          }}
        >
          No listening history yet. Play some tracks and they will appear here.
        </div>
      )}

      {/* History list */}
      {history.length > 0 && (
        <div
          style={{
            flex: 1,
            minHeight: 0,
            overflowY: 'auto',
            scrollbarWidth: 'thin',
            scrollbarColor: 'var(--color-bg-elevated) transparent'
          }}
        >
          {history.map((track, index) => (
            <HistoryItem
              key={`${track.id}-${track.played_at}`}
              track={track}
              index={index}
              onPlayAgain={handlePlayAgain}
            />
          ))}

          {/* Load More */}
          {!loading && hasMore && (
            <div style={{ padding: '16px 0 8px', textAlign: 'center' }}>
              <button
                onClick={loadMore}
                style={{
                  background: 'none',
                  border: '1px solid var(--color-border)',
                  borderRadius: '8px',
                  padding: '8px 20px',
                  fontSize: '12px',
                  color: 'var(--color-text-secondary)',
                  cursor: 'pointer',
                  fontFamily: 'var(--font-body)',
                  transition: 'all 0.12s'
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.borderColor = 'var(--color-border-strong)';
                  e.currentTarget.style.color = 'var(--color-text-primary)';
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.borderColor = 'var(--color-border)';
                  e.currentTarget.style.color = 'var(--color-text-secondary)';
                }}
              >
                Load more
              </button>
            </div>
          )}
        </div>
      )}

      {/* Loading state */}
      {loading && (
        <div
          style={{
            padding: '40px 20px',
            textAlign: 'center'
          }}
        >
          <div
            style={{
              width: '14px',
              height: '14px',
              border: '2px solid var(--color-border)',
              borderTopColor: 'var(--color-accent)',
              borderRadius: '50%',
              animation: 'wave-hist-spin 0.7s linear infinite',
              display: 'inline-block',
              marginBottom: '8px'
            }}
          />
          <p style={{ color: 'var(--color-text-muted)', fontSize: '13px' }}>Loading history...</p>
          <style>{`@keyframes wave-hist-spin { to { transform: rotate(360deg); } }`}</style>
        </div>
      )}
    </div>
  );
}
