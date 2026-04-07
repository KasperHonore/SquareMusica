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
  const member = newState.member || oldState.member;
  const isBot = member?.user?.bot || false;
  const isSelf = member?.user?.id === client.user?.id;
  console.log(`[Bot] VoiceStateUpdate: user=${member?.user?.username} isBot=${isBot} isSelf=${isSelf} oldChannel=${oldState.channelId} newChannel=${newState.channelId}`);

  const botChannel = getChannelCache(guildId);

  if (!botChannel) {
    console.log(`[Bot] VoiceStateUpdate: no botChannel cached, ignoring`);
    return;
  }

  // Check if this event involves the bot's channel
  const leftBotChannel = oldState.channelId === botChannel.id;
  const joinedBotChannel = newState.channelId === botChannel.id;

  if (!leftBotChannel && !joinedBotChannel) return;

  // Prefer cached channel membership to avoid REST calls on frequent voice events.
  const humanMembers = botChannel.members?.filter(m => !m.user.bot).size;

  if (typeof humanMembers === 'number') {
    console.log(`[Bot] VoiceStateUpdate: humanMembers=${humanMembers} in channel ${botChannel.name}`);

      if (humanMembers === 0) {
        console.log(`[Bot] VoiceStateUpdate: no humans left, starting inactivity timer`);
        startInactivityTimer(guildId, () => {
          console.log(`[Bot] Inactivity timer fired, leaving channel`);
          leaveChannel(guildId);
          setChannelCache(guildId, null);
          musicManager.stop();
          musicManager.emitVoiceContext();
          musicManager.emitState();
        });
      } else {
        cancelInactivityTimer(guildId);
      }
    return;
  }

  // Fallback: if cache is missing (partial channel), do a single fetch and ignore errors.
  botChannel.fetch()
    .then(channel => {
      const fetchedHumanMembers = channel.members.filter(m => !m.user.bot).size;
      console.log(`[Bot] VoiceStateUpdate(fetch): humanMembers=${fetchedHumanMembers} in channel ${channel.name}`);

      if (fetchedHumanMembers === 0) {
        console.log(`[Bot] VoiceStateUpdate(fetch): no humans left, starting inactivity timer`);
        startInactivityTimer(guildId, () => {
          console.log(`[Bot] Inactivity timer fired, leaving channel`);
          leaveChannel(guildId);
          setChannelCache(guildId, null);
          musicManager.stop();
          musicManager.emitVoiceContext();
          musicManager.emitState();
        });
      } else {
        cancelInactivityTimer(guildId);
      }
    })
    .catch((error) => {
      console.error('[Bot] VoiceStateUpdate: failed to fetch channel:', error);
    });
});

botEvents.on('voiceDisconnected', (guildId) => {
  console.log(`[Bot] *** voiceDisconnected event *** guild=${guildId}`, new Error().stack.split('\n').slice(1, 5).join(' <- '));
  setChannelCache(guildId, null);
  cancelInactivityTimer(guildId);
  musicManager.stop();
  musicManager.emitVoiceContext();
  musicManager.emitState();
});

export function getBotInfo() {
  if (!client.user) return null;
  return {
    name: client.user.username,
    avatarUrl: client.user.displayAvatarURL({ size: 64 })
  };
}

export { client };
