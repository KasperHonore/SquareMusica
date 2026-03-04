import { joinVoiceChannel, getVoiceConnection, VoiceConnectionStatus, entersState } from '@discordjs/voice';
import { db } from '../database/db.js';
import { botEvents } from './client.js';

const connections = new Map();

export async function joinChannel(channel) {
  const guildId = channel.guild.id;

  // Clean up any stale connection before creating a new one
  const existing = getVoiceConnection(guildId);
  if (existing) {
    if (existing.state.status === VoiceConnectionStatus.Ready) {
      console.log(`[VoiceManager] Reusing existing Ready connection for guild ${guildId}`);
      connections.set(guildId, existing);
      setupConnectionListeners(existing, guildId);
      return existing;
    }
    console.log(`[VoiceManager] Destroying stale ${existing.state.status} connection for guild ${guildId}`);
    try { existing.destroy(); } catch {}
  }

  console.log(`[VoiceManager] Creating voice connection for guild ${guildId}, channel ${channel.name}`);
  const connection = joinVoiceChannel({
    channelId: channel.id,
    guildId: guildId,
    adapterCreator: channel.guild.voiceAdapterCreator,
    debug: true,
  });

  // Log all state transitions for diagnostics
  connection.on('stateChange', (oldState, newState) => {
    console.log(`[VoiceManager] Connection ${guildId}: ${oldState.status} -> ${newState.status}`);
  });

  // Check if the adapter failed immediately (sendPayload returned false)
  if (connection.state.status === VoiceConnectionStatus.Disconnected) {
    console.error(`[VoiceManager] Connection immediately disconnected (adapter unavailable) for guild ${guildId}`);
    try { connection.destroy(); } catch {}
    throw new Error('Voice adapter unavailable - bot may be reconnecting to Discord. Please try again.');
  }

  try {
    await entersState(connection, VoiceConnectionStatus.Ready, 30_000);
    console.log(`[VoiceManager] Connection Ready for guild ${guildId}`);
    connections.set(guildId, connection);
    setupConnectionListeners(connection, guildId);
    return connection;
  } catch (error) {
    const status = connection.state?.status || 'unknown';
    console.error(`[VoiceManager] Connection failed for guild ${guildId} (stuck in ${status})`);
    try { connection.destroy(); } catch {}
    throw new Error(`Voice connection timed out (stuck in ${status}). Check bot permissions and voice region.`);
  }
}

function setupConnectionListeners(connection, guildId) {
  connection.removeAllListeners(VoiceConnectionStatus.Disconnected);
  connection.removeAllListeners(VoiceConnectionStatus.Destroyed);

  connection.on(VoiceConnectionStatus.Disconnected, async () => {
    console.log(`[VoiceManager] Connection disconnected for guild ${guildId}, attempting reconnect...`);
    try {
      await Promise.race([
        entersState(connection, VoiceConnectionStatus.Signalling, 5_000),
        entersState(connection, VoiceConnectionStatus.Connecting, 5_000),
      ]);
      console.log(`[VoiceManager] Reconnect succeeded for guild ${guildId}`);
    } catch (error) {
      connection.destroy();
      connections.delete(guildId);
      console.log(`[VoiceManager] Connection destroyed after failed reconnect for guild ${guildId}`);
      botEvents.emit('voiceDisconnected', guildId);
    }
  });

  connection.on(VoiceConnectionStatus.Destroyed, () => {
    connections.delete(guildId);
    console.log(`[VoiceManager] Connection destroyed for guild ${guildId}`);
    botEvents.emit('voiceDisconnected', guildId);
  });
}

export function leaveChannel(guildId) {
  const connection = connections.get(guildId);
  if (connection) {
    connection.destroy();
    connections.delete(guildId);

    // Clear play history when leaving voice channel
    const cleared = db.clearAllHistory();
    console.log(`[VoiceManager] Cleared ${cleared} history records on voice leave`);
    botEvents.emit('historyCleared', guildId);

    return true;
  }
  return false;
}

export function getConnection(guildId) {
  return connections.get(guildId) || getVoiceConnection(guildId);
}

export function isConnected(guildId) {
  return !!getConnection(guildId);
}

// Store channel references for voice context
const channelCache = new Map();

export function setChannelCache(guildId, channel) {
  if (channel) {
    channelCache.set(guildId, channel);
  } else {
    channelCache.delete(guildId);
  }
}

export function getChannelInfo(guildId) {
  const channel = channelCache.get(guildId);
  if (!channel) {
    return null;
  }

  const guild = channel.guild;
  const connectedUsers = channel.members
    .filter(m => !m.user.bot)
    .map(m => ({
      id: m.user.id,
      username: m.user.username,
      avatar: m.user.avatar
    }));

  return {
    guildId: guild.id,
    guildName: guild.name,
    guildIcon: guild.iconURL(),
    channelId: channel.id,
    channelName: channel.name,
    connectedUsers
  };
}

export function getChannelCache(guildId) {
  return channelCache.get(guildId);
}
