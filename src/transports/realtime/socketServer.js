import { Server } from 'socket.io';
import { randomUUID } from 'crypto';
import { db } from '../../persistence/db.js';
import { musicManager } from '../../core/musicManager.js';
import { botEvents } from '../discord/client.js';
import { ServerEvents, ClientEvents } from './events.js';
import { verifyToken } from '../http/middleware/auth.js';
import { logger } from '../../utils/logger.js';
import {
  handleQueueAdd,
  handleQueueRemove,
  handleQueueReorder,
  handlePlayerControl,
  handleVoiceJoin,
  handleVoiceLeave
} from './handlers.js';

let io;
let progressInterval;
// Track the exact listeners we subscribe so shutdown can remove precisely the
// ones setup added (other modules may register their own listeners on these
// emitters, so removeAllListeners is not safe). Each entry is [event, handler].
let managerListeners = [];
let botEventsListeners = [];

function getCookieTokenFromHeaders(headers) {
  const cookieHeader = headers?.cookie;
  if (!cookieHeader) return null;
  const parts = cookieHeader.split(';');
  for (const part of parts) {
    const [rawKey, ...rest] = part.trim().split('=');
    if (rawKey === 'token') {
      const value = rest.join('=');
      return value ? decodeURIComponent(value) : null;
    }
  }
  return null;
}

/**
 * Broadcast playlists update to all connected clients
 */
function broadcastPlaylistsUpdate() {
  const playlists = db.getPlaylists();
  io.emit(ServerEvents.PLAYLISTS_UPDATE, playlists);
}

/**
 * Setup Socket.io server with authentication and event handlers
 * @param {http.Server} httpServer - HTTP server instance
 * @returns {Server} Socket.io server instance
 */
export function setupSocketServer(httpServer) {
  // Idempotency guard: if a previous instance is still live, fully tear it down
  // first so we never end up with duplicate intervals or listeners. Choosing
  // teardown-and-rebuild (over a no-op return) keeps it correct even when called
  // with a different httpServer, while reusing the single shutdown code path.
  if (io) {
    logger.warn(
      'setupSocketServer called while already initialized; tearing down previous instance'
    );
    shutdownSocketServer();
  }

  io = new Server(httpServer, {
    cors: {
      origin: process.env.WEB_URL || 'http://localhost:5173',
      credentials: true
    }
  });

  // Authentication middleware
  io.use((socket, next) => {
    const token =
      socket.handshake.auth?.token || getCookieTokenFromHeaders(socket.handshake.headers);
    const { user, error } = verifyToken(token);

    if (error) {
      return next(new Error(error));
    }

    socket.user = user;
    next();
  });

  io.on('connection', (socket) => {
    logger.debug(`User connected: ${socket.user.username}`);

    // Send initial state (including playlists)
    const initialState = {
      ...musicManager.getFullState(),
      playlists: db.getPlaylists()
    };
    logger.debug(
      `[Socket] Sending initial:state to ${socket.user.username}: connected=${initialState.playerState?.connected}, voiceContext=${initialState.voiceContext ? initialState.voiceContext.channelName : 'null'}`
    );
    socket.emit(ServerEvents.INITIAL_STATE, initialState);

    // Register client event handlers
    socket.on(ClientEvents.QUEUE_ADD, handleQueueAdd(socket));
    socket.on(ClientEvents.QUEUE_REMOVE, handleQueueRemove(socket));
    socket.on(ClientEvents.QUEUE_REORDER, handleQueueReorder(socket));
    socket.on(ClientEvents.PLAYER_CONTROL, handlePlayerControl(socket));
    socket.on(ClientEvents.VOICE_JOIN, handleVoiceJoin(socket));
    socket.on(ClientEvents.VOICE_LEAVE, handleVoiceLeave(socket));

    // Playlist event handlers
    socket.on(ClientEvents.PLAYLIST_CREATE, ({ name, spotifyUrl, coverImage }) => {
      const id = 'playlist_' + Date.now().toString(36) + randomUUID().slice(0, 8);
      const createdBy = socket.user.username;
      const playlist = db.createPlaylist(id, name, spotifyUrl, coverImage, createdBy);
      if (playlist) {
        logger.info(`[Playlist] Created "${name}" by ${createdBy}`);
        broadcastPlaylistsUpdate();
      }
    });

    socket.on(ClientEvents.PLAYLIST_DELETE, ({ id }) => {
      const deleted = db.deletePlaylist(id);
      if (deleted) {
        logger.info(`[Playlist] Deleted ${id} by ${socket.user.username}`);
        broadcastPlaylistsUpdate();
      }
    });

    socket.on('disconnect', () => {
      logger.debug(`User disconnected: ${socket.user.username}`);
    });
  });

  // Subscribe to MusicManager events and broadcast to all clients. References
  // are tracked in managerListeners so shutdown can remove exactly these.
  managerListeners = [
    [
      'queue:update',
      (queue) => {
        io.emit(ServerEvents.QUEUE_UPDATE, queue);
      }
    ],
    [
      'track:change',
      (track) => {
        io.emit(ServerEvents.TRACK_CHANGE, track);
      }
    ],
    [
      'player:state',
      (state) => {
        logger.debug(
          `[Socket] Broadcasting player:state connected=${state.connected} playing=${state.playing}`
        );
        io.emit(ServerEvents.PLAYER_STATE, state);
      }
    ],
    [
      'resolution:progress',
      (stats) => {
        io.emit(ServerEvents.RESOLUTION_PROGRESS, stats);
      }
    ],
    [
      'voice:context',
      (context) => {
        logger.debug(
          `[Socket] Broadcasting voice:context`,
          context ? `channel=${context.channelName}` : 'null'
        );
        io.emit(ServerEvents.VOICE_CONTEXT, context);
      }
    ]
  ];
  for (const [event, handler] of managerListeners) {
    musicManager.on(event, handler);
  }

  // Defensively clear any existing interval before creating a new one so a
  // stray timer can never outlive setup.
  if (progressInterval) {
    clearInterval(progressInterval);
  }
  // Periodically emit track progress
  progressInterval = setInterval(() => {
    const track = musicManager.getCurrentTrack();
    const player = musicManager.player;

    if (track && player?.isPlaying()) {
      io.emit(ServerEvents.TRACK_PROGRESS, {
        position: player.getPosition(),
        duration: track.duration
      });
    }
  }, 1000);

  // Listen for history cleared events from bot (tracked for precise teardown).
  botEventsListeners = [
    [
      'historyCleared',
      (guildId) => {
        logger.debug(`[Socket] Broadcasting history:cleared for guild ${guildId}`);
        io.emit(ServerEvents.HISTORY_CLEARED, { guildId });
      }
    ]
  ];
  for (const [event, handler] of botEventsListeners) {
    botEvents.on(event, handler);
  }

  logger.info('Socket.io server initialized');
  return io;
}

/**
 * Shutdown Socket.io server and cleanup resources
 */
export function shutdownSocketServer() {
  if (progressInterval) {
    clearInterval(progressInterval);
    progressInterval = null;
  }

  // Remove exactly the listeners setup registered (not removeAllListeners,
  // which would clobber listeners owned by other modules).
  for (const [event, handler] of managerListeners) {
    musicManager.off(event, handler);
  }
  managerListeners = [];

  for (const [event, handler] of botEventsListeners) {
    botEvents.off(event, handler);
  }
  botEventsListeners = [];

  if (io) {
    io.close();
    io = null;
  }
}
