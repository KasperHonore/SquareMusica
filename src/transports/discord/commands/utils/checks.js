import { isConnected } from '../../voiceManager.js';
import { NOT_IN_VOICE_TEXT } from '../../../../services/dj/messages.js';

/**
 * Check if bot is connected to voice, reply with error if not
 * @param {Object} interaction - Discord interaction
 * @returns {Promise<boolean>} true if connected, false if not (already replied)
 */
export async function requireVoiceConnection(interaction) {
  if (!isConnected(interaction.guildId)) {
    await interaction.reply({
      content: NOT_IN_VOICE_TEXT,
      ephemeral: true
    });
    return false;
  }
  return true;
}
