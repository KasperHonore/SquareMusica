import { musicManager } from '../../core/musicManager.js';
import {
  isConnected,
  joinChannel,
  leaveChannel,
  setChannelCache
} from '../discord/voiceManager.js';
import { resolveQuery } from '../../services/trackResolver.js';
import { client } from '../discord/client.js';
import {
  ensureVoiceConnected,
  resolveQueryErrorToMessage,
  formatTruncationNotice,
  MAX_QUERY_LENGTH
} from '../../shared/queueHelpers.js';
import { botEvents } from '../../events/bus.js';
import {
  STATS_EVENT,
  STATS_EVENT_TYPES,
  createStatsEvent,
  captureTrack
} from '../../shared/statsEvents.js';
import { setSettings, getStateOrUnavailable } from '../../services/dj/djService.js';
import { djErrorReply } from '../../services/dj/messages.js';
import { logger } from '../../utils/logger.js';

// Minimum interval (ms) between accepted events of a given type. Lightweight
// in-memory throttle to stop a single user from flooding yt-dlp searches or
// voice-join attempts. Keyed per USER (not per socket) so one user with several
// open tabs can't multiply their budget by the number of connections.
const THROTTLE_INTERVALS_MS = {
  'queue:add': 1000,
  'voice:join': 3000,
  dj: 1000
};

// Longest throttle window. An entry older than this can never trigger a denial,
// so it is meaningless and safe to drop.
const MAX_THROTTLE_INTERVAL_MS = Math.max(...Object.values(THROTTLE_INTERVALS_MS));

// Hard backstop on distinct keys so a flood of one-off users (each producing a
// `${userId}:${event}` key) can't grow the map without bound between sweeps.
const THROTTLE_MAX_ENTRIES = 5000;

// `${userId}:${event}` -> last-accepted timestamp. Bounded by the stale sweep in
// recordAccepted() plus the THROTTLE_MAX_ENTRIES cap below.
const lastEventAt = new Map();

/**
 * Record an accepted event timestamp and opportunistically bound the map.
 *
 * Map keeps insertion order and we re-insert on every accept, so the oldest
 * entries are the least-recently-accepted. Any entry older than the longest
 * throttle window cannot cause a future denial, so sweeping those from the front
 * never changes allow/deny decisions for active users. A size cap evicts the
 * least-recently-used keys as a final guard against pathological bursts.
 * @param {string} mapKey
 * @param {number} now
 */
function recordAccepted(mapKey, now) {
  // Move the key to the most-recently-used end.
  lastEventAt.delete(mapKey);
  lastEventAt.set(mapKey, now);

  // Drop stale entries from the LRU front. Deleting visited keys mid-iteration
  // is safe for a Map iterator.
  for (const [k, ts] of lastEventAt) {
    if (now - ts <= MAX_THROTTLE_INTERVAL_MS) break;
    lastEventAt.delete(k);
  }

  // Backstop: enforce the hard cap by evicting least-recently-used keys.
  while (lastEventAt.size > THROTTLE_MAX_ENTRIES) {
    const lruKey = lastEventAt.keys().next().value;
    if (lruKey === undefined) break;
    lastEventAt.delete(lruKey);
  }
}

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

  recordAccepted(mapKey, now);
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
 * Emit one recorded action on the shared bus.
 *
 * Wrapped so a recording failure cannot surface as a socket error: bus listeners
 * run synchronously, inside this handler's try block.
 */
