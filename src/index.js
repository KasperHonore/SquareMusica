import 'dotenv/config';
import { validateEnv } from './config/env.js';

// Fail fast with one aggregated error if any required config is missing.
// This runs BEFORE the rest of the app is imported (those modules open the
// database, build the Discord client, etc. as import-time side effects), so a
// misconfiguration surfaces as a clear message instead of an unrelated crash.
validateEnv([
  'DISCORD_TOKEN',
  'APP_ID',
  'GUILD_ID',
  'DISCORD_CLIENT_SECRET',
  'JWT_SECRET',
  'OAUTH_REDIRECT_URI'
]);

// Loaded dynamically (after validation) so their side effects don't run on a
// misconfigured environment. Static imports would be hoisted above the check.
const { createServer } = await import('http');
const { app } = await import('./transports/http/index.js');
const { client } = await import('./transports/discord/client.js');
const { setupCommandHandler } = await import('./transports/discord/commandHandler.js');
const { registerAllCommands } = await import('./transports/discord/commands/index.js');
const { setupSocketServer, shutdownSocketServer } =
  await import('./transports/realtime/socketServer.js');
const { db } = await import('./persistence/db.js');
const { getPlayer, getQueue } = await import('./services/playback.js');
const { logger } = await import('./utils/logger.js');

const PORT = process.env.PORT || 3000;

// Create HTTP server from Express app
const httpServer = createServer(app);

// Setup Socket.io
setupSocketServer(httpServer);

// Setup Discord command handler
setupCommandHandler();
registerAllCommands();

// Initialize player and queue so web UI can detect voice connection state
getPlayer();
getQueue();

// Start servers
async function start() {
  try {
    // Login to Discord
    await client.login(process.env.DISCORD_TOKEN);

    // Start HTTP server
    httpServer.listen(PORT, () => {
      logger.info(`Server running on port ${PORT}`);
      logger.info(`Web UI available at ${process.env.WEB_URL || 'http://localhost:5173'}`);
    });
  } catch (error) {
    logger.error('Failed to start:', error);
    process.exit(1);
  }
}

// Graceful shutdown handling
process.on('SIGINT', () => {
  logger.info('Shutting down...');
  shutdownSocketServer();
  db.close();
  client.destroy();
  httpServer.close(() => {
    logger.info('Server closed');
    process.exit(0);
  });
});

process.on('SIGTERM', () => {
  logger.info('Received SIGTERM, shutting down...');
  shutdownSocketServer();
  db.close();
  client.destroy();
  httpServer.close(() => {
    logger.info('Server closed');
    process.exit(0);
  });
});

process.on('unhandledRejection', (error) => {
  logger.error('Unhandled rejection:', error);
});

process.on('uncaughtException', (error) => {
  logger.error('Uncaught exception:', error);
  process.exit(1);
});

start();
