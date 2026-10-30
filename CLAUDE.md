# CLAUDE.md

Anything under `.claude/` — settings, personal skills, local agents — is
gitignored and private to each contributor. Do not assume a teammate has it, and
do not rely on it in committed docs or scripts.

# Architecture principles

Five principles govern how this project is built and are binding: single-guild
scope (per `docs/ADR-001-guild-scope.md`, non-negotiable), layered dependency
direction (`core/` must not import `transports/`), transport parity across
Discord, HTTP, and Socket.io, fail-fast configuration, and the CI gates in
`.github/workflows/ci.yml`. Keep to them when proposing architectural changes.

# Docker

```bash
docker build -t kasperhonore/discord-music .   # Build image (run from repo root)
docker push kasperhonore/discord-music         # Push to Docker Hub
```