function emitAction(type, user, track, metadata = null) {
  try {
    botEvents.emit(STATS_EVENT, createStatsEvent({ type, actor: user, track, metadata }));
  } catch {
    // Deliberately silent; the recorder logs its own failures.
  }
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
      const { tracks: rawTracks, error, truncation } = await resolveQuery(query, userInfo);

      if (error) {
        socket.emit('error', { message: resolveQueryErrorToMessage(error) });
        return;
      }

      musicManager.addTracks(rawTracks, userInfo);

      // Tell the user when a large Spotify source was capped.
      const truncationNotice = formatTruncationNotice(truncation);
      if (truncationNotice) {
        socket.emit('notice', { message: truncationNotice });
      }

      // Auto-play if nothing is currently playing.
      await musicManager.ensurePlaying();
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
      // Read the track BEFORE removing it, or there is nothing left to record.
      const removedTrack = captureTrack(() => musicManager.getQueue()[position]);

      musicManager.removeFromQueue(position);

      emitAction(STATS_EVENT_TYPES.REMOVE, socket.user, removedTrack);
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
      // Captured BEFORE any mutation: skip advances the queue, so reading the
      // current track afterwards records the track that came next. pause/resume
      // target whatever is playing and so carry it too.
      const affectedTrack = captureTrack(() => musicManager.getCurrentTrack());

      switch (action) {
        case 'play':
          musicManager.play();
          // Recorded as `resume`: musicManager.play() calls player.resume(), and
          // this surface has no separate resume action.
          emitAction(STATS_EVENT_TYPES.RESUME, socket.user, affectedTrack);
          break;
        case 'pause':
          musicManager.pause();
          emitAction(STATS_EVENT_TYPES.PAUSE, socket.user, affectedTrack);
          break;
        case 'skip':
          musicManager.skip();
          emitAction(STATS_EVENT_TYPES.SKIP, socket.user, affectedTrack);
          break;
        case 'stop':
          // Deliberately not recorded, on any surface. Stopping does clear the
          // queue as a side effect, but `stop` is not one of the tracked actions,
          // and instrumenting it here and nowhere else is exactly the parity
          // divergence the emit matrix exists to prevent.
          musicManager.stop();
          break;
        case 'loop':
          if (value) {
            musicManager.setLoop(value);
          }
          break;
        case 'shuffle':
          musicManager.shuffleQueue();
          // Acts on the queue as a whole, so no track is recorded.
          emitAction(STATS_EVENT_TYPES.SHUFFLE, socket.user, null);
          break;
        case 'clear':
          musicManager.clearUpcomingQueue();
          // This surface keeps the current track playing and drops the rest —
          // unlike HTTP, which empties everything. Hence the variant.
          emitAction(STATS_EVENT_TYPES.CLEAR_QUEUE, socket.user, null, {
            variant: 'upcoming'
          });
          break;
        case 'previous':
          await musicManager.playPrevious();
          break;
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

/**
 * Handle DJ settings changes from web clients (`dj:settings`, contracts §3).
 * The new state reaches every surface through the service's dj:state broadcast,
 * so there is no ack; a rejected change emits `error { code, message }`.
 * @param {Socket} socket - Socket.io socket instance
 * @returns {Function} Event handler
 */
export function handleDjSettings(socket) {
  return (payload) => {
    if (isThrottled(socket, 'dj')) {
      socket.emit('error', {
        message: 'You are changing DJ settings too quickly. Please slow down.'
      });
      return;
    }
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      socket.emit('error', { code: 'INVALID_BODY', message: 'DJ settings must be an object.' });
      return;
    }

    const partial = {};
    for (const field of ['enabled', 'interval', 'lookahead']) {
      if (payload[field] !== undefined) partial[field] = payload[field];
    }

    try {
      setSettings(partial, {
        id: socket.user?.discord_id ?? null,
        name: socket.user?.username ?? 'Web User'
      });
    } catch (err) {
      const reply = djErrorReply(err, getStateOrUnavailable());
      if (reply) {
        socket.emit('error', { code: reply.code, message: reply.message });
      } else if (err instanceof TypeError) {
        socket.emit('error', { code: 'INVALID_BODY', message: err.message });
      } else {
        logger.error('DJ settings error:', err);
        socket.emit('error', { message: 'Failed to change DJ settings. Please try again.' });
      }
    }
  };
}
