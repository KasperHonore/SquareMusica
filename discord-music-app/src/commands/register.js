import 'dotenv/config';
import { REST, Routes, SlashCommandBuilder } from 'discord.js';

const commands = [
  // Voice commands
  new SlashCommandBuilder()
    .setName('join')
    .setDescription('Join your voice channel'),

  new SlashCommandBuilder()
    .setName('leave')
    .setDescription('Leave the voice channel'),

  // Playback commands
  new SlashCommandBuilder()
    .setName('play')
    .setDescription('Play a song from YouTube or Spotify')
    .addStringOption(option =>
      option.setName('query')
        .setDescription('YouTube/Spotify URL or search query')
        .setRequired(true)),

  new SlashCommandBuilder()
    .setName('pause')
    .setDescription('Pause playback'),

  new SlashCommandBuilder()
    .setName('resume')
    .setDescription('Resume playback'),

  new SlashCommandBuilder()
    .setName('skip')
    .setDescription('Skip to the next track'),

  new SlashCommandBuilder()
    .setName('stop')
    .setDescription('Stop playback and clear the queue'),

  // Queue commands
  new SlashCommandBuilder()
    .setName('queue')
    .setDescription('View the current queue'),

  new SlashCommandBuilder()
    .setName('nowplaying')
    .setDescription('Show the currently playing track'),

  new SlashCommandBuilder()
    .setName('remove')
    .setDescription('Remove a track from the queue')
    .addIntegerOption(option =>
      option.setName('position')
        .setDescription('Position in queue (1-based)')
        .setRequired(true)
        .setMinValue(1)),

  new SlashCommandBuilder()
    .setName('shuffle')
    .setDescription('Shuffle the queue'),

  new SlashCommandBuilder()
    .setName('clear')
    .setDescription('Clear the queue'),

  // Settings commands
  new SlashCommandBuilder()
    .setName('volume')
    .setDescription('Set playback volume')
    .addIntegerOption(option =>
      option.setName('level')
        .setDescription('Volume level (0-100)')
        .setRequired(true)
        .setMinValue(0)
        .setMaxValue(100)),

  new SlashCommandBuilder()
    .setName('loop')
    .setDescription('Set loop mode')
    .addStringOption(option =>
      option.setName('mode')
        .setDescription('Loop mode')
        .setRequired(true)
        .addChoices(
          { name: 'Off', value: 'off' },
          { name: 'Track', value: 'track' },
          { name: 'Queue', value: 'queue' }
        )),

  // Utility commands
  new SlashCommandBuilder()
    .setName('webui')
    .setDescription('Get the link to the web control panel'),
];

const rest = new REST().setToken(process.env.DISCORD_TOKEN);

async function register() {
  try {
    console.log('Registering slash commands...');

    if (process.env.GUILD_ID) {
      // Register to specific guild (faster for development)
      await rest.put(
        Routes.applicationGuildCommands(process.env.APP_ID, process.env.GUILD_ID),
        { body: commands.map(c => c.toJSON()) }
      );
      console.log(`Registered ${commands.length} commands to guild ${process.env.GUILD_ID}`);
    } else {
      // Register globally
      await rest.put(
        Routes.applicationCommands(process.env.APP_ID),
        { body: commands.map(c => c.toJSON()) }
      );
      console.log(`Registered ${commands.length} commands globally`);
    }
  } catch (error) {
    console.error('Failed to register commands:', error);
  }
}

register();
