import {
  joinVoiceChannel,
  getVoiceConnection,
  VoiceConnectionStatus,
  entersState
} from '@discordjs/voice';
import { db } from '../database/db.js';
import { botEvents } from './client.js';
import { logger } from '../utils/logger.js';

const connections = new Map();

export async function joinChannel(channel) {
  const guildId = channel.guild.id;

  logger.debug(`[VoiceManager] joinChannel() guild=${guildId}, channel=${channel.name}`);
  const connection = joinVoiceChannel({
    channelId: channel.id,
    guildId: guildId,
    adapterCreator: channel.guild.voiceAdapterCreator
  });

  // Log state transitions for diagnostics
  connection.on('stateChange', (oldState, newState) => {
    logger.debug(`[VoiceManager] Connection ${guildId}: ${oldState.status} -> ${newState.status}`);
  });

  try {
    await entersState(connection, VoiceConnectionStatus.Ready, 30_000);
    logger.debug(`[VoiceManager] Connection Ready for guild ${guildId}`);

    connections.set(guildId, connection);
    setupConnectionListeners(connection, guildId);
    return connection;
  } catch {
    const status = connection.state?.status || 'unknown';
    logger.error(`[VoiceManager] Connection failed for guild ${guildId} (stuck in ${status})`);
    connection.destroy();
    throw new Error(
      `Voice connection timed out (stuck in ${status}). Check bot permissions and voice region.`
    );
  }
}

function setupConnectionListeners(connection, guildId) {
  connection.removeAllListeners(VoiceConnectionStatus.Disconnected);
  connection.removeAllListeners(VoiceConnectionStatus.Destroyed);

  connection.on(VoiceConnectionStatus.Disconnected, async () => {
    logger.debug(
      `[VoiceManager] Connection disconnected for guild ${guildId}, attempting reconnect...`
    );
    try {
      await Promise.race([
        entersState(connection, VoiceConnectionStatus.Signalling, 5_000),
        entersState(connection, VoiceConnectionStatus.Connecting, 5_000)
      ]);
      logger.debug(`[VoiceManager] Reconnect succeeded for guild ${guildId}`);
    } catch {
      // Don't destroy if the connection already recovered to Ready on its own
      if (connection.state.status === VoiceConnectionStatus.Ready) {
        logger.debug(`[VoiceManager] Connection already recovered to Ready for guild ${guildId}`);
        return;
      }
      logger.debug(
        `[VoiceManager] Connection destroyed after failed reconnect for guild ${guildId}`
      );
      connection.destroy();
      connections.delete(guildId);
      // Don't emit voiceDisconnected here - Destroyed handler does it
    }
  });

  connection.on(VoiceConnectionStatus.Destroyed, () => {
    connections.delete(guildId);
    logger.debug(`[VoiceManager] Destroyed listener fired guild=${guildId}`);
    botEvents.emit('voiceDisconnected', guildId);
  });
}

export function leaveChannel(guildId) {
  logger.debug(`[VoiceManager] leaveChannel(${guildId}) called`);
  const connection = connections.get(guildId);
  if (connection) {
    // Remove listeners before destroy to prevent Destroyed handler from firing
    connection.removeAllListeners(VoiceConnectionStatus.Disconnected);
    connection.removeAllListeners(VoiceConnectionStatus.Destroyed);
    connection.destroy();
    connections.delete(guildId);

    // Clear play history when leaving voice channel
    const cleared = db.clearAllHistory();
    logger.debug(`[VoiceManager] Cleared ${cleared} history records on voice leave`);
    botEvents.emit('historyCleared', guildId);

    return true;
  }
  return false;
}

export function getConnection(guildId) {
  const fromMap = connections.get(guildId);
  const fromDiscord = getVoiceConnection(guildId);
  const result = fromMap || fromDiscord;
  logger.debug(
    `[VoiceManager] getConnection(${guildId}): map=${fromMap?.state?.status || 'none'}, discord=${fromDiscord?.state?.status || 'none'}`
  );
  return result;
}

export function isConnected(guildId) {
  const conn = getConnection(guildId);
  const status = conn?.state?.status || 'none';
  const result = !!conn;
  logger.debug(
    `[VoiceManager] isConnected(${guildId}) = ${result} (status: ${status}, inMap: ${connections.has(guildId)})`
  );
  return result;
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
    .filter((m) => !m.user.bot)
    .map((m) => ({
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
