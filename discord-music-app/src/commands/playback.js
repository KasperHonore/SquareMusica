import { getConnection, setChannelCache } from '../bot/voiceManager.js';
import { requireVoiceConnection } from './utils/checks.js';
import { musicManager } from '../state/musicManager.js';
import { MusicPlayer } from '../music/player.js';
import { Queue } from '../music/queue.js';
import { resolveQuery, tryPlayWithFallback } from '../music/trackResolver.js';
import { resolutionManager } from '../music/resolutionManager.js';
import { addTracksToQueue, resolveQueryErrorToMessage } from '../shared/queueHelpers.js';

// Singleton instances
let player = null;
let queue = null;

export function getPlayer() {
  if (!player) {
    player = new MusicPlayer();
    musicManager.setPlayer(player);
    musicManager.setGetConnection(getConnection);

    // Auto-play next track
    player.on('trackEnd', () => {
      void (async () => {
        try {
          const connection = getConnection(musicManager.guildId);
          const { played } = await tryPlayWithFallback(player, queue, connection, true);

          if (played) {
            resolutionManager.processLookahead(queue?.currentIndex || 0).catch((err) => {
              console.error('Lookahead resolution error:', err);
            });
            musicManager.emitQueueUpdate();
          } else {
            console.log('[TrackEnd] No more playable tracks');
            resolutionManager.stop();
            resolutionManager.processingTracks.clear();
            musicManager.emit('queue:update', { tracks: [], currentIndex: 0 });
            musicManager.emit('track:change', null);
            musicManager.emitState();
          }
        } catch (error) {
          console.error('[TrackEnd] Failed to autoplay next track:', error);
        }
      })();
    });

    // Handle failed tracks (skip to next)
    player.on('trackFailed', async (failedTrack) => {
      console.warn('Track failed, skipping:', failedTrack.title);
      musicManager.emitQueueUpdate();
    });

    // Catch player errors so they don't become uncaught exceptions
    player.on('error', (error) => {
      console.error('[Player] MusicPlayer error:', error.message);
    });
  }
  return player;
}

export function getQueue() {
  if (!queue) {
    queue = new Queue();
    musicManager.setQueue(queue);
  }
  return queue;
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
      const { joinChannel } = await import('../bot/voiceManager.js');
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

  const { played, track: playingTrack } = await tryPlayWithFallback(p, q, connection, true);

  if (played) {
    await interaction.reply(`Skipped **${skipped}**. Now playing: **${playingTrack.title}**`);
    resolutionManager.processLookahead(q.currentIndex).catch((err) => {
      console.error('Lookahead resolution error:', err);
    });
  } else {
    p.stop();
    musicManager.emit('track:change', null);
    musicManager.emitState();
    await interaction.reply(`Skipped **${skipped}**. Queue is empty.`);
  }

  musicManager.emitQueueUpdate();
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
