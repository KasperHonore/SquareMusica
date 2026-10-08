import 'dotenv/config';
import { validateEnv } from '../../../config/env.js';
import { REST, Routes, SlashCommandBuilder } from 'discord.js';
import { logger } from '../../../utils/logger.js';

validateEnv(['DISCORD_TOKEN', 'APP_ID']);

const commands = [
  // Voice commands
  new SlashCommandBuilder().setName('join').setDescription('Join your voice channel'),

  new SlashCommandBuilder().setName('leave').setDescription('Leave the voice channel'),

  // Playback commands
  new SlashCommandBuilder()
    .setName('play')
    .setDescription('Play a song from YouTube or Spotify')
    .addStringOption((option) =>
      option
        .setName('query')
        .setDescription('YouTube/Spotify URL or search query')
        .setRequired(true)
    ),

  new SlashCommandBuilder().setName('pause').setDescription('Pause playback'),

  new SlashCommandBuilder().setName('resume').setDescription('Resume playback'),

  new SlashCommandBuilder().setName('skip').setDescription('Skip to the next track'),

  new SlashCommandBuilder().setName('stop').setDescription('Stop playback and clear the queue'),

  // Queue commands
  new SlashCommandBuilder().setName('queue').setDescription('View the current queue'),

  new SlashCommandBuilder()
    .setName('nowplaying')
    .setDescription('Show the currently playing track'),

  new SlashCommandBuilder()
    .setName('remove')
    .setDescription('Remove a track from the queue')
    .addIntegerOption((option) =>
      option
        .setName('position')
        .setDescription('Position in queue (1-based)')
        .setRequired(true)
        .setMinValue(1)
    ),

  new SlashCommandBuilder().setName('shuffle').setDescription('Shuffle the queue'),

  new SlashCommandBuilder().setName('clear').setDescription('Clear the queue'),

  // Settings commands
  new SlashCommandBuilder()
    .setName('loop')
    .setDescription('Set loop mode')
    .addStringOption((option) =>
      option
        .setName('mode')
        .setDescription('Loop mode')
        .setRequired(true)
        .addChoices(
          { name: 'Off', value: 'off' },
          { name: 'Track', value: 'track' },
          { name: 'Queue', value: 'queue' }
        )
    ),

  // Utility commands
  new SlashCommandBuilder()
    .setName('webui')
    .setDescription('Get the link to the web control panel'),

  // AI DJ
  new SlashCommandBuilder()
    .setName('dj')
    .setDescription('Control the AI DJ')
    .addSubcommand((sub) => sub.setName('status').setDescription('Show the DJ settings and limits'))
    .addSubcommand((sub) => sub.setName('on').setDescription('Turn the DJ on'))
    .addSubcommand((sub) => sub.setName('off').setDescription('Turn the DJ off'))
    .addSubcommand((sub) =>
      sub
        .setName('interval')
        .setDescription('How often the DJ speaks')
        .addIntegerOption((option) =>
          option
            .setName('every')
            .setDescription('Speak every N tracks (1-10)')
            .setRequired(true)
            .setMinValue(1)
            .setMaxValue(10)
        )
    )
    .addSubcommand((sub) =>
      sub
        .setName('lookahead')
        .setDescription('How many themed tracks to keep queued ahead')
        .addIntegerOption((option) =>
          option
            .setName('size')
            .setDescription('Tracks queued ahead')
            .setRequired(true)
            .addChoices({ name: '5', value: 5 }, { name: '10', value: 10 })
        )
    )
];

const rest = new REST().setToken(process.env.DISCORD_TOKEN);

async function register() {
  try {
    logger.info('Registering slash commands...');

    // Register globally - works on all servers
    await rest.put(Routes.applicationCommands(process.env.APP_ID), {
      body: commands.map((c) => c.toJSON())
    });
    logger.info(`Registered ${commands.length} commands globally`);
  } catch (error) {
    logger.error('Failed to register commands:', error);
  }
}

register();
