# CLAUDE.md

This file provides guidance to Claude Code when working with this repository.

## Project Vision

This is a **Discord Music Bot with Web UI** - a music bot that allows users to control playback and manage the queue through both Discord slash commands and a web-based control panel. Multiple users can collaborate on the queue in real-time.

**Key Features**:

- Play music from YouTube in Discord voice channels
- Full queue management (add, remove, reorder, shuffle)
- Real-time web UI for controlling the bot
- Discord OAuth authentication
- Multiple users can control the queue simultaneously

## Architecture

The application consists of three main components:

1. **Discord Bot** (discord.js) - Handles voice connections and slash commands
2. **Web API** (Express) - REST API + Discord OAuth + Socket.io for real-time
3. **Web UI** (React) - Browser-based control panel

```
Discord <-> Bot (discord.js) <-> Music Manager <-> Web API (Express)
                                     |              |
                                  SQLite      Socket.io <-> React UI
```

## Commands

### Development

```bash
npm install              # Install dependencies (auto-runs yt-dlp setup)
npm run dev              # Start bot + API server
npm run register         # Register slash commands with Discord
npm run setup            # Manually run yt-dlp setup
```

### Web UI

```bash
cd web
npm install              # Install frontend dependencies
npm run dev              # Start React dev server (Vite)
npm run build            # Build for production
```

### Production

```bash
npm start                # Start bot + API server
```

## Project Structure

```
discord-music-app/
├── src/
│   ├── bot/             # Discord.js bot client and voice handling
│   ├── commands/        # Slash command implementations
│   │   └── utils/       # Shared command utilities
│   ├── music/           # Player, queue, and YouTube integration
│   ├── api/             # Express routes and middleware
│   ├── realtime/        # Socket.io server
│   ├── database/        # SQLite schema and queries
│   ├── state/           # Shared state management
│   └── index.js         # Entry point
├── web/                 # React frontend
│   └── src/
│       ├── components/  # React components
│       ├── context/     # Auth context
│       ├── hooks/       # Custom hooks (useSocket)
│       ├── pages/       # Dashboard, Login
│       └── utils/       # Shared utilities
├── scripts/             # Setup scripts (yt-dlp)
├── bin/                 # Downloaded binaries (yt-dlp)
├── data/                # SQLite database (auto-created)
├── package.json
└── .env
```

## Environment Variables

Required in `.env`:

```env
# Discord Bot (required)
DISCORD_TOKEN=           # Bot token from Discord Developer Portal
APP_ID=                  # Application ID

# Guild ID (optional - affects slash command registration)
# GUILD_ID=              # Set for dev (instant updates), omit for production (global)

# OAuth (required for web UI)
DISCORD_CLIENT_SECRET=   # OAuth client secret
OAUTH_REDIRECT_URI=http://localhost:3000/api/auth/callback

# Server (required)
JWT_SECRET=              # Secret for JWT tokens
WEB_URL=http://localhost:5173  # Frontend URL (used for CORS)

# Optional
NODE_ENV=development     # Set to 'development' for non-secure cookies (secure by default)
# PORT=3000              # Defaults to 3000
# YT_DLP_PATH=           # Auto-detected: ./bin/yt-dlp (local) or /app/bin/yt-dlp (Docker)
# YT_DLP_COOKIES=        # Path to cookies file for age-restricted content
```

## Registering Slash Commands

Run `npm run register` to register commands with Discord. This only needs to be run once (or when commands change).

- **Development**: Set `GUILD_ID` in `.env` for instant command updates on your test server
- **Production**: Omit `GUILD_ID` to register globally—commands work on all servers the bot joins

## Slash Commands

| Command           | Description                 |
| ----------------- | --------------------------- |
| `/play <query>`   | Play a song or add to queue |
| `/pause`          | Pause playback              |
| `/resume`         | Resume playback             |
| `/skip`           | Skip to next track          |
| `/stop`           | Stop and clear queue        |
| `/queue`          | View current queue          |
| `/nowplaying`     | Show current track          |
| `/join`           | Join voice channel          |
| `/leave`          | Leave voice channel         |
| `/shuffle`        | Shuffle the queue           |
| `/loop <mode>`    | Set loop mode               |
| `/remove <pos>`   | Remove from queue           |
| `/webui`          | Get web control panel link  |

## Local Development

1. Copy `.env.sample` to `.env` and fill in values
2. Run `npm install` in root and `web/` directories
3. Run `npm run register` to register slash commands
4. Run `npm run dev` to start the bot
5. Run `cd web && npm run dev` to start the web UI
6. Join a voice channel and use `/play` or open the web UI

For local testing, the bot needs to be in your Discord server with appropriate permissions (voice connect, speak, application commands).

# Commit rules

When generating commit messages, never include Co-authored-by: trailers or any additional authors. All commits must attribute only the current git user.

# Agent teams

When using Agent Teams, be sure to use the model claude-opus-4-5.
