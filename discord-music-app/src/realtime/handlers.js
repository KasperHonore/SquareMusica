import { musicManager } from '../state/musicManager.js';
import {
  getConnection,
  isConnected,
  joinChannel,
  leaveChannel,
  setChannelCache
} from '../bot/voiceManager.js';
import { resolveQuery, tryPlayWithFallback } from '../music/trackResolver.js';
import { resolutionManager } from '../music/resolutionManager.js';
import { client } from '../bot/client.js';
import {
  addTracksToQueue,
  ensureVoiceConnected,
  resolveQueryErrorToMessage,
  MAX_QUERY_LENGTH
} from '../shared/queueHelpers.js';
import { logger } from '../utils/logger.js';

// Minimum interval (ms) between accepted events of a given type. Lightweight
// in-memory throttle to stop a single user from flooding yt-dlp searches or
// voice-join attempts. Keyed per USER (not per socket) so one user with several
// open tabs can't multiply their budget by the number of connections.
const THROTTLE_INTERVALS_MS = {
  'queue:add': 1000,
  'voice:join': 3000
};

// `${userId}:${event}` -> last-accepted timestamp. Bounded by (users x events).
const lastEventAt = new Map();

function isThrottled(socket, key) {
  const intervalMs = THROTTLE_INTERVALS_MS[key];
  if (!intervalMs) return false;

  const userId = socket.user?.discord_id || socket.user?.id || 'anonymous';
  const mapKey = `${userId}:${key}`;
  const now = Date.now();
  const last = lastEventAt.get(mapKey) || 0;
  if (now - last < intervalMs) {
    return true;
  }

  lastEventAt.set(mapKey, now);
  return false;
}

/**
 * Check if bot is connected to voice channel
 * @param {Socket} socket - Socket.io socket instance
 * @returns {boolean} True if connected, false otherwise (and emits error)
 */
function checkVoiceConnection(socket) {
  const guildId = musicManager.guildId || process.env.GUILD_ID;
  return ensureVoiceConnected({
    guildId,
    isConnected,
    onNotConnected: () =>
      socket.emit('error', {
        message: 'Bot is not in a voice channel. Use /join in Discord first.'
      })
  });
}

/**
 * Handle queue add requests from web clients
 * @param {Socket} socket - Socket.io socket instance
 * @returns {Function} Event handler
 */
export function handleQueueAdd(socket) {
  return async ({ query }) => {
    if (isThrottled(socket, 'queue:add')) {
      socket.emit('error', { message: 'You are adding tracks too quickly. Please slow down.' });
      return;
    }
    if (!checkVoiceConnection(socket)) return;

    if (typeof query !== 'string' || query.length === 0) {
      socket.emit('error', { message: 'A search query is required.' });
      return;
    }
    if (query.length > MAX_QUERY_LENGTH) {
      socket.emit('error', { message: `Query must be at most ${MAX_QUERY_LENGTH} characters.` });
      return;
    }

    try {
      const userInfo = {
        username: socket.user?.username || 'Web User',
        id: socket.user?.discord_id || null,
        avatar: socket.user?.avatar || null
      };

      // Resolve query to tracks
      const { tracks: rawTracks, error } = await resolveQuery(query, userInfo);

      if (error) {
        socket.emit('error', { message: resolveQueryErrorToMessage(error) });
        return;
      }

      addTracksToQueue({
        musicManager,
        resolutionManager,
        queue: musicManager.queue,
        currentIndex: musicManager.getCurrentIndex(),
        rawTracks,
        userInfo
      });

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
      logger.error('Queue add error:', err);
      socket.emit('error', { message: 'Failed to add to the queue. Please try again.' });
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
      logger.error('Queue remove error:', err);
      socket.emit('error', { message: 'Failed to remove the track. Please try again.' });
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
      logger.error('Queue reorder error:', err);
      socket.emit('error', { message: 'Failed to reorder the queue. Please try again.' });
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
        case 'previous': {
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
        }
        default:
          socket.emit('error', { message: 'Unknown action' });
      }
    } catch (err) {
      logger.error('Player control error:', err);
      socket.emit('error', { message: 'Playback control failed. Please try again.' });
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
    if (isThrottled(socket, 'voice:join')) {
      socket.emit('error', { message: 'Please wait a moment before trying to join again.' });
      return;
    }
    try {
      if (!client.isReady()) {
        socket.emit('error', {
          message: 'Bot is still starting up. Please wait a moment and try again.'
        });
        return;
      }

      const discordId = socket.user.discord_id;
      logger.debug(
        `[HandleVoiceJoin] User ${socket.user.username} (${discordId}) requesting voice join`
      );

      const guildId = musicManager.guildId || process.env.GUILD_ID;
      if (!guildId) {
        socket.emit('error', { message: 'Server is not configured with a target guild.' });
        return;
      }

      const guild = await client.guilds.fetch(guildId);
      const member = await guild.members.fetch(discordId);
      const voiceChannel = member.voice?.channel || null;

      if (!voiceChannel) {
        logger.debug(`[HandleVoiceJoin] User ${socket.user.username} not in any voice channel`);
        socket.emit('error', { message: 'You need to be in a voice channel in Discord!' });
        return;
      }

      logger.debug(
        `[HandleVoiceJoin] Found user in channel ${voiceChannel.name} in guild ${voiceChannel.guild.name} (${voiceChannel.guild.id}), joining...`
      );
      const conn = await joinChannel(voiceChannel);
      logger.debug(
        `[HandleVoiceJoin] joinChannel returned, connection status: ${conn?.state?.status}`
      );
      musicManager.setGuildId(voiceChannel.guild.id);
      setChannelCache(voiceChannel.guild.id, voiceChannel);
      logger.debug(`[HandleVoiceJoin] About to emit voice context and state...`);
      musicManager.emitVoiceContext();
      musicManager.emitState();
      logger.debug(`[HandleVoiceJoin] Join complete, voice context and state emitted`);
    } catch (err) {
      logger.error('[HandleVoiceJoin] Voice join error:', err);
      socket.emit('error', { message: 'Failed to join the voice channel. Please try again.' });
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
      logger.error('Voice leave error:', err);
      socket.emit('error', { message: 'Failed to leave the voice channel. Please try again.' });
    }
  };
}
