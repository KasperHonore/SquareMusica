import { getConnection } from '../bot/voiceManager.js';
import { requireVoiceConnection } from './utils/checks.js';
import { musicManager } from '../state/musicManager.js';
import { MusicPlayer } from '../music/player.js';
import { Queue } from '../music/queue.js';
import { search, getInfo, isValidUrl, isPlaylist, getPlaylist } from '../music/youtube.js';
import { parseSpotifyUrl, getPublicTrack, getPublicPlaylistTracks } from '../music/spotify.js';
import { resolveSpotifyTrack, resolveSpotifyTracks } from '../music/resolver.js';
import { resolutionManager, ResolutionManager } from '../music/resolutionManager.js';

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
        if (connection) {
          const success = await player.play(next, connection);
          // If track failed to resolve, try next tracks
          if (!success) {
            let nextTrack = queue?.next();
            while (nextTrack) {
              const nextSuccess = await player.play(nextTrack, connection);
              if (nextSuccess) break;
              nextTrack = queue?.next();
            }
          }
          // Trigger lookahead resolution after advancing
          resolutionManager.processLookahead(queue?.currentIndex || 0).catch(err => {
            console.error('Lookahead resolution error:', err);
          });
        }
      } else {
        // No more tracks - notify UI that nothing is playing
        musicManager.emit('track:change', null);
      }
      musicManager.emitQueueUpdate();
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

    let tracks = [];
    let skippedTracks = [];

    // User info for requestedBy
    const userInfo = {
      username: interaction.user.username,
      id: interaction.user.id,
      avatar: interaction.user.avatar
    };

    // Check for Spotify URL first
    const spotifyParsed = parseSpotifyUrl(query);

    if (spotifyParsed.type === 'playlist') {
      // Handle Spotify playlist - add tracks immediately without resolution
      const spotifyTracks = await getPublicPlaylistTracks(spotifyParsed.id);
      if (spotifyTracks.length === 0) {
        return interaction.editReply('Could not load Spotify playlist or playlist is empty.');
      }

      // Convert to unresolved queue tracks (lazy resolution)
      tracks = spotifyTracks.map(st =>
        ResolutionManager.createUnresolvedTrack(st, userInfo)
      );

      // Tracks will be resolved lazily by the resolution manager
      // No skippedTracks at add time - failures happen during resolution
    } else if (spotifyParsed.type === 'track') {
      // Handle Spotify track
      const spotifyTrack = await getPublicTrack(spotifyParsed.id);
      if (!spotifyTrack) {
        return interaction.editReply('Could not find that Spotify track.');
      }

      const youtubeTrack = await resolveSpotifyTrack(spotifyTrack);
      if (!youtubeTrack) {
        return interaction.editReply(`Could not find "${spotifyTrack.title}" on YouTube.`);
      }
      tracks = [youtubeTrack];
    } else if (isPlaylist(query)) {
      tracks = await getPlaylist(query);
      if (tracks.length === 0) {
        return interaction.editReply('Could not load playlist.');
      }
    } else if (isValidUrl(query)) {
      const track = await getInfo(query);
      if (!track) {
        return interaction.editReply('Could not find that video.');
      }
      tracks = [track];
    } else {
      const results = await search(query, 1);
      if (results.length === 0) {
        return interaction.editReply('No results found.');
      }
      tracks = [results[0]];
    }

    // Add requestedBy with full user info
    tracks = tracks.map(t => ({
      ...t,
      requestedBy: userInfo.username,
      requestedById: userInfo.id,
      requestedByAvatar: userInfo.avatar
    }));

    // Add to queue
    tracks.forEach(t => q.add(t));
    musicManager.emitQueueUpdate();

    // Trigger lookahead resolution for Spotify playlists (non-blocking)
    const hasUnresolvedTracks = tracks.some(t => t.status === 'unresolved');
    if (hasUnresolvedTracks) {
      // Start resolution manager if not already running
      resolutionManager.setQueue(q);
      resolutionManager.start();
      // Process lookahead immediately (non-blocking)
      resolutionManager.processLookahead(q.currentIndex).catch(err => {
        console.error('Lookahead resolution error:', err);
      });
    }

    // Get or create voice connection
    let connection = getConnection(interaction.guildId);
    if (!connection) {
      const { joinChannel } = await import('../bot/voiceManager.js');
      connection = await joinChannel(voiceChannel);
      musicManager.setGuildId(interaction.guildId);
    }

    // Start playing if not already
    if (!p.isPlaying() && !p.isPaused()) {
      const track = q.getCurrent();
      if (track) {
        const success = await p.play(track, connection);
        // If first track failed to resolve, try next tracks
        if (!success) {
          let nextTrack = q.next();
          while (nextTrack) {
            const nextSuccess = await p.play(nextTrack, connection);
            if (nextSuccess) break;
            nextTrack = q.next();
          }
        }
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
      if (hasUnresolvedTracks) {
        message += ' (resolving YouTube URLs in background...)';
      } else if (skippedTracks.length > 0) {
        message += ` (${skippedTracks.length} tracks could not be found on YouTube)`;
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
  let next = q.next();
  let playingTrack = null;

  // Try to find a playable track (skip failed resolution tracks)
  while (next && connection) {
    const success = await p.play(next, connection);
    if (success) {
      playingTrack = next;
      break;
    }
    next = q.next();
  }

  if (playingTrack) {
    await interaction.reply(`Skipped **${skipped}**. Now playing: **${playingTrack.title}**`);
    // Trigger lookahead resolution after skipping
    resolutionManager.processLookahead(q.currentIndex).catch(err => {
      console.error('Lookahead resolution error:', err);
    });
  } else {
    p.stop();
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
