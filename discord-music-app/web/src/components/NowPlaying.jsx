import { formatTime } from '../utils/formatTime';
import { Play, Pause, SkipNext, SkipPrevious, Shuffle, Loop, MusicNote } from './icons/index.jsx';
import { PlaybackIndicator } from './PlaybackIndicator';

export function NowPlaying({ track, playerState, onControl }) {
  if (!track) {
    return (
      <div className="flex flex-col items-center justify-center py-16 px-8">
        <div className="w-64 h-64 bg-surface-elevated rounded-xl flex items-center justify-center mb-8">
          <MusicNote size={80} className="text-gray-600" />
        </div>
        <h2 className="text-2xl font-bold text-white mb-2">Nothing playing</h2>
        <p className="text-gray-400 text-center max-w-md">
          Use /play in Discord or search for a song to get started
        </p>
      </div>
    );
  }

  const progress = track.duration ? (playerState.position / track.duration) * 100 : 0;

  const getAvatarUrl = () => {
    if (!track.requestedById || !track.requestedByAvatar) return null;
    return `https://cdn.discordapp.com/avatars/${track.requestedById}/${track.requestedByAvatar}.png`;
  };

  const avatarUrl = getAvatarUrl();

  return (
    <div className="flex flex-col items-center py-8 px-4">
      {/* Album Art */}
      <div className="relative mb-8">
        {track.thumbnail ? (
          <img
            src={track.thumbnail}
            alt={track.title}
            className="w-80 h-80 rounded-xl object-cover shadow-soft"
          />
        ) : (
          <div className="w-80 h-80 bg-surface-elevated rounded-xl flex items-center justify-center shadow-soft">
            <MusicNote size={80} className="text-gray-600" />
          </div>
        )}
        {/* Playback indicator overlay */}
        {playerState.playing && (
          <div className="absolute bottom-4 right-4 bg-black/60 rounded-lg p-2">
            <PlaybackIndicator playing={true} size="lg" className="text-accent" />
          </div>
        )}
      </div>

      {/* Track info */}
      <div className="text-center mb-6 max-w-md">
        <h2 className="text-2xl font-bold text-white mb-2 line-clamp-2">
          {track.title}
        </h2>
        {track.artist && (
          <p className="text-gray-400 text-lg mb-3">{track.artist}</p>
        )}
        {/* Requested by */}
        <div className="flex items-center justify-center gap-2 text-sm text-gray-500">
          <span>Requested by</span>
          {avatarUrl ? (
            <img
              src={avatarUrl}
              alt={track.requestedBy}
              className="w-5 h-5 rounded-full"
            />
          ) : (
            <div className="w-5 h-5 rounded-full bg-surface-elevated flex items-center justify-center text-xs">
              {track.requestedBy?.charAt(0) || '?'}
            </div>
          )}
          <span className="text-gray-400">{track.requestedBy}</span>
        </div>
      </div>

      {/* Progress bar */}
      <div className="w-full max-w-md mb-6">
        <input
          type="range"
          min="0"
          max="100"
          value={progress}
          readOnly
          className="w-full h-1 bg-surface-elevated rounded-full appearance-none cursor-pointer
            [&::-webkit-slider-thumb]:appearance-none
            [&::-webkit-slider-thumb]:w-3
            [&::-webkit-slider-thumb]:h-3
            [&::-webkit-slider-thumb]:rounded-full
            [&::-webkit-slider-thumb]:bg-white
            [&::-webkit-slider-thumb]:opacity-0
            [&::-webkit-slider-thumb]:hover:opacity-100
            [&::-webkit-slider-thumb]:transition-opacity
            [&::-moz-range-thumb]:w-3
            [&::-moz-range-thumb]:h-3
            [&::-moz-range-thumb]:rounded-full
            [&::-moz-range-thumb]:bg-white
            [&::-moz-range-thumb]:border-0
            [&::-moz-range-thumb]:opacity-0
            [&::-moz-range-thumb]:hover:opacity-100
            [&::-moz-range-thumb]:transition-opacity"
          style={{
            background: `linear-gradient(to right, #1DB954 ${progress}%, #282828 ${progress}%)`,
          }}
        />
        <div className="flex justify-between text-xs text-gray-500 mt-2">
          <span>{formatTime(playerState.position)}</span>
          <span>{formatTime(track.duration)}</span>
        </div>
      </div>

      {/* Playback controls */}
      <div className="flex items-center justify-center gap-4">
        {/* Shuffle */}
        <button
          onClick={() => onControl('shuffle')}
          className="p-2 text-gray-400 hover:text-white transition-colors"
          title="Shuffle"
          aria-label="Shuffle queue"
        >
          <Shuffle size={20} />
        </button>

        {/* Previous */}
        <button
          onClick={() => onControl('previous')}
          className="p-2 text-gray-400 hover:text-white transition-colors"
          title="Previous"
          aria-label="Previous track"
        >
          <SkipPrevious size={28} />
        </button>

        {/* Play/Pause */}
        <button
          onClick={() => onControl(playerState.playing ? 'pause' : 'play')}
          className="w-14 h-14 bg-white rounded-full flex items-center justify-center text-black hover:scale-105 transition-transform shadow-soft"
          title={playerState.playing ? 'Pause' : 'Play'}
          aria-label={playerState.playing ? 'Pause' : 'Play'}
        >
          {playerState.playing ? (
            <Pause size={28} />
          ) : (
            <Play size={28} className="ml-1" />
          )}
        </button>

        {/* Next */}
        <button
          onClick={() => onControl('skip')}
          className="p-2 text-gray-400 hover:text-white transition-colors"
          title="Next"
          aria-label="Skip to next track"
        >
          <SkipNext size={28} />
        </button>

        {/* Loop */}
        <button
          onClick={() => onControl('loop')}
          className={`p-2 transition-colors ${
            playerState.loop && playerState.loop !== 'off'
              ? 'text-accent'
              : 'text-gray-400 hover:text-white'
          }`}
          title="Loop"
          aria-label="Toggle loop mode"
        >
          <Loop size={20} mode={playerState.loop || 'off'} />
        </button>
      </div>
    </div>
  );
}
