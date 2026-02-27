import { musicManager } from '../state/musicManager.js';
import { search, getInfo, isValidUrl, isPlaylist, getPlaylist } from '../music/youtube.js';
import { getConnection, isConnected, joinChannel, leaveChannel, setChannelCache } from '../bot/voiceManager.js';
import { parseSpotifyUrl, getPublicTrack, getPublicPlaylistTracks, getPublicAlbumTracks } from '../music/spotify.js';
import { resolutionManager, ResolutionManager } from '../music/resolutionManager.js';
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
      let tracks = [];
      const userInfo = {
        username: socket.user?.username || 'Web User',
        id: socket.user?.discord_id || null,
        avatar: socket.user?.avatar || null
      };

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
          ResolutionManager.createUnresolvedTrack(st, userInfo)
        );
      } else if (spotifyParsed.type === 'track') {
        // Handle Spotify track - use lazy resolution like playlists/albums
        const spotifyTrack = await getPublicTrack(spotifyParsed.id);
        if (!spotifyTrack) {
          socket.emit('error', { message: 'Spotify track not found' });
          return;
        }

        // Create unresolved track for lazy resolution
        tracks = [ResolutionManager.createUnresolvedTrack(spotifyTrack, userInfo)];
      } else if (spotifyParsed.type === 'album') {
        // Handle Spotify album - add tracks with lazy resolution
        const albumTracks = await getPublicAlbumTracks(spotifyParsed.id);
        if (albumTracks.length === 0) {
          socket.emit('error', { message: 'Spotify album not found or empty' });
          return;
        }

        // Convert to unresolved queue tracks (lazy resolution)
        tracks = albumTracks.map(st =>
          ResolutionManager.createUnresolvedTrack(st, userInfo)
        );
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
        requestedBy: userInfo.username,
        requestedById: userInfo.id,
        requestedByAvatar: userInfo.avatar
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
          let playedSuccessfully = false;
          if (current) {
            const success = await player.play(current, connection);
            if (success) {
              playedSuccessfully = true;
            } else {
              // If first track failed to resolve, try next tracks
              let nextTrack = queue.next();
              while (nextTrack) {
                const nextSuccess = await player.play(nextTrack, connection);
                if (nextSuccess) {
                  playedSuccessfully = true;
                  break;
                }
                nextTrack = queue.next();
              }
            }
          }
          // If all tracks failed to play, notify UI
          if (!playedSuccessfully && queue.length > 0) {
            musicManager.emit('track:change', null);
            musicManager.emitState();
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
