import { registerCommand } from '../commandHandler.js';
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
import { handleWebUI } from './utility.js';

export function registerAllCommands() {
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

  // Utility
  registerCommand('webui', handleWebUI);

  console.log('All commands registered');
}
