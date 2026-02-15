import { musicManager } from '../state/musicManager.js';
import { search, getInfo, isValidUrl, isPlaylist, getPlaylist } from '../music/youtube.js';
import { getConnection, isConnected } from '../bot/voiceManager.js';
import { parseSpotifyUrl, getPublicTrack, getPublicPlaylistTracks } from '../music/spotify.js';
import { resolveSpotifyTrack } from '../music/resolver.js';
import { resolutionManager, ResolutionManager } from '../music/resolutionManager.js';

/**
 * Check if bot is connected to voice channel
 * @param {Socket} socket - Socket.io socket instance
 * @returns {boolean} True if connected, false otherwise (and emits error)
 */
function checkVoiceConnection(socket) {
  const guildId = musicManager.guildId || process.env.GUILD_ID;
  if (!isConnected(guildId)) {
    socket.emit('error', { message: 'Bot is not in a voice channel. Use /join in Discord first.' });
    return false;
  }
  return true;
}

/**
 * Handle queue add requests from web clients
 * @param {Socket} socket - Socket.io socket instance
 * @returns {Function} Event handler
 */
export function handleQueueAdd(socket) {
  return async ({ query }) => {
    if (!checkVoiceConnection(socket)) return;

    try {
      let tracks = [];
      const requestedBy = socket.user?.username || 'Web User';

      // Check for Spotify URL first
      const spotifyParsed = parseSpotifyUrl(query);

      if (spotifyParsed.type === 'playlist') {
        // Handle Spotify playlist - add tracks with lazy resolution
        const spotifyTracks = await getPublicPlaylistTracks(spotifyParsed.id);
        if (spotifyTracks.length === 0) {
          socket.emit('error', { message: 'Spotify playlist not found or empty' });
          return;
        }

        // Convert to unresolved queue tracks (lazy resolution)
        tracks = spotifyTracks.map(st =>
          ResolutionManager.createUnresolvedTrack(st, requestedBy)
        );
      } else if (spotifyParsed.type === 'track') {
        // Handle Spotify track - resolve immediately
        const spotifyTrack = await getPublicTrack(spotifyParsed.id);
        if (!spotifyTrack) {
          socket.emit('error', { message: 'Spotify track not found' });
          return;
        }

        const youtubeTrack = await resolveSpotifyTrack(spotifyTrack);
        if (!youtubeTrack) {
          socket.emit('error', { message: `Could not find "${spotifyTrack.title}" on YouTube` });
          return;
        }
        tracks = [youtubeTrack];
      } else if (isPlaylist(query)) {
        // Handle YouTube playlist
        tracks = await getPlaylist(query);
        if (tracks.length === 0) {
          socket.emit('error', { message: 'Playlist not found or empty' });
          return;
        }
      } else if (isValidUrl(query)) {
        // Handle direct YouTube URL
        const track = await getInfo(query);
        if (!track) {
          socket.emit('error', { message: 'Video not found' });
          return;
        }
        tracks = [track];
      } else {
        // Search YouTube
        const results = await search(query, 1);
        if (results.length === 0) {
          socket.emit('error', { message: 'No results found' });
          return;
        }
        tracks = [results[0]];
      }

      // Add requestedBy to all tracks
      tracks = tracks.map(track => ({
        ...track,
        requestedBy
      }));

      // Add to queue
      tracks.forEach(track => musicManager.addToQueue(track));

      // Trigger lookahead resolution for Spotify playlists (non-blocking)
      const hasUnresolvedTracks = tracks.some(t => t.status === 'unresolved');
      if (hasUnresolvedTracks && musicManager.queue) {
        resolutionManager.setQueue(musicManager.queue);
        resolutionManager.start();
        resolutionManager.processLookahead(musicManager.getCurrentIndex()).catch(err => {
          console.error('Lookahead resolution error:', err);
        });
      }

      // Auto-play if not playing
      const player = musicManager.player;
      const queue = musicManager.queue;

      if (player && queue && !player.isPlaying() && !player.isPaused()) {
        const connection = getConnection(musicManager.guildId);
        if (connection) {
          const current = queue.getCurrent();
          if (current) {
            const success = await player.play(current, connection);
            // If first track failed to resolve, try next tracks
            if (!success) {
              let nextTrack = queue.next();
              while (nextTrack) {
                const nextSuccess = await player.play(nextTrack, connection);
                if (nextSuccess) break;
                nextTrack = queue.next();
              }
            }
          }
        }
      }
    } catch (err) {
      console.error('Queue add error:', err);
      socket.emit('error', { message: err.message });
    }
  };
}

/**
 * Handle queue remove requests from web clients
 * @param {Socket} socket - Socket.io socket instance
 * @returns {Function} Event handler
 */
export function handleQueueRemove(socket) {
  return ({ position }) => {
    if (!checkVoiceConnection(socket)) return;

    try {
      musicManager.removeFromQueue(position);
    } catch (err) {
      socket.emit('error', { message: err.message });
    }
  };
}

/**
 * Handle queue reorder requests from web clients
 * @param {Socket} socket - Socket.io socket instance
 * @returns {Function} Event handler
 */
export function handleQueueReorder(socket) {
  return ({ from, to }) => {
    if (!checkVoiceConnection(socket)) return;

    try {
      musicManager.reorderQueue(from, to);
    } catch (err) {
      socket.emit('error', { message: err.message });
    }
  };
}

/**
 * Handle player control requests from web clients
 * @param {Socket} socket - Socket.io socket instance
 * @returns {Function} Event handler
 */
export function handlePlayerControl(socket) {
  return async ({ action, value }) => {
    if (!checkVoiceConnection(socket)) return;

    try {
      switch (action) {
        case 'play':
          musicManager.play();
          break;
        case 'pause':
          musicManager.pause();
          break;
        case 'skip':
          musicManager.skip();
          break;
        case 'stop':
          musicManager.stop();
          break;
        case 'volume':
          if (typeof value === 'number') {
            musicManager.setVolume(value);
          }
          break;
        case 'loop':
          if (value) {
            musicManager.setLoop(value);
          }
          break;
        case 'shuffle':
          musicManager.shuffleQueue();
          break;
        case 'previous':
          // Handle previous track
          const queue = musicManager.queue;
          const player = musicManager.player;
          if (queue && player) {
            const prev = queue.previous();
            if (prev) {
              const connection = getConnection(musicManager.guildId);
              if (connection) {
                await player.play(prev, connection);
              }
            }
          }
          break;
        default:
          socket.emit('error', { message: 'Unknown action' });
      }
    } catch (err) {
      console.error('Player control error:', err);
      socket.emit('error', { message: err.message });
    }
  };
}
