# Discord Music Bot

A feature-rich Discord music bot with a web control panel. Stream music from YouTube with real-time queue management through both Discord slash commands and a web interface.

## Features

- Play music from YouTube (search or direct URLs)
- Playlist support
- Queue management (add, remove, reorder, shuffle)
- Playback controls (play, pause, skip, stop)
- Loop controls
- Web UI with Discord OAuth authentication
- Real-time updates via Socket.io

## Project Structure

```
src/
  api/           # Express REST API
    middleware/  # Auth middleware
    routes/      # API endpoints
  bot/           # Discord.js client & voice
  commands/      # Slash command handlers
  database/      # SQLite with better-sqlite3
  music/         # YouTube search, queue, player
  realtime/      # Socket.io server
  state/         # MusicManager (central state)
  index.js       # Entry point
```

## Requirements

- Node.js 18+
- A Discord application with bot token
- FFmpeg (for audio processing)
- yt-dlp (for YouTube streaming)

### Installing yt-dlp

```bash
# Linux/macOS (recommended)
curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o /usr/local/bin/yt-dlp
chmod a+rx /usr/local/bin/yt-dlp

# Or via pip
pip install yt-dlp

# Verify installation
yt-dlp --version
```

If yt-dlp is installed in a non-standard location, set `YT_DLP_PATH` in your `.env` file.

## Quick Start

### 1. Clone and Install

```bash
npm install
```

### 2. Configure Environment

Copy `.env.sample` to `.env` and fill in your credentials:

```bash
cp .env.sample .env
```

Required variables:
- `DISCORD_TOKEN` - Your bot token from Discord Developer Portal
- `APP_ID` - Your application ID
- `PUBLIC_KEY` - Your application's public key
- `GUILD_ID` - Guild ID for development (optional, for faster command registration)
- `DISCORD_CLIENT_SECRET` - OAuth client secret (for web UI)
- `JWT_SECRET` - Random string for JWT signing

### 3. Register Commands

```bash
npm run register
```

### 4. Run the Bot

```bash
npm start
# or for development with auto-reload:
npm run dev
```

## Commands

| Command | Description |
|---------|-------------|
| `/join` | Join your voice channel |
| `/leave` | Leave the voice channel |
| `/play <query>` | Play a song (URL or search) |
| `/pause` | Pause playback |
| `/resume` | Resume playback |
| `/skip` | Skip to next track |
| `/stop` | Stop playback and clear queue |
| `/queue` | View current queue |
| `/nowplaying` | Show current track |
| `/remove <position>` | Remove track from queue |
| `/shuffle` | Shuffle the queue |
| `/clear` | Clear the queue |
| `/loop <off/track/queue>` | Set loop mode |
| `/webui` | Get web control panel link |

## Web UI

The bot includes a web control panel accessible at `http://localhost:5173` (or your configured WEB_URL).

Features:
- Discord OAuth login
- Real-time queue display
- Playback controls
- Search and add songs
- Drag-and-drop queue reordering

## API Endpoints

- `GET /api/health` - Health check
- `GET /api/auth/discord` - Start OAuth flow
- `GET /api/auth/me` - Get current user
- `POST /api/auth/logout` - End session
- `GET /api/queue` - Get queue
- `POST /api/queue` - Add track
- `DELETE /api/queue/:position` - Remove track
- `PATCH /api/queue/reorder` - Reorder tracks
- `POST /api/queue/shuffle` - Shuffle queue
- `GET /api/queue/search` - Search YouTube
- `GET /api/player` - Get player state
- `POST /api/player/:action` - Control playback
- `GET /api/player/history` - Get play history

## Development

```bash
# Start with auto-reload
npm run dev

# Register commands to test guild (faster)
# Set GUILD_ID in .env first
npm run register
```

## yt-dlp Maintenance

YouTube frequently changes their systems. Keep yt-dlp updated to avoid streaming issues:

```bash
# Manual update
yt-dlp -U

# Or delete bin/yt-dlp and run npm run setup to re-download
rm bin/yt-dlp && npm run setup
```

### Common Error Patterns

| Error | Cause | Solution |
|-------|-------|----------|
| `Sign in to confirm you're not a bot` | Rate limited | Add cookies file via `YT_DLP_COOKIES` |
| `Video unavailable` | Region/age restriction | Use VPN or cookies |
| `Unable to extract` | yt-dlp outdated | Run `yt-dlp -U` |

### Using Cookies

For age-restricted content or rate limiting issues, export your YouTube cookies:

1. Use a browser extension to export cookies to a file
2. Set `YT_DLP_COOKIES=/path/to/cookies.txt` in your `.env`

## License

MIT
