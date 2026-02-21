# Docker Deployment Guide

A comprehensive guide to deploying the Discord Music Bot using Docker for production environments.

---

## Table of Contents

1. [Overview](#overview)
2. [Prerequisites](#prerequisites)
3. [Quick Start](#quick-start)
4. [Configuration](#configuration)
5. [Building & Running](#building--running)
6. [Reverse Proxy Setup](#reverse-proxy-setup)
7. [Discord OAuth Setup](#discord-oauth-setup)
8. [Persistent Data](#persistent-data)
9. [Troubleshooting](#troubleshooting)
10. [Maintenance](#maintenance)

---

## Overview

The Docker setup packages the entire application into a single container:

- **Discord Bot** - Handles voice connections and slash commands
- **Express API** - REST endpoints, OAuth, and Socket.io
- **React Frontend** - Pre-built and served as static files

### Architecture

```
Internet -> Domain (SSL) -> Reverse Proxy -> Docker Container (port 3000)
                                                    |
                                            Bot + API + Static UI
                                                    |
                                            Volume: ./data (SQLite)
```

### What's Included

The Docker image contains:
- Node.js 20 runtime
- All application dependencies (including native modules)
- Pre-built React frontend
- yt-dlp binary for YouTube playback
- FFmpeg for audio processing

---

## Prerequisites

- **Docker** 20.10+ and **Docker Compose** v2+
- A domain with SSL (e.g., `music.yourdomain.com`)
- A reverse proxy (nginx, Traefik, Caddy, etc.)
- Discord bot credentials (token, app ID, etc.)

---

## Quick Start

1. **Clone and navigate to the project:**
   ```bash
   cd discord-music-app
   ```

2. **Create your environment file:**
   ```bash
   cp .env.sample .env.docker
   ```

3. **Edit `.env.docker`** with your credentials (see [Configuration](#configuration))

4. **Build and start:**
   ```bash
   docker compose up -d --build
   ```

5. **Check logs:**
   ```bash
   docker compose logs -f
   ```

6. **Verify the bot is online** in your Discord server

---

## Configuration

### Environment Variables

Copy `.env.sample` to `.env.docker` and configure:

#### Required Variables

| Variable | Description |
|----------|-------------|
| `DISCORD_TOKEN` | Bot token from [Discord Developer Portal](https://discord.com/developers/applications) |
| `APP_ID` | Your Discord application ID |
| `PUBLIC_KEY` | Your Discord application public key |
| `GUILD_ID` | Your Discord server ID |
| `DISCORD_CLIENT_SECRET` | OAuth2 client secret |
| `OAUTH_REDIRECT_URI` | OAuth callback URL (e.g., `https://music.yourdomain.com/api/auth/callback`) |
| `JWT_SECRET` | Random 32+ character string for signing tokens |
| `WEB_URL` | Your public domain URL (e.g., `https://music.yourdomain.com`) |

#### Optional Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3000` | Internal container port |
| `NODE_ENV` | - | Set to `production` for secure cookies |
| `YT_DLP_PATH` | `/app/bin/yt-dlp` | Path to yt-dlp binary |
| `YT_DLP_COOKIES` | - | Path to cookies file for age-restricted content |
| `SPOTIFY_CLIENT_ID` | - | Spotify API client ID |
| `SPOTIFY_CLIENT_SECRET` | - | Spotify API client secret |

### Example Configuration

```env
# Discord Bot
DISCORD_TOKEN=MTIzNDU2Nzg5MDEyMzQ1Njc4OQ.XXXXXX.XXXXXXXXXXXXXXXXXXXXXXXXXX
APP_ID=123456789012345678
PUBLIC_KEY=abcdef1234567890abcdef1234567890abcdef1234567890
GUILD_ID=987654321098765432

# OAuth
DISCORD_CLIENT_SECRET=your_client_secret_here
OAUTH_REDIRECT_URI=https://music.example.com/api/auth/callback

# Server
PORT=3000
JWT_SECRET=your-super-secret-jwt-key-at-least-32-chars
WEB_URL=https://music.example.com
NODE_ENV=production
```

---

## Building & Running

### Build the Image

```bash
docker compose build
```

The multi-stage build:
1. Installs all dependencies and compiles native modules
2. Builds the React frontend
3. Creates a minimal production image

### Start the Container

```bash
# Start in detached mode
docker compose up -d

# View logs
docker compose logs -f

# Stop the container
docker compose down
```

### Useful Commands

```bash
# Restart the bot
docker compose restart

# Rebuild after code changes
docker compose up -d --build

# View container status
docker compose ps

# Execute commands inside container
docker compose exec music-bot sh

# Check health status
docker inspect --format='{{.State.Health.Status}}' discord-music-bot
```

---

## Reverse Proxy Setup

The container exposes port 3000. Configure your reverse proxy to:
- Terminate SSL
- Forward requests to `localhost:3000`
- Support WebSocket connections (for Socket.io)

### Nginx Example

```nginx
server {
    listen 443 ssl http2;
    server_name music.yourdomain.com;

    ssl_certificate /path/to/cert.pem;
    ssl_certificate_key /path/to/key.pem;

    location / {
        proxy_pass http://localhost:3000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

        # WebSocket support (required for Socket.io)
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
    }
}

server {
    listen 80;
    server_name music.yourdomain.com;
    return 301 https://$server_name$request_uri;
}
```

### Traefik Example (docker-compose labels)

```yaml
services:
  music-bot:
    # ... existing config ...
    labels:
      - "traefik.enable=true"
      - "traefik.http.routers.music.rule=Host(`music.yourdomain.com`)"
      - "traefik.http.routers.music.entrypoints=websecure"
      - "traefik.http.routers.music.tls.certresolver=letsencrypt"
      - "traefik.http.services.music.loadbalancer.server.port=3000"
```

### Caddy Example

```
music.yourdomain.com {
    reverse_proxy localhost:3000
}
```

---

## Discord OAuth Setup

After deploying, update your Discord application OAuth settings:

1. Go to [Discord Developer Portal](https://discord.com/developers/applications)
2. Select your application
3. Navigate to **OAuth2** > **Redirects**
4. Add your production callback URL:
   ```
   https://music.yourdomain.com/api/auth/callback
   ```
5. Save changes

**Note:** Keep localhost redirects if you still need local development.

---

## Persistent Data

### SQLite Database

The database is stored in `./data/` and mounted as a Docker volume:

```yaml
volumes:
  - ./data:/app/data
```

This ensures your queue history and user data persist across container restarts.

### Backup

```bash
# Backup the database
cp ./data/music.db ./backups/music-$(date +%Y%m%d).db

# Or while container is running (SQLite safe copy)
docker compose exec music-bot sqlite3 /app/data/music.db ".backup '/app/data/backup.db'"
cp ./data/backup.db ./backups/music-$(date +%Y%m%d).db
```

### YouTube Cookies (Optional)

For age-restricted or region-locked content, mount a cookies file:

1. Export cookies from your browser (using a cookies.txt extension)
2. Place the file in your project directory
3. Uncomment the volume mount in `docker-compose.yml`:
   ```yaml
   volumes:
     - ./data:/app/data
     - ./cookies.txt:/app/cookies.txt:ro
   ```
4. Set the environment variable:
   ```env
   YT_DLP_COOKIES=/app/cookies.txt
   ```

---

## Troubleshooting

### Container Won't Start

**Check logs:**
```bash
docker compose logs
```

**Common issues:**
- Missing environment variables - ensure all required vars are set in `.env.docker`
- Port conflict - ensure port 3000 isn't in use
- Invalid Discord token - verify token is correct and bot is in server

### Bot Shows Offline

1. Verify `DISCORD_TOKEN` is correct
2. Check the bot has been invited to your server
3. Ensure `GUILD_ID` matches your server ID
4. Check logs for connection errors

### WebSocket/Real-time Issues

Ensure your reverse proxy forwards WebSocket headers:
```nginx
proxy_set_header Upgrade $http_upgrade;
proxy_set_header Connection "upgrade";
```

### Audio Playback Issues

1. Check yt-dlp is working:
   ```bash
   docker compose exec music-bot /app/bin/yt-dlp --version
   ```

2. For age-restricted content, configure YouTube cookies

3. Check FFmpeg is available:
   ```bash
   docker compose exec music-bot ffmpeg -version
   ```

### Health Check Failing

The health check calls `/api/health`. If failing:
```bash
# Test manually
docker compose exec music-bot wget -q -O- http://localhost:3000/api/health
```

---

## Maintenance

### Updating the Bot

```bash
# Pull latest code
git pull

# Rebuild and restart
docker compose up -d --build
```

### Updating yt-dlp

yt-dlp is downloaded during the Docker build. To update:
```bash
docker compose build --no-cache
docker compose up -d
```

### Viewing Logs

```bash
# All logs
docker compose logs

# Follow logs in real-time
docker compose logs -f

# Last 100 lines
docker compose logs --tail=100
```

### Resource Usage

```bash
# View container stats
docker stats discord-music-bot

# View disk usage
docker system df
```

---

## File Reference

| File | Purpose |
|------|---------|
| `Dockerfile` | Multi-stage build configuration |
| `docker-compose.yml` | Service definition with volumes and healthcheck |
| `.env.sample` | Environment variable template (copy to `.env.docker`) |
| `.dockerignore` | Files excluded from Docker build context |

---

## Security Considerations

1. **Never commit `.env.docker`** - it contains secrets
2. **Use strong JWT secrets** - at least 32 random characters
3. **Keep dependencies updated** - rebuild periodically
4. **Restrict container access** - don't expose port 3000 publicly; use a reverse proxy
5. **Use HTTPS** - always terminate SSL at your reverse proxy
