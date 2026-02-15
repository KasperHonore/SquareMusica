import { useEffect, useState, useCallback } from 'react';
import { io } from 'socket.io-client';
import { useAuth } from '../context/AuthContext';

export function useSocket() {
  const { token } = useAuth();
  const [socket, setSocket] = useState(null);
  const [connected, setConnected] = useState(false);
  const [queue, setQueue] = useState([]);
  const [currentTrack, setCurrentTrack] = useState(null);
  const [error, setError] = useState(null);
  const [playerState, setPlayerState] = useState({
    playing: false,
    paused: false,
    volume: 100,
    loop: 'off',
    position: 0,
    connected: false
  });

  useEffect(() => {
    if (!token) return;

    const newSocket = io({
      auth: { token }
    });

    newSocket.on('connect', () => {
      setConnected(true);
    });

    newSocket.on('disconnect', () => {
      setConnected(false);
    });

    newSocket.on('queue:update', (newQueue) => {
      setQueue(newQueue);
    });

    newSocket.on('track:change', (track) => {
      setCurrentTrack(track);
    });

    newSocket.on('player:state', (state) => {
      setPlayerState(state);
    });

    newSocket.on('track:progress', ({ position }) => {
      setPlayerState(prev => ({ ...prev, position }));
    });

    newSocket.on('initial:state', (state) => {
      setQueue(state.queue);
      setCurrentTrack(state.currentTrack);
      setPlayerState(state.playerState);
    });

    newSocket.on('error', (err) => {
      setError(err.message || 'An error occurred');
    });

    setSocket(newSocket);

    return () => {
      newSocket.close();
    };
  }, [token]);

  const addToQueue = useCallback((query) => {
    socket?.emit('queue:add', { query });
  }, [socket]);

  const removeFromQueue = useCallback((position) => {
    socket?.emit('queue:remove', { position });
  }, [socket]);

  const reorderQueue = useCallback((from, to) => {
    socket?.emit('queue:reorder', { from, to });
  }, [socket]);

  const playerControl = useCallback((action, value) => {
    socket?.emit('player:control', { action, value });
  }, [socket]);

  const clearError = useCallback(() => {
    setError(null);
  }, []);

  return {
    connected,
    queue,
    currentTrack,
    playerState,
    error,
    addToQueue,
    removeFromQueue,
    reorderQueue,
    playerControl,
    clearError
  };
}
