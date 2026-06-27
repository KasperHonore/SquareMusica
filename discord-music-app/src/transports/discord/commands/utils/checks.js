import { isConnected } from '../../voiceManager.js';

/**
 * Check if bot is connected to voice, reply with error if not
 * @param {Object} interaction - Discord interaction
 * @returns {Promise<boolean>} true if connected, false if not (already replied)
 */
export async function requireVoiceConnection(interaction) {
  if (!isConnected(interaction.guildId)) {
    await interaction.reply({
      content: "I'm not in a voice channel! Use `/join` to add me first.",
      ephemeral: true
    });
    return false;
  }
  return true;
}
