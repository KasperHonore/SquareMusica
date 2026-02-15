import 'dotenv/config';
import { createServer } from 'http';
import { app } from './api/index.js';
import { client } from './bot/client.js';
import { setupCommandHandler } from './bot/commandHandler.js';
import { registerAllCommands } from './commands/index.js';
import { setupSocketServer, shutdownSocketServer } from './realtime/socketServer.js';
import { db } from './database/db.js';

const PORT = process.env.PORT || 3000;

// Create HTTP server from Express app
const httpServer = createServer(app);

// Setup Socket.io
setupSocketServer(httpServer);

// Setup Discord command handler
setupCommandHandler();
registerAllCommands();

// Start servers
async function start() {
  try {
    // Login to Discord
    await client.login(process.env.DISCORD_TOKEN);

    // Start HTTP server
    httpServer.listen(PORT, () => {
      console.log(`Server running on port ${PORT}`);
      console.log(`Web UI available at ${process.env.WEB_URL || 'http://localhost:5173'}`);
    });
  } catch (error) {
    console.error('Failed to start:', error);
    process.exit(1);
  }
}

// Graceful shutdown handling
process.on('SIGINT', () => {
  console.log('Shutting down...');
  shutdownSocketServer();
  db.close();
  client.destroy();
  httpServer.close(() => {
    console.log('Server closed');
    process.exit(0);
  });
});

process.on('SIGTERM', () => {
  console.log('Received SIGTERM, shutting down...');
  shutdownSocketServer();
  db.close();
  client.destroy();
  httpServer.close(() => {
    console.log('Server closed');
    process.exit(0);
  });
});

process.on('unhandledRejection', (error) => {
  console.error('Unhandled rejection:', error);
});

process.on('uncaughtException', (error) => {
  console.error('Uncaught exception:', error);
  process.exit(1);
});

start();

export { app, httpServer };
