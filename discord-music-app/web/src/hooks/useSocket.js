import { useEffect, useState, useCallback, useRef } from 'react';
import { io } from 'socket.io-client';
import { useAuth } from '../context/AuthContext';

export function useSocket() {
  const { token } = useAuth();
  const [socket, setSocket] = useState(null);
  const [connected, setConnected] = useState(false);
  const [queue, setQueue] = useState([]);
  const [currentTrack, setCurrentTrack] = useState(null);
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
      console.log('Socket connected');
      setConnected(true);
    });

    newSocket.on('disconnect', () => {
      console.log('Socket disconnected');
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

  return {
    connected,
    queue,
    currentTrack,
    playerState,
    addToQueue,
    removeFromQueue,
    reorderQueue,
    playerControl
  };
}
