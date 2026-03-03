import { musicManager } from '../state/musicManager.js';
import { getConnection, isConnected, joinChannel, leaveChannel, setChannelCache } from '../bot/voiceManager.js';
import { resolveQuery, enrichWithUserInfo, triggerLookaheadIfNeeded, tryPlayWithFallback } from '../music/trackResolver.js';
import { resolutionManager } from '../music/resolutionManager.js';
import { client } from '../bot/client.js';

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
      const userInfo = {
        username: socket.user?.username || 'Web User',
        id: socket.user?.discord_id || null,
        avatar: socket.user?.avatar || null
      };

      // Resolve query to tracks
      const { tracks: rawTracks, error } = await resolveQuery(query, userInfo);

      if (error) {
        const errorMap = {
          SPOTIFY_PLAYLIST_EMPTY: 'Spotify playlist not found or empty',
          SPOTIFY_TRACK_NOT_FOUND: 'Spotify track not found',
          SPOTIFY_ALBUM_EMPTY: 'Spotify album not found or empty',
          PLAYLIST_EMPTY: 'Playlist not found or empty',
          VIDEO_NOT_FOUND: 'Video not found',
          NO_RESULTS: 'No results found'
        };
        socket.emit('error', { message: errorMap[error] || 'Failed to process query' });
        return;
      }

      // Add user info to tracks
      let tracks = enrichWithUserInfo(rawTracks, userInfo);

      // Add to queue
      tracks.forEach(track => musicManager.addToQueue(track));

      // Trigger lookahead resolution if needed
      triggerLookaheadIfNeeded(
        tracks, resolutionManager, musicManager.queue, musicManager.getCurrentIndex()
      );

      // Auto-play if not playing
      const player = musicManager.player;
      const queue = musicManager.queue;

      if (player && queue && !player.isPlaying() && !player.isPaused()) {
        const connection = getConnection(musicManager.guildId);
        const { played } = await tryPlayWithFallback(player, queue, connection);
        if (!played && queue.length > 0) {
          musicManager.emit('track:change', null);
          musicManager.emitState();
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
        case 'loop':
          if (value) {
            musicManager.setLoop(value);
          }
          break;
        case 'shuffle':
          musicManager.shuffleQueue();
          break;
        case 'clear':
          musicManager.clearUpcomingQueue();
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
                const success = await player.play(prev, connection);
                if (!success) {
                  musicManager.emit('track:change', null);
                  musicManager.emitState();
                }
              }
            }
            musicManager.emitQueueUpdate();
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

/**
 * Handle voice join requests from web clients
 * Joins the bot to the user's current voice channel in Discord
 * Searches across all guilds the bot is in to find the user's voice channel
 * @param {Socket} socket - Socket.io socket instance
 * @returns {Function} Event handler
 */
export function handleVoiceJoin(socket) {
  return async () => {
    try {
      const discordId = socket.user.discord_id;

      // Search all guilds the bot is in to find user's voice channel
      let voiceChannel = null;
      for (const [guildId, guild] of client.guilds.cache) {
        try {
          const member = await guild.members.fetch(discordId);
          if (member.voice?.channel) {
            voiceChannel = member.voice.channel;
            break;
          }
        } catch {
          // User not in this guild, continue searching
        }
      }

      if (!voiceChannel) {
        socket.emit('error', { message: 'You need to be in a voice channel in Discord!' });
        return;
      }

      await joinChannel(voiceChannel);
      musicManager.setGuildId(voiceChannel.guild.id);
      setChannelCache(voiceChannel.guild.id, voiceChannel);
      musicManager.emitVoiceContext();
      musicManager.emitState();
    } catch (err) {
      console.error('Voice join error:', err);
      socket.emit('error', { message: err.message || 'Failed to join voice channel' });
    }
  };
}

/**
 * Handle voice leave requests from web clients
 * Disconnects the bot from the voice channel
 * @param {Socket} socket - Socket.io socket instance
 * @returns {Function} Event handler
 */
export function handleVoiceLeave(socket) {
  return async () => {
    try {
      const guildId = musicManager.guildId || process.env.GUILD_ID;
      leaveChannel(guildId);
      setChannelCache(guildId, null);
      musicManager.stop();
      musicManager.emitVoiceContext();
      musicManager.emitState();
    } catch (err) {
      console.error('Voice leave error:', err);
      socket.emit('error', { message: err.message || 'Failed to leave voice channel' });
    }
  };
}
