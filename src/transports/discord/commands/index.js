import { registerCommand } from '../commandHandler.js';
import { logger } from '../../../utils/logger.js';
import { handleJoin, handleLeave } from './voice.js';
import { handlePlay, handlePause, handleResume, handleSkip, handleStop } from './playback.js';
import {
  handleQueue,
  handleNowPlaying,
  handleRemove,
  handleShuffle,
  handleClear
} from './queue.js';
import { handleLoop } from './settings.js';
import { handleDj, setDiscordClient } from './dj.js';
import { handleWebUI } from './utility.js';

/**
 * @param {import('discord.js').Client} [client] - Lets commands that post
 *   unprompted (DJ stall notices) reach channels before any interaction
 */
export function registerAllCommands(client) {
  if (client) setDiscordClient(client);

  // Voice
  registerCommand('join', handleJoin);
  registerCommand('leave', handleLeave);

  // Playback
  registerCommand('play', handlePlay);
  registerCommand('pause', handlePause);
  registerCommand('resume', handleResume);
  registerCommand('skip', handleSkip);
  registerCommand('stop', handleStop);

  // Queue
  registerCommand('queue', handleQueue);
  registerCommand('nowplaying', handleNowPlaying);
  registerCommand('remove', handleRemove);
  registerCommand('shuffle', handleShuffle);
  registerCommand('clear', handleClear);

  // Settings
  registerCommand('loop', handleLoop);
  registerCommand('dj', handleDj);

  // Utility
  registerCommand('webui', handleWebUI);

  logger.info('All commands registered');
}
