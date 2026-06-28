import { getConnection, setChannelCache } from '../voiceManager.js';
import { requireVoiceConnection } from './utils/checks.js';
import { musicManager } from '../../../core/musicManager.js';
import { resolveQuery, tryPlayWithFallback } from '../../../services/trackResolver.js';
import { resolutionManager } from '../../../services/resolutionManager.js';
import { advanceAndPlay, getPlayer, getQueue } from '../../../services/playback.js';
import { addTracksToQueue, resolveQueryErrorToMessage } from '../../../shared/queueHelpers.js';

export async function handlePlay(interaction) {
  const member = interaction.member;
  const voiceChannel = member.voice?.channel;
  const query = interaction.options.getString('query');

  if (!voiceChannel) {
    return interaction.reply({
      content: 'You need to be in a voice channel!',
      ephemeral: true
    });
  }

  await interaction.deferReply();

  try {
    const p = getPlayer();
    const q = getQueue();

    const userInfo = {
      username: interaction.user.username,
      id: interaction.user.id,
      avatar: interaction.user.avatar
    };

    // Resolve query to tracks
    const { tracks: rawTracks, error } = await resolveQuery(query, userInfo);

    if (error) {
      return interaction.editReply(resolveQueryErrorToMessage(error, 'Failed to process query.'));
    }

    const { tracks, lazyResolution } = addTracksToQueue({
      musicManager,
      resolutionManager,
      queue: q,
      currentIndex: q.currentIndex,
      rawTracks,
      userInfo
    });

    // Get or create voice connection
    let connection = getConnection(interaction.guildId);
    if (!connection) {
      const { joinChannel } = await import('../voiceManager.js');
      connection = await joinChannel(voiceChannel);
      musicManager.setGuildId(interaction.guildId);
      setChannelCache(interaction.guildId, voiceChannel);
      musicManager.emitVoiceContext();
      musicManager.emitState();
    }

    // Start playing if not already
    if (!p.isPlaying() && !p.isPaused()) {
      const { played } = await tryPlayWithFallback(p, q, connection);
      if (!played && q.length > 0) {
        musicManager.emit('track:change', null);
        musicManager.emitState();
      }
    }

    if (tracks.length === 1) {
      const position = q.length;
      if (p.isPlaying() && position > 1) {
        await interaction.editReply(`Added **${tracks[0].title}** to queue (position ${position})`);
      } else {
        await interaction.editReply(`Now playing: **${tracks[0].title}**`);
      }
    } else {
      let message = `Added ${tracks.length} tracks to queue`;
      if (lazyResolution) {
        message += ' (resolving YouTube URLs in background...)';
      }
      await interaction.editReply(message);
    }
  } catch (error) {
    console.error('Play error:', error);
    await interaction.editReply('Failed to play track.');
  }
}

export async function handlePause(interaction) {
  if (!(await requireVoiceConnection(interaction))) return;

  const p = getPlayer();

  if (!p.isPlaying()) {
    return interaction.reply({
      content: 'Nothing is playing!',
      ephemeral: true
    });
  }

  p.pause();
  await interaction.reply('Paused playback.');
}

export async function handleResume(interaction) {
  if (!(await requireVoiceConnection(interaction))) return;

  const p = getPlayer();

  if (!p.isPaused()) {
    return interaction.reply({
      content: 'Playback is not paused!',
      ephemeral: true
    });
  }

  p.resume();
  await interaction.reply('Resumed playback.');
}

export async function handleSkip(interaction) {
  if (!(await requireVoiceConnection(interaction))) return;

  const p = getPlayer();
  const q = getQueue();
  const connection = getConnection(interaction.guildId);

  if (!p.currentTrack) {
    return interaction.reply({
      content: 'Nothing is playing!',
      ephemeral: true
    });
  }

  const skipped = p.currentTrack.title;

  const { played, track: playingTrack } = await advanceAndPlay({
    player: p,
    queue: q,
    connection,
    skipCurrent: true
  });

  if (played) {
    await interaction.reply(`Skipped **${skipped}**. Now playing: **${playingTrack.title}**`);
  } else {
    await interaction.reply(`Skipped **${skipped}**. Queue is empty.`);
  }
}

export async function handleStop(interaction) {
  if (!(await requireVoiceConnection(interaction))) return;

  const p = getPlayer();
  const q = getQueue();

  p.stop();
  q.clear();
  musicManager.emitQueueUpdate();
  musicManager.emit('track:change', null);

  await interaction.reply('Stopped playback and cleared the queue.');
}
