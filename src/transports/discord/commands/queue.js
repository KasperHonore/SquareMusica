import { EmbedBuilder } from 'discord.js';
import { musicManager } from '../../../core/musicManager.js';
import { getPlayer, getQueue } from '../../../services/playback.js';
import { requireVoiceConnection } from './utils/checks.js';
import { formatTime } from '../../../shared/formatTime.js';
import { botEvents } from '../../../events/bus.js';
import {
  STATS_EVENT,
  STATS_EVENT_TYPES,
  createStatsEvent,
  captureTrack
} from '../../../shared/statsEvents.js';

/**
 * Emit one recorded action on the shared bus. Wrapped so a recording failure
 * cannot break the command — bus listeners run synchronously in this stack.
 */
function emitAction(type, user, track, metadata = null) {
  try {
    botEvents.emit(STATS_EVENT, createStatsEvent({ type, actor: user, track, metadata }));
  } catch {
    // Deliberately silent; the recorder logs its own failures.
  }
}

export async function handleQueue(interaction) {
  if (!(await requireVoiceConnection(interaction))) return;

  const q = getQueue();
  const tracks = q.getAll();

  if (tracks.length === 0) {
    return interaction.reply({
      content: 'The queue is empty.',
      ephemeral: true
    });
  }

  const currentIndex = q.currentIndex;

  const embed = new EmbedBuilder().setTitle('Music Queue').setColor(0x00ff00);

  let description = '';
  const maxTracks = 10;

  for (let i = 0; i < Math.min(tracks.length, maxTracks); i++) {
    const track = tracks[i];
    const isCurrent = i === currentIndex;
    const prefix = isCurrent ? '▶️ ' : `${i + 1}. `;
    const duration = formatTime(track.duration);
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
  if (!(await requireVoiceConnection(interaction))) return;

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
      {
        name: 'Duration',
        value: `${formatTime(position)} / ${formatTime(track.duration)}`,
        inline: true
      },
      { name: 'Requested by', value: track.requestedBy || 'Unknown', inline: true },
      { name: 'Progress', value: progress }
    );

  if (track.thumbnail) {
    embed.setThumbnail(track.thumbnail);
  }

  await interaction.reply({ embeds: [embed] });
}

export async function handleRemove(interaction) {
  if (!(await requireVoiceConnection(interaction))) return;

  const position = interaction.options.getInteger('position') - 1; // Convert to 0-based
  const q = getQueue();

  if (position < 0 || position >= q.length) {
    return interaction.reply({
      content: 'Invalid position.',
      ephemeral: true
    });
  }

  // Read the track BEFORE removing it, or there is nothing left to record.
  const removedTrack = captureTrack(() => q.getAll()[position]);

  const removed = q.remove(position);
  musicManager.emitQueueUpdate();

  emitAction(STATS_EVENT_TYPES.REMOVE, interaction.user, removedTrack || removed);

  await interaction.reply(`Removed **${removed.title}** from the queue.`);
}

export async function handleShuffle(interaction) {
  if (!(await requireVoiceConnection(interaction))) return;

  const q = getQueue();

  if (q.length < 2) {
    return interaction.reply({
      content: 'Not enough tracks to shuffle.',
      ephemeral: true
    });
  }

  q.shuffle();
  musicManager.emitQueueUpdate();

  // Acts on the queue as a whole, so no track is recorded.
  emitAction(STATS_EVENT_TYPES.SHUFFLE, interaction.user, null);

  await interaction.reply('Shuffled the queue.');
}

export async function handleClear(interaction) {
  if (!(await requireVoiceConnection(interaction))) return;

  const q = getQueue();
  const current = q.getCurrent();
  const clearedCount = Math.max(0, q.getAll().length - (current ? 1 : 0));

  // Clear all except current, through the mediator so a DJ line in progress
  // is cancelled the same way on every transport (FR-009).
  musicManager.clearAllButCurrent();

  // The only clear_queue emit on the Discord surface — handleStop deliberately
  // records nothing even though it also empties the queue. This variant keeps the
  // current track, where HTTP empties everything and realtime drops only the
  // upcoming tracks; the variant is what keeps those three distinguishable.
  emitAction(STATS_EVENT_TYPES.CLEAR_QUEUE, interaction.user, null, {
    variant: 'all_but_current',
    clearedCount
  });

  await interaction.reply('Cleared the queue.');
}

function createProgressBar(current, total) {
  const length = 20;
  const progress = Math.round((current / total) * length);
  const empty = length - progress;
  return '▓'.repeat(progress) + '░'.repeat(empty);
}
