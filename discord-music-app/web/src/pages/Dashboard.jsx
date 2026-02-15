import { useSocket } from '../hooks/useSocket';
import { useAuth } from '../context/AuthContext';
import { NowPlaying } from '../components/NowPlaying';
import { Queue } from '../components/Queue';
import { SearchBar } from '../components/SearchBar';
import { VolumeSlider } from '../components/VolumeSlider';

export function Dashboard() {
  const { user, logout } = useAuth();
  const {
    connected,
    queue,
    currentTrack,
    playerState,
    addToQueue,
    removeFromQueue,
    reorderQueue,
    playerControl
  } = useSocket();

  const currentIndex = currentTrack
    ? queue.findIndex(t => t.url === currentTrack.url)
    : -1;

  return (
    <div className="min-h-screen bg-gray-900 text-white">
      {/* Header */}
      <header className="bg-gray-800 border-b border-gray-700">
        <div className="max-w-6xl mx-auto px-4 py-4 flex justify-between items-center">
          <h1 className="text-xl font-bold flex items-center gap-2">
            🎵 Music Bot
          </h1>
          <div className="flex items-center gap-4">
            <span className={`flex items-center gap-2 text-sm ${connected ? 'text-green-400' : 'text-red-400'}`}>
              <span className={`w-2 h-2 rounded-full ${connected ? 'bg-green-400' : 'bg-red-400'}`}></span>
              {connected ? 'Connected' : 'Disconnected'}
            </span>
            {user && (
              <div className="flex items-center gap-3">
                {user.avatar && (
                  <img
                    src={`https://cdn.discordapp.com/avatars/${user.discord_id}/${user.avatar}.png`}
                    alt={user.username}
                    className="w-8 h-8 rounded-full"
                  />
                )}
                <span className="text-gray-300">{user.username}</span>
                <button
                  onClick={logout}
                  className="text-gray-400 hover:text-white transition-colors"
                >
                  Logout
                </button>
              </div>
            )}
          </div>
        </div>
      </header>

      {/* Main Content */}
      <main className="max-w-6xl mx-auto px-4 py-6">
        {!playerState.connected && (
          <div className="bg-yellow-900/30 border border-yellow-500/50 text-yellow-200 px-4 py-3 rounded-lg mb-6">
            Bot is not connected to a voice channel. Use <code className="bg-gray-800 px-1 rounded">/join</code> in Discord.
          </div>
        )}

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          {/* Left Column - Player */}
          <div className="lg:col-span-2 space-y-4">
            <SearchBar
              onAdd={addToQueue}
              disabled={!connected}
            />
            <NowPlaying
              track={currentTrack}
              playerState={playerState}
              onControl={playerControl}
            />
            <VolumeSlider
              value={playerState.volume}
              onChange={(v) => playerControl('volume', v)}
            />

            {/* Loop Control */}
            <div className="bg-gray-800 p-4 rounded-lg">
              <div className="flex items-center gap-4">
                <span className="text-gray-400">Loop:</span>
                <div className="flex gap-2">
                  {['off', 'track', 'queue'].map((mode) => (
                    <button
                      key={mode}
                      onClick={() => playerControl('loop', mode)}
                      className={`px-3 py-1 rounded ${
                        playerState.loop === mode
                          ? 'bg-green-600 text-white'
                          : 'bg-gray-700 text-gray-300 hover:bg-gray-600'
                      } transition-colors`}
                    >
                      {mode.charAt(0).toUpperCase() + mode.slice(1)}
                    </button>
                  ))}
                </div>
              </div>
            </div>
          </div>

          {/* Right Column - Queue */}
          <div>
            <Queue
              tracks={queue}
              currentIndex={currentIndex}
              onReorder={reorderQueue}
              onRemove={removeFromQueue}
            />
          </div>
        </div>
      </main>
    </div>
  );
}
