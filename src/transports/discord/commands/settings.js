import { getQueue } from '../../../services/playback.js';
import { musicManager } from '../../../core/musicManager.js';
import { requireVoiceConnection } from './utils/checks.js';

export async function handleLoop(interaction) {
  if (!(await requireVoiceConnection(interaction))) return;

  const mode = interaction.options.getString('mode');
  const q = getQueue();

  q.loopMode = mode;
  musicManager.emitState();

  const modeText = {
    off: 'Loop disabled',
    track: 'Looping current track',
    queue: 'Looping entire queue'
  };

  await interaction.reply(modeText[mode]);
}
