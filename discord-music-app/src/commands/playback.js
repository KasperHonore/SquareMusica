import { getConnection } from '../bot/voiceManager.js';
import { requireVoiceConnection } from './utils/checks.js';
import { musicManager } from '../state/musicManager.js';
import { MusicPlayer } from '../music/player.js';
import { Queue } from '../music/queue.js';
import { resolveQuery, enrichWithUserInfo, triggerLookaheadIfNeeded, tryPlayWithFallback } from '../music/trackResolver.js';
import { resolutionManager } from '../music/resolutionManager.js';

// Singleton instances
let player = null;
let queue = null;

export function getPlayer() {
  if (!player) {
    player = new MusicPlayer();
    musicManager.setPlayer(player);
    musicManager.setGetConnection(getConnection);

    // Auto-play next track
    player.on('trackEnd', async () => {
      const next = queue?.next();

      if (next) {
        const connection = getConnection(musicManager.guildId);
        const { played } = await tryPlayWithFallback(player, queue, connection);

        if (played) {
          resolutionManager.processLookahead(queue?.currentIndex || 0).catch(err => {
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
      } else {
        console.log('[TrackEnd] No more playable tracks');
        resolutionManager.stop();
        resolutionManager.processingTracks.clear();
        musicManager.emit('queue:update', { tracks: [], currentIndex: 0 });
        musicManager.emit('track:change', null);
        musicManager.emitState();
      }
    });

    // Handle failed tracks (skip to next)
    player.on('trackFailed', async (failedTrack) => {
      console.warn('Track failed, skipping:', failedTrack.title);
      musicManager.emitQueueUpdate();
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
      const messages = {
        SPOTIFY_PLAYLIST_EMPTY: 'Could not load Spotify playlist or playlist is empty.',
        SPOTIFY_TRACK_NOT_FOUND: 'Could not find that Spotify track.',
        SPOTIFY_ALBUM_EMPTY: 'Could not load Spotify album or album is empty.',
        PLAYLIST_EMPTY: 'Could not load playlist.',
        VIDEO_NOT_FOUND: 'Could not find that video.',
        NO_RESULTS: 'No results found.'
      };
      return interaction.editReply(messages[error] || 'Failed to process query.');
    }

    // Add user info to non-Spotify tracks (Spotify tracks already have it from createUnresolvedTrack)
    let tracks = enrichWithUserInfo(rawTracks, userInfo);

    // Add to queue using musicManager facade
    tracks.forEach(t => musicManager.addToQueue(t));

    // Trigger lookahead resolution if needed
    const hasUnresolved = triggerLookaheadIfNeeded(tracks, resolutionManager, q, q.currentIndex);

    // Get or create voice connection
    let connection = getConnection(interaction.guildId);
    if (!connection) {
      const { joinChannel } = await import('../bot/voiceManager.js');
      connection = await joinChannel(voiceChannel);
      musicManager.setGuildId(interaction.guildId);
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
      if (hasUnresolved) {
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
  if (!await requireVoiceConnection(interaction)) return;

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
  if (!await requireVoiceConnection(interaction)) return;

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
  if (!await requireVoiceConnection(interaction)) return;

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
  q.next(); // Advance the queue

  const { played, track: playingTrack } = await tryPlayWithFallback(p, q, connection);

  if (played) {
    await interaction.reply(`Skipped **${skipped}**. Now playing: **${playingTrack.title}**`);
    resolutionManager.processLookahead(q.currentIndex).catch(err => {
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
  if (!await requireVoiceConnection(interaction)) return;

  const p = getPlayer();
  const q = getQueue();

  p.stop();
  q.clear();
  musicManager.emitQueueUpdate();
  musicManager.emit('track:change', null);

  await interaction.reply('Stopped playback and cleared the queue.');
}
