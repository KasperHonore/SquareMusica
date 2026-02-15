import { joinVoiceChannel, getVoiceConnection, VoiceConnectionStatus, entersState } from '@discordjs/voice';
import { db } from '../database/db.js';
import { botEvents } from './client.js';

const connections = new Map();

export async function joinChannel(channel) {
  const connection = joinVoiceChannel({
    channelId: channel.id,
    guildId: channel.guild.id,
    adapterCreator: channel.guild.voiceAdapterCreator,
  });

  try {
    await entersState(connection, VoiceConnectionStatus.Ready, 30_000);
    connections.set(channel.guild.id, connection);

    connection.on(VoiceConnectionStatus.Disconnected, async () => {
      try {
        await Promise.race([
          entersState(connection, VoiceConnectionStatus.Signalling, 5_000),
          entersState(connection, VoiceConnectionStatus.Connecting, 5_000),
        ]);
      } catch (error) {
        connection.destroy();
        connections.delete(channel.guild.id);
      }
    });

    return connection;
  } catch (error) {
    connection.destroy();
    throw error;
  }
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
