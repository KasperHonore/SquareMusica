import { Server } from 'socket.io';
import { randomUUID } from 'crypto';
import { db } from '../database/db.js';
import { musicManager } from '../state/musicManager.js';
import { botEvents } from '../bot/client.js';
import { ServerEvents, ClientEvents } from './events.js';
import { verifyToken } from '../api/middleware/auth.js';
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
  io = new Server(httpServer, {
    cors: {
      origin: process.env.WEB_URL || 'http://localhost:5173',
      credentials: true
    }
  });

  // Authentication middleware
  io.use((socket, next) => {
    const token = socket.handshake.auth.token;
    const { user, error } = verifyToken(token);

    if (error) {
      return next(new Error(error));
    }

    socket.user = user;
    next();
  });

  io.on('connection', (socket) => {
    console.log(`User connected: ${socket.user.username}`);

    // Send initial state (including playlists)
    const initialState = {
      ...musicManager.getFullState(),
      playlists: db.getPlaylists()
    };
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
        console.log(`[Playlist] Created "${name}" by ${createdBy}`);
        broadcastPlaylistsUpdate();
      }
    });

    socket.on(ClientEvents.PLAYLIST_DELETE, ({ id }) => {
      const deleted = db.deletePlaylist(id);
      if (deleted) {
        console.log(`[Playlist] Deleted ${id} by ${socket.user.username}`);
        broadcastPlaylistsUpdate();
      }
    });

    socket.on('disconnect', () => {
      console.log(`User disconnected: ${socket.user.username}`);
    });
  });

  // Subscribe to MusicManager events and broadcast to all clients
  musicManager.on('queue:update', (queue) => {
    io.emit(ServerEvents.QUEUE_UPDATE, queue);
  });

  musicManager.on('track:change', (track) => {
    io.emit(ServerEvents.TRACK_CHANGE, track);
  });

  musicManager.on('player:state', (state) => {
    io.emit(ServerEvents.PLAYER_STATE, state);
  });

  musicManager.on('resolution:progress', (stats) => {
    io.emit(ServerEvents.RESOLUTION_PROGRESS, stats);
  });

  musicManager.on('voice:context', (context) => {
    io.emit(ServerEvents.VOICE_CONTEXT, context);
  });

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

  // Listen for history cleared events from bot
  botEvents.on('historyCleared', (guildId) => {
    console.log(`[Socket] Broadcasting history:cleared for guild ${guildId}`);
    io.emit(ServerEvents.HISTORY_CLEARED, { guildId });
  });

  console.log('Socket.io server initialized');
  return io;
}

/**
 * Shutdown Socket.io server and cleanup resources
 */
export function shutdownSocketServer() {
  if (progressInterval) {
    clearInterval(progressInterval);
  }
  if (io) {
    io.close();
  }
}
