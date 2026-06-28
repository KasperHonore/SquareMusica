import { useEffect, useState, useCallback } from 'react';
import { io } from 'socket.io-client';
import { useAuth } from '../context/AuthContext';

export function useSocket() {
  const { user } = useAuth();
  const [socket, setSocket] = useState(null);
  const [connected, setConnected] = useState(false);
  // Distinct connection status the UI can surface: 'connecting' | 'connected'
  // | 'reconnecting' | 'disconnected'
  const [status, setStatus] = useState('connecting');
  const [queue, setQueue] = useState([]);
  const [currentIndex, setCurrentIndex] = useState(0);
  const [currentTrack, setCurrentTrack] = useState(null);
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);
  const [playerState, setPlayerState] = useState({
    playing: false,
    paused: false,
    loop: 'off',
    position: 0,
    connected: false
  });
  const [resolutionStats, setResolutionStats] = useState(null);
  const [voiceContext, setVoiceContext] = useState(null);
  const [historyVersion, setHistoryVersion] = useState(0);
  const [botInfo, setBotInfo] = useState(null);
  const [playlists, setPlaylists] = useState([]);

  useEffect(() => {
    if (!user) return;

    const newSocket = io({
      withCredentials: true
    });

    newSocket.on('connect', () => {
      setConnected(true);
      setStatus('connected');
    });

    newSocket.on('disconnect', () => {
      setConnected(false);
      setStatus('disconnected');
    });

    // Manager-level reconnection lifecycle (socket.io-client v4)
    newSocket.io.on('reconnect_attempt', () => {
      setStatus('reconnecting');
    });
    newSocket.io.on('reconnect', () => {
      setStatus('connected');
    });

    newSocket.on('queue:update', (data) => {
      // Handle both old format (array) and new format (object with tracks and currentIndex)
      if (Array.isArray(data)) {
        setQueue(data);
      } else if (data && typeof data === 'object') {
        setQueue(Array.isArray(data.tracks) ? data.tracks : []);
        setCurrentIndex(typeof data.currentIndex === 'number' ? data.currentIndex : 0);
      }
    });

    newSocket.on('track:change', (track) => {
      setCurrentTrack(track);
    });

    newSocket.on('player:state', (state) => {
      setPlayerState(state);
    });

    newSocket.on('track:progress', ({ position }) => {
      setPlayerState((prev) => ({ ...prev, position }));
    });

    newSocket.on('initial:state', (state) => {
      setQueue(Array.isArray(state.queue) ? state.queue : []);
      setCurrentIndex(typeof state.currentIndex === 'number' ? state.currentIndex : 0);
      setCurrentTrack(state.currentTrack || null);
      setPlayerState(
        state.playerState || {
          playing: false,
          paused: false,
          loop: 'off',
          position: 0,
          connected: false
        }
      );
      if (state.resolutionStats) {
        setResolutionStats(state.resolutionStats);
      }
      if (state.voiceContext !== undefined) {
        setVoiceContext(state.voiceContext);
      }
      if (state.botInfo !== undefined) {
        setBotInfo(state.botInfo);
      }
      if (Array.isArray(state.playlists)) {
        setPlaylists(state.playlists);
      }
    });

    newSocket.on('playlists:update', (updatedPlaylists) => {
      setPlaylists(Array.isArray(updatedPlaylists) ? updatedPlaylists : []);
    });

    newSocket.on('voice:context', (context) => {
      setVoiceContext(context);
    });

    newSocket.on('resolution:progress', (stats) => {
      setResolutionStats(stats);
    });

    newSocket.on('history:cleared', () => {
      setHistoryVersion((v) => v + 1);
    });

    newSocket.on('error', (err) => {
      setError(err.message || 'An error occurred');
    });

    newSocket.on('notice', (n) => {
      setNotice(n?.message || null);
    });

    setSocket(newSocket);

    return () => {
      newSocket.close();
    };
  }, [user]);

  const addToQueue = useCallback(
    (query) => {
      socket?.emit('queue:add', { query });
    },
    [socket]
  );

  const removeFromQueue = useCallback(
    (position) => {
      socket?.emit('queue:remove', { position });
    },
    [socket]
  );

  const reorderQueue = useCallback(
    (from, to) => {
      socket?.emit('queue:reorder', { from, to });
    },
    [socket]
  );

  const playerControl = useCallback(
    (action, value) => {
      socket?.emit('player:control', { action, value });
    },
    [socket]
  );

  const voiceJoin = useCallback(() => {
    socket?.emit('voice:join');
  }, [socket]);

  const voiceLeave = useCallback(() => {
    socket?.emit('voice:leave');
  }, [socket]);

  const createPlaylist = useCallback(
    (name, spotifyUrl, coverImage) => {
      socket?.emit('playlist:create', { name, spotifyUrl, coverImage });
    },
    [socket]
  );

  const deletePlaylist = useCallback(
    (id) => {
      socket?.emit('playlist:delete', { id });
    },
    [socket]
  );

  const clearError = useCallback(() => {
    setError(null);
  }, []);

  const clearNotice = useCallback(() => {
    setNotice(null);
  }, []);

  return {
    connected,
    status,
    queue,
    currentIndex,
    currentTrack,
    playerState,
    resolutionStats,
    voiceContext,
    historyVersion,
    botInfo,
    playlists,
    error,
    notice,
    addToQueue,
    removeFromQueue,
    reorderQueue,
    playerControl,
    voiceJoin,
    voiceLeave,
    createPlaylist,
    deletePlaylist,
    clearError,
    clearNotice
  };
}
