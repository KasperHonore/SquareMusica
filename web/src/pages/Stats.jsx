import { useState, useEffect, useCallback } from 'react';
import { StatsLeaderboard, StatsAwards, StatsPeriodToggle } from '../components/stats';
import { PERIODS } from '../components/stats/StatsPeriodToggle';

const DEFAULT_PERIOD = 'all';

/** Human phrase for an empty state, so it names the period actually selected. */
function periodPhrase(period) {
  switch (period) {
    case 'week':
      return 'this week';
    case 'month':
      return 'this month';
    default:
      return 'yet';
  }
}

function periodLabel(period) {
  return PERIODS.find((p) => p.value === period)?.label || 'All Time';
}

/**
 * Stats - the DJ Stats page.
 *
 * Fetches the leaderboard and every award for one period in a single request, and
 * always starts on the default period: the component unmounts when the view
 * changes, so re-entering the page resets both the selection and the data rather
 * than showing a stale period.
 */
export function Stats() {
  const [period, setPeriod] = useState(DEFAULT_PERIOD);
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const fetchStats = useCallback(async (requestedPeriod) => {
    try {
      setLoading(true);
      setError(null);

      const response = await fetch(`/api/stats?period=${encodeURIComponent(requestedPeriod)}`, {
        credentials: 'include'
      });

      if (!response.ok) {
        throw new Error(
          response.status === 401
            ? 'Your session expired. Sign in again to see DJ stats.'
            : 'Failed to load DJ stats.'
        );
      }

      setData(await response.json());
    } catch (err) {
      setError(err.message);
      setData(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchStats(period);
  }, [fetchStats, period]);

  // Label from the response, not from local state: a response that arrives after
  // a further click would otherwise be labelled with the newer selection.
  const shownPeriod = data?.period || period;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '18px', minWidth: 0 }}>
      {/* Period toggle */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: '12px',
          flexWrap: 'wrap'
        }}
      >
        <StatsPeriodToggle value={period} onChange={setPeriod} disabled={loading} />
        {data?.generatedAt && !loading && !error && (
          <span style={{ fontSize: '11px', color: 'var(--color-text-muted)' }}>
            {periodLabel(shownPeriod)} · updated{' '}
            {new Date(data.generatedAt).toLocaleTimeString(undefined, {
              hour: 'numeric',
              minute: '2-digit'
            })}
          </span>
        )}
      </div>

      {/* Error state with retry */}
      {error && (
        <div
          style={{
            padding: '32px 20px',
            textAlign: 'center',
            color: 'var(--color-text-muted)',
            fontSize: '13px'
          }}
        >
          <p style={{ color: 'var(--color-danger)', marginBottom: '16px' }}>{error}</p>
          <button
            onClick={() => fetchStats(period)}
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

      {/* Loading state */}
      {loading && !error && (
        <div style={{ padding: '40px 20px', textAlign: 'center' }}>
          <div
            style={{
              width: '14px',
              height: '14px',
              border: '2px solid var(--color-border)',
              borderTopColor: 'var(--color-accent)',
              borderRadius: '50%',
              animation: 'wave-stats-spin 0.7s linear infinite',
              display: 'inline-block',
              marginBottom: '8px'
            }}
          />
          <p style={{ color: 'var(--color-text-muted)', fontSize: '13px' }}>Loading DJ stats...</p>
          <style>{`@keyframes wave-stats-spin { to { transform: rotate(360deg); } }`}</style>
        </div>
      )}

      {/* Content */}
      {!loading && !error && data && (
        <>
          <section style={{ minWidth: 0 }}>
            <SectionHeading>Top DJs</SectionHeading>
            <StatsLeaderboard
              leaderboard={data.leaderboard}
              selfEntry={data.selfEntry}
              truncated={data.leaderboardTruncated}
              periodPhrase={periodPhrase(shownPeriod)}
            />
          </section>

          <section style={{ minWidth: 0 }}>
            <SectionHeading>Awards</SectionHeading>
            <StatsAwards awards={data.awards} />
          </section>
        </>
      )}
    </div>
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
