import { Client, GatewayIntentBits, Collection } from 'discord.js';

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildMessages
  ]
});

client.commands = new Collection();

client.once('ready', () => {
  console.log(`Ready! Logged in as ${client.user.tag}`);
  console.log(`Bot is in ${client.guilds.cache.size} guilds:`);
  client.guilds.cache.forEach(g => console.log(`  - ${g.name} (${g.id})`));
});

client.on('error', (error) => {
  console.error('Discord client error:', error);
});

export { client };
