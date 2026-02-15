import { musicManager } from '../state/musicManager.js';
import { search, getInfo, isValidUrl } from '../music/youtube.js';
import { getConnection } from '../bot/voiceManager.js';

/**
 * Handle queue add requests from web clients
 * @param {Socket} socket - Socket.io socket instance
 * @returns {Function} Event handler
 */
export function handleQueueAdd(socket) {
  return async ({ query }) => {
    try {
      let track;

      if (isValidUrl(query)) {
        track = await getInfo(query);
      } else {
        const results = await search(query, 1);
        if (results.length === 0) {
          socket.emit('error', { message: 'No results found' });
          return;
        }
        track = results[0];
      }

      if (!track) {
        socket.emit('error', { message: 'Could not find track' });
        return;
      }

      track.requestedBy = socket.user?.username || 'Web User';
      musicManager.addToQueue(track);

      // Auto-play if not playing
      const player = musicManager.player;
      const queue = musicManager.queue;

      if (player && queue && !player.isPlaying() && !player.isPaused()) {
        const connection = getConnection(musicManager.guildId);
        if (connection) {
          const current = queue.getCurrent();
          if (current) {
            await player.play(current, connection);
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
