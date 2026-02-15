import { joinChannel, leaveChannel, getConnection } from '../bot/voiceManager.js';
import { musicManager } from '../state/musicManager.js';

export async function handleJoin(interaction) {
  // Fetch the guild and member to get current voice state
  const guild = await interaction.client.guilds.fetch(interaction.guildId);
  const member = await guild.members.fetch(interaction.user.id);
  const voiceChannel = member.voice?.channel;

  if (!voiceChannel) {
    return interaction.reply({
      content: 'You need to be in a voice channel!',
      ephemeral: true
    });
  }

  try {
    await interaction.deferReply();
    await joinChannel(voiceChannel);
    musicManager.setGuildId(interaction.guildId);
    await interaction.editReply(`Joined **${voiceChannel.name}**`);
  } catch (error) {
    console.error('Join error:', error);
    await interaction.editReply('Failed to join voice channel.');
  }
}

export async function handleLeave(interaction) {
  const connection = getConnection(interaction.guildId);

  if (!connection) {
    return interaction.reply({
      content: 'I\'m not in a voice channel!',
      ephemeral: true
    });
  }

  leaveChannel(interaction.guildId);
  musicManager.stop();
  await interaction.reply('Left the voice channel.');
}
