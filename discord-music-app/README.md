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

- Node.js 22+
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

`YT_DLP_PATH` is auto-detected (local `./bin/yt-dlp`, Docker `/app/bin/yt-dlp`, or system `yt-dlp`). Set it manually only for custom paths.

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
- `GUILD_ID` - Your Discord server ID (restricts web UI to this server's members)
- `DISCORD_CLIENT_SECRET` - OAuth client secret (for web UI)
- `JWT_SECRET` - Random string for JWT signing
- `OAUTH_REDIRECT_URI` - OAuth callback URL (Discord redirects here after login)
- `WEB_URL` - Frontend URL; used for CORS and as the destination the server redirects back to after the OAuth flow completes

Optional variables:

- `TRUST_PROXY` - Reverse-proxy hop count. Leave unset for direct local runs; set to `1` when running behind a single reverse proxy / Docker so the rate limiter sees the real client IP. It is a hop count, not a boolean — do not set it to `true`.
- `LOG_LEVEL` - `error` | `warn` | `info` | `debug` (default `info`).
- `YT_DLP_MAX_CONCURRENCY` (default 4), `YT_DLP_MAX_QUEUE` (default 50), `YT_DLP_STREAM_TIMEOUT_MS` (default 15000) - yt-dlp resource limits.

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

| Command                   | Description                   |
| ------------------------- | ----------------------------- |
| `/join`                   | Join your voice channel       |
| `/leave`                  | Leave the voice channel       |
| `/play <query>`           | Play a song (URL or search)   |
| `/pause`                  | Pause playback                |
| `/resume`                 | Resume playback               |
| `/skip`                   | Skip to next track            |
| `/stop`                   | Stop playback and clear queue |
| `/queue`                  | View current queue            |
| `/nowplaying`             | Show current track            |
| `/remove <position>`      | Remove track from queue       |
| `/shuffle`                | Shuffle the queue             |
| `/clear`                  | Clear the queue               |
| `/loop <off/track/queue>` | Set loop mode                 |
| `/webui`                  | Get web control panel link    |

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
- `GET /api/queue/history` - Get play history
- `GET /api/player` - Get player state
- `POST /api/player/:action` - Control playback

## Development

```bash
# Start with auto-reload
npm run dev

# Register commands globally
npm run register
```

## Devcontainers / Codespaces

No port forwarding is needed. `peon-ping` auto-detects `REMOTE_CONTAINERS` and `CODESPACES` environment variables and routes audio to `host.docker.internal:19998`.

Run the relay on your host machine:

```bash
peon relay --daemon
```

### Relay Commands

```bash
peon relay                # Start relay in foreground
peon relay --daemon       # Start in background
peon relay --stop         # Stop background relay
peon relay --status       # Check if relay is running
peon relay --port=12345   # Custom port (default: 19998)
peon relay --bind=0.0.0.0 # Listen on all interfaces (less secure)
```

Relay environment variables: `PEON_RELAY_PORT`, `PEON_RELAY_HOST`, `PEON_RELAY_BIND`.

If `peon-ping` detects an SSH or container session but cannot reach the relay, it prints setup instructions on `SessionStart`.

## yt-dlp Maintenance

YouTube frequently changes their systems. Keep yt-dlp updated to avoid streaming issues:

```bash
# Manual update
yt-dlp -U

# Or delete bin/yt-dlp and run npm run setup to re-download
rm bin/yt-dlp && npm run setup
```

### Common Error Patterns

| Error                                 | Cause                  | Solution                              |
| ------------------------------------- | ---------------------- | ------------------------------------- |
| `Sign in to confirm you're not a bot` | Rate limited           | Add cookies file via `YT_DLP_COOKIES` |
| `Video unavailable`                   | Region/age restriction | Use VPN or cookies                    |
| `Unable to extract`                   | yt-dlp outdated        | Run `yt-dlp -U`                       |

### Using Cookies

For age-restricted content or rate limiting issues, export your YouTube cookies:

1. Use a browser extension to export cookies to a file
2. Set `YT_DLP_COOKIES=/path/to/cookies.txt` in your `.env`

## License

MIT
