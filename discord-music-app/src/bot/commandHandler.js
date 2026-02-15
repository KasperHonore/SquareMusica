import { client } from './client.js';

const commandHandlers = new Map();

export function registerCommand(name, handler) {
  commandHandlers.set(name, handler);
}

export function setupCommandHandler() {
  client.on('interactionCreate', async (interaction) => {
    if (!interaction.isChatInputCommand()) return;

    const handler = commandHandlers.get(interaction.commandName);
    if (!handler) {
      console.warn(`No handler for command: ${interaction.commandName}`);
      return;
    }

    try {
      await handler(interaction);
    } catch (error) {
      console.error(`Error handling command ${interaction.commandName}:`, error);
      const reply = {
        content: 'There was an error executing this command.',
        ephemeral: true
      };
      if (interaction.replied || interaction.deferred) {
        await interaction.followUp(reply);
      } else {
        await interaction.reply(reply);
      }
    }
  });
}
