# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
# Install dependencies
npm install

# Run the app
npm start          # or: node app.js

# Development with auto-reload
npm run dev        # uses nodemon

# Register slash commands with Discord
npm run register
```

## Architecture

This is a Discord bot using the HTTP interactions model (not WebSocket gateway). It implements a rock-paper-scissors style game with 7 choices (rock, paper, scissors, cowboy, virus, computer, wumpus).

**Key files:**

- `app.js` - Express server handling Discord interactions at `/interactions` endpoint. Uses `discord-interactions` for request verification.
- `commands.js` - Slash command definitions. Running this file registers commands with Discord API. Add new commands to `ALL_COMMANDS` array.
- `game.js` - RPS game logic with extended choices. `RPSChoices` object defines win conditions as `{winner: {loser: verb}}`.
- `utils.js` - Discord API wrapper (`DiscordRequest`) and command installation (`InstallGlobalCommands`).

**Flow:** Discord sends HTTP POST to `/interactions` -> `verifyKeyMiddleware` validates request -> handler routes by `InteractionType` and command name -> returns JSON response.

## Environment Variables

Required in `.env` (see `.env.sample`):

- `APP_ID` - Discord application ID
- `DISCORD_TOKEN` - Bot token
- `PUBLIC_KEY` - For request signature verification

## Local Development

Requires a public URL for Discord to send interactions. Use ngrok:

```bash
ngrok http 3000
```

Set the ngrok HTTPS URL + `/interactions` as your app's Interactions Endpoint URL in Discord Developer Portal.

# Commit rules

When generating commit messages, never include Co-authored-by: trailers or any additional authors. All commits must attribute only the current git user.
