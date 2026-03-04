import { NowPlayingCompact } from './NowPlayingCompact';
import { Queue } from '../Queue';

/**
 * RightPanel - Container for Now Playing and Queue
 *
 * Always visible in the right column. Never changes based on center panel nav.
 * Playback controls live in the bottom bar (MiniPlayer).
 */
export function RightPanel({
  currentTrack,
  playerState,
  onControl,
  queue,
  onReorder,
  onRemove,
  onShuffle,
  onClear,
  resolutionStats,
}) {
  return (
    <div
      className="flex flex-col h-full overflow-hidden"
      style={{ backgroundColor: 'var(--color-bg-raised)' }}
    >
      {/* Now Playing section */}
      <NowPlayingCompact
        currentTrack={currentTrack}
        playerState={playerState}
        onControl={onControl}
      />

      {/* Queue section - fills remaining space */}
      <div
        className="flex-1 flex flex-col min-h-0 overflow-hidden"
        style={{
          borderTop: '1px solid var(--color-border)',
          marginTop: '10px',
        }}
      >
        <Queue
          tracks={queue}
          onReorder={onReorder}
          onRemove={onRemove}
          onShuffle={onShuffle}
          onClear={onClear}
          resolutionStats={resolutionStats}
          isRightPanel
        />
      </div>
    </div>
  );
}
