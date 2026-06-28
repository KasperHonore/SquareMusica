import { MusicNote } from './icons';

/**
 * Empty state component
 */
export function EmptyQueue({ isRightPanel }) {
  return (
    <div
      className="flex-1 min-h-0 flex flex-col items-center justify-center"
      style={{ padding: isRightPanel ? '20px 10px' : '40px 20px' }}
    >
      <div className="relative w-16 h-16 mb-4">
        <div
          className="absolute inset-0 rounded-full animate-pulse-glow"
          style={{ backgroundColor: 'var(--color-accent-subtle)' }}
        />
        <div className="absolute inset-0 flex items-center justify-center">
          <MusicNote size={28} style={{ color: 'var(--color-accent)' }} />
        </div>
      </div>
      <p style={{ fontSize: '13px', color: 'var(--color-text-secondary)', marginBottom: '4px' }}>
        Queue is empty
      </p>
      <p
        className="text-center"
        style={{ fontSize: '12px', color: 'var(--color-text-muted)', maxWidth: '200px' }}
      >
        Search for songs or use{' '}
        <code
          style={{
            color: 'rgba(232,200,122,0.8)',
            background: 'var(--color-accent-subtle)',
            padding: '1px 6px',
            borderRadius: '4px',
            fontSize: '11px'
          }}
        >
          /play
        </code>{' '}
        in Discord
      </p>
    </div>
  );
}
