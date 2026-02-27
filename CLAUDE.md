# CLAUDE.md

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

# Docker

```bash
cd discord-music-app
docker build -t kasperhonore/discord-music .   # Build image
docker push kasperhonore/discord-music         # Push to Docker Hub
```

# Commit rules

When generating commit messages, never include Co-authored-by: trailers or any additional authors. All commits must attribute only the current git user.

# Agent teams

When using Agent Teams, be sure to use the model claude-opus-4-5.
