import { Server } from 'socket.io';
import jwt from 'jsonwebtoken';
import { db } from '../database/db.js';
import { musicManager } from '../state/musicManager.js';
import { ServerEvents, ClientEvents } from './events.js';
import {
  handleQueueAdd,
  handleQueueRemove,
  handleQueueReorder,
  handlePlayerControl
} from './handlers.js';

let io;
let progressInterval;

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

    if (!token) {
      return next(new Error('Authentication required'));
    }

    try {
      jwt.verify(token, process.env.JWT_SECRET);
      const session = db.getSessionByToken(token);

      if (!session) {
        return next(new Error('Session expired'));
      }

      const user = db.getUserById(session.user_id);
      if (!user) {
        return next(new Error('User not found'));
      }

      socket.user = user;
      next();
    } catch (err) {
      next(new Error('Invalid token'));
    }
  });

  io.on('connection', (socket) => {
    console.log(`User connected: ${socket.user.username}`);

    // Send initial state
    socket.emit(ServerEvents.INITIAL_STATE, musicManager.getFullState());

    // Register client event handlers
    socket.on(ClientEvents.QUEUE_ADD, handleQueueAdd(socket));
    socket.on(ClientEvents.QUEUE_REMOVE, handleQueueRemove(socket));
    socket.on(ClientEvents.QUEUE_REORDER, handleQueueReorder(socket));
    socket.on(ClientEvents.PLAYER_CONTROL, handlePlayerControl(socket));

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
