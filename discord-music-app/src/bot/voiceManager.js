import { joinVoiceChannel, getVoiceConnection, VoiceConnectionStatus, entersState } from '@discordjs/voice';

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
    return true;
  }
  return false;
}

export function getConnection(guildId) {
  return connections.get(guildId) || getVoiceConnection(guildId);
}

export { connections };
