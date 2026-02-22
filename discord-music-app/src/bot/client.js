import { Client, GatewayIntentBits, Events } from 'discord.js';
import { EventEmitter } from 'events';
import { db } from '../database/db.js';
import { leaveChannel, setChannelCache, getChannelCache } from './voiceManager.js';
import { startInactivityTimer, cancelInactivityTimer } from './inactivityManager.js';
import { musicManager } from '../state/musicManager.js';

// Event bus for cross-module communication
export const botEvents = new EventEmitter();

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildMessages
  ]
});

client.once('ready', () => {
  console.log(`Ready! Logged in as ${client.user.tag}`);
  console.log(`Bot is in ${client.guilds.cache.size} guilds:`);
  client.guilds.cache.forEach(g => console.log(`  - ${g.name} (${g.id})`));
});

client.on(Events.GuildDelete, (guild) => {
  console.log(`[Bot] *** GUILD DELETE EVENT *** Left guild: ${guild.name} (${guild.id})`);
  const cleared = db.clearAllHistory();
  console.log(`[Bot] Cleared ${cleared} history records`);
  botEvents.emit('historyCleared', guild.id);
  console.log(`[Bot] Emitted historyCleared event`);
});

client.on('error', (error) => {
  console.error('Discord client error:', error);
});

client.on(Events.VoiceStateUpdate, (oldState, newState) => {
  const guildId = oldState.guild.id || newState.guild.id;
  const botChannel = getChannelCache(guildId);

  if (!botChannel) return; // Bot not in a channel

  // Check if this event involves the bot's channel
  const leftBotChannel = oldState.channelId === botChannel.id;
  const joinedBotChannel = newState.channelId === botChannel.id;

  if (!leftBotChannel && !joinedBotChannel) return;

  // Refetch channel to get current members
  botChannel.fetch().then(channel => {
    const humanMembers = channel.members.filter(m => !m.user.bot).size;

    if (humanMembers === 0) {
      startInactivityTimer(guildId, () => {
        leaveChannel(guildId);
        setChannelCache(guildId, null);
        musicManager.stop();
        musicManager.emitVoiceContext();
      });
    } else {
      cancelInactivityTimer(guildId);
    }
  });
});

export function getBotInfo() {
  if (!client.user) return null;
  return {
    name: client.user.username,
    avatarUrl: client.user.displayAvatarURL({ size: 64 })
  };
}

export { client };
