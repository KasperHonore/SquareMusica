import { Client, GatewayIntentBits, Events } from 'discord.js';
import { EventEmitter } from 'events';
import { db } from '../database/db.js';

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

export { client };
