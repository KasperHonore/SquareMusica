import { EmbedBuilder } from 'discord.js';

export async function handleWebUI(interaction) {
  const webUrl = process.env.WEB_URL || 'http://localhost:5173';

  const embed = new EmbedBuilder()
    .setTitle('Web Control Panel')
    .setDescription(`Control the music bot from your browser:\n\n**${webUrl}**`)
    .setColor(0x5865f2)
    .addFields(
      { name: 'Features', value: '• View and manage queue\n• Control playback\n• Search and add songs\n• Real-time updates' }
    );

  await interaction.reply({ embeds: [embed], ephemeral: true });
}
