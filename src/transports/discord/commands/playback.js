import { getConnection, setChannelCache } from '../voiceManager.js';
import { requireVoiceConnection } from './utils/checks.js';
import { musicManager } from '../../../core/musicManager.js';
import { resolveQuery, tryPlayWithFallback } from '../../../services/trackResolver.js';
import { resolutionManager } from '../../../services/resolutionManager.js';
import { advanceAndPlay, getPlayer, getQueue } from '../../../services/playback.js';
import { botEvents } from '../../../events/bus.js';
import {
  STATS_EVENT,
  STATS_EVENT_TYPES,
  createStatsEvent,
  captureTrack
} from '../../../shared/statsEvents.js';
import { logger } from '../../../utils/logger.js';
import {
  addTracksToQueue,
  resolveQueryErrorToMessage,
  formatTruncationNotice
} from '../../../shared/queueHelpers.js';

/**
 * Emit one recorded action on the shared bus.
 *
 * These handlers reach getPlayer()/advanceAndPlay() directly rather than going
 * through musicManager, which is exactly why Discord needs its own emit sites:
 * instrumenting the mediator alone would miss every action taken from Discord.
 *
 * Wrapped so a recording failure cannot break the command: bus listeners run
 * synchronously, in this handler's stack.
 */
function emitAction(type, user, track, metadata = null) {
  try {
    botEvents.emit(STATS_EVENT, createStatsEvent({ type, actor: user, track, metadata }));
  } catch {
    // Deliberately silent; the recorder logs its own failures.
  }
}

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
    const { tracks: rawTracks, error, truncation } = await resolveQuery(query, userInfo);

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
      const truncationNotice = formatTruncationNotice(truncation);
      let message = truncationNotice || `Added ${tracks.length} tracks to queue`;
      if (lazyResolution) {
        message += ' (resolving YouTube URLs in background...)';
      }
      await interaction.editReply(message);
    }
  } catch (error) {
    logger.error('Play error:', error);
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
  // musicManager is imported here already, so the current track is reachable even
  // though this handler otherwise bypasses the mediator.
  emitAction(
    STATS_EVENT_TYPES.PAUSE,
    interaction.user,
    captureTrack(() => musicManager.getCurrentTrack())
  );
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
  emitAction(
    STATS_EVENT_TYPES.RESUME,
    interaction.user,
    captureTrack(() => musicManager.getCurrentTrack())
  );
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

  // Captured BEFORE advanceAndPlay moves the queue on, or the recorded track is
  // the one that came next rather than the one skipped.
  const skippedTrack = captureTrack(() => p.currentTrack);

  const { played, track: playingTrack } = await advanceAndPlay({
    player: p,
    queue: q,
    connection,
    skipCurrent: true
  });

  emitAction(STATS_EVENT_TYPES.SKIP, interaction.user, skippedTrack);

  if (played) {
    await interaction.reply(`Skipped **${skipped}**. Now playing: **${playingTrack.title}**`);
  } else {
    await interaction.reply(`Skipped **${skipped}**. Queue is empty.`);
  }
}

export async function handleStop(interaction) {
  if (!(await requireVoiceConnection(interaction))) return;

  // Deliberately records nothing. This does empty the queue, so emitting
  // clear_queue here looks like closing a gap — it is not. `stop` is not one of
  // the tracked actions, and HTTP's and realtime's stop paths (both
  // musicManager.stop(), which also clears) record nothing either. Emitting only
  // here would make Discord the one surface that records a stop, which is a
  // parity violation rather than a fix for one. Discord's clear_queue comes from
  // handleClear alone.
  // Through the mediator, like HTTP and realtime, so a stop ends themed mode
  // the same way on every surface (FR-024b).
  musicManager.stop();

  await interaction.reply('Stopped playback and cleared the queue.');
}
