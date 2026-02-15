import { getPlayer, getQueue } from './playback.js';
import { musicManager } from '../state/musicManager.js';

export async function handleVolume(interaction) {
  const level = interaction.options.getInteger('level');
  const p = getPlayer();

  p.setVolume(level);
  musicManager.emitState();

  await interaction.reply(`Volume set to **${level}%**`);
}

export async function handleLoop(interaction) {
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
