import { EmbedBuilder } from 'discord.js';
import { musicManager } from '../state/musicManager.js';
import { getPlayer, getQueue } from './playback.js';
import { isConnected } from '../bot/voiceManager.js';

export async function handleQueue(interaction) {
  if (!isConnected(interaction.guildId)) {
    return interaction.reply({
      content: "I'm not in a voice channel! Use `/join` to add me first.",
      ephemeral: true
    });
  }

  const q = getQueue();
  const tracks = q.getAll();

  if (tracks.length === 0) {
    return interaction.reply({
      content: 'The queue is empty.',
      ephemeral: true
    });
  }

  const p = getPlayer();
  const currentIndex = q.currentIndex;

  const embed = new EmbedBuilder()
    .setTitle('Music Queue')
    .setColor(0x00ff00);

  let description = '';
  const maxTracks = 10;

  for (let i = 0; i < Math.min(tracks.length, maxTracks); i++) {
    const track = tracks[i];
    const isCurrent = i === currentIndex;
    const prefix = isCurrent ? '▶️ ' : `${i + 1}. `;
    const duration = formatDuration(track.duration);
    description += `${prefix}**${track.title}** [${duration}]\n`;
  }

  if (tracks.length > maxTracks) {
    description += `\n... and ${tracks.length - maxTracks} more tracks`;
  }

  embed.setDescription(description);
  embed.setFooter({ text: `${tracks.length} tracks in queue • Loop: ${q.loopMode}` });

  await interaction.reply({ embeds: [embed] });
}

export async function handleNowPlaying(interaction) {
  if (!isConnected(interaction.guildId)) {
    return interaction.reply({
      content: "I'm not in a voice channel! Use `/join` to add me first.",
      ephemeral: true
    });
  }

  const p = getPlayer();
  const track = p.currentTrack;

  if (!track) {
    return interaction.reply({
      content: 'Nothing is playing right now.',
      ephemeral: true
    });
  }

  const position = p.getPosition();
  const progress = createProgressBar(position, track.duration);

  const embed = new EmbedBuilder()
    .setTitle('Now Playing')
    .setDescription(`**${track.title}**`)
    .setColor(0x00ff00)
    .addFields(
      { name: 'Duration', value: `${formatDuration(position)} / ${formatDuration(track.duration)}`, inline: true },
      { name: 'Requested by', value: track.requestedBy || 'Unknown', inline: true },
      { name: 'Progress', value: progress }
    );

  if (track.thumbnail) {
    embed.setThumbnail(track.thumbnail);
  }

  await interaction.reply({ embeds: [embed] });
}

export async function handleRemove(interaction) {
  if (!isConnected(interaction.guildId)) {
    return interaction.reply({
      content: "I'm not in a voice channel! Use `/join` to add me first.",
      ephemeral: true
    });
  }

  const position = interaction.options.getInteger('position') - 1; // Convert to 0-based
  const q = getQueue();

  if (position < 0 || position >= q.length) {
    return interaction.reply({
      content: 'Invalid position.',
      ephemeral: true
    });
  }

  const removed = q.remove(position);
  musicManager.emit('queue:update', q.getAll());

  await interaction.reply(`Removed **${removed.title}** from the queue.`);
}

export async function handleShuffle(interaction) {
  if (!isConnected(interaction.guildId)) {
    return interaction.reply({
      content: "I'm not in a voice channel! Use `/join` to add me first.",
      ephemeral: true
    });
  }

  const q = getQueue();

  if (q.length < 2) {
    return interaction.reply({
      content: 'Not enough tracks to shuffle.',
      ephemeral: true
    });
  }

  q.shuffle();
  musicManager.emit('queue:update', q.getAll());

  await interaction.reply('Shuffled the queue.');
}

export async function handleClear(interaction) {
  if (!isConnected(interaction.guildId)) {
    return interaction.reply({
      content: "I'm not in a voice channel! Use `/join` to add me first.",
      ephemeral: true
    });
  }

  const q = getQueue();
  const p = getPlayer();
  const current = q.getCurrent();

  // Clear all except current
  q.tracks = current ? [current] : [];
  q.currentIndex = 0;
  musicManager.emit('queue:update', q.getAll());

  await interaction.reply('Cleared the queue.');
}

function formatDuration(seconds) {
  if (!seconds || isNaN(seconds)) return '0:00';
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

function createProgressBar(current, total) {
  const length = 20;
  const progress = Math.round((current / total) * length);
  const empty = length - progress;
  return '▓'.repeat(progress) + '░'.repeat(empty);
}
