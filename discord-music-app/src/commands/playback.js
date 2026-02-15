import { getConnection } from '../bot/voiceManager.js';
import { requireVoiceConnection } from './utils/checks.js';
import { musicManager } from '../state/musicManager.js';
import { MusicPlayer } from '../music/player.js';
import { Queue } from '../music/queue.js';
import { search, getInfo, isValidUrl, isPlaylist, getPlaylist } from '../music/youtube.js';

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
          await player.play(next, connection);
        }
      }
      musicManager.emit('queue:update', queue?.getAll() || []);
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

    if (isPlaylist(query)) {
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

    // Add requestedBy
    tracks = tracks.map(t => ({
      ...t,
      requestedBy: interaction.user.username
    }));

    // Add to queue
    tracks.forEach(t => q.add(t));
    musicManager.emit('queue:update', q.getAll());

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
        await p.play(track, connection);
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
      await interaction.editReply(`Added ${tracks.length} tracks to queue`);
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
  const next = q.next();

  if (next && connection) {
    await p.play(next, connection);
    await interaction.reply(`Skipped **${skipped}**. Now playing: **${next.title}**`);
  } else {
    p.stop();
    await interaction.reply(`Skipped **${skipped}**. Queue is empty.`);
  }

  musicManager.emit('queue:update', q.getAll());
}

export async function handleStop(interaction) {
  if (!await requireVoiceConnection(interaction)) return;

  const p = getPlayer();
  const q = getQueue();

  p.stop();
  q.clear();
  musicManager.emit('queue:update', []);
  musicManager.emit('track:change', null);

  await interaction.reply('Stopped playback and cleared the queue.');
}
