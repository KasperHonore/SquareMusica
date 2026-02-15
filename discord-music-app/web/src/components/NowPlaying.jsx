export function NowPlaying({ track, playerState, onControl }) {
  if (!track) {
    return (
      <div className="bg-gray-800 p-6 rounded-lg">
        <p className="text-gray-400 text-center">Nothing playing</p>
        <p className="text-gray-500 text-sm text-center mt-2">
          Use /play in Discord or add a song below
        </p>
      </div>
    );
  }

  const progress = track.duration ? (playerState.position / track.duration) * 100 : 0;

  return (
    <div className="bg-gray-800 p-6 rounded-lg">
      <div className="flex gap-4">
        {track.thumbnail && (
          <img
            src={track.thumbnail}
            alt={track.title}
            className="w-24 h-24 rounded object-cover"
          />
        )}
        <div className="flex-1 min-w-0">
          <h2 className="text-xl font-bold truncate">{track.title}</h2>
          <p className="text-gray-400 text-sm">
            Requested by {track.requestedBy}
          </p>
        </div>
      </div>

      {/* Progress bar */}
      <div className="mt-4">
        <div className="h-1 bg-gray-700 rounded overflow-hidden">
          <div
            className="h-full bg-green-500 transition-all duration-1000"
            style={{ width: `${Math.min(progress, 100)}%` }}
          />
        </div>
        <div className="flex justify-between text-sm text-gray-400 mt-1">
          <span>{formatTime(playerState.position)}</span>
          <span>{formatTime(track.duration)}</span>
        </div>
      </div>

      {/* Controls */}
      <div className="flex justify-center items-center gap-6 mt-4">
        <button
          onClick={() => onControl('previous')}
          className="text-2xl hover:text-green-400 transition-colors"
          title="Previous"
        >
          ⏮
        </button>
        <button
          onClick={() => onControl(playerState.playing ? 'pause' : 'play')}
          className="text-4xl hover:text-green-400 transition-colors"
          title={playerState.playing ? 'Pause' : 'Play'}
        >
          {playerState.playing ? '⏸' : '▶️'}
        </button>
        <button
          onClick={() => onControl('skip')}
          className="text-2xl hover:text-green-400 transition-colors"
          title="Skip"
        >
          ⏭
        </button>
      </div>
    </div>
  );
}

function formatTime(seconds) {
  if (!seconds || isNaN(seconds)) return '0:00';
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}
