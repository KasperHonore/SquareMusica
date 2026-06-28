# Build stage
FROM node:22-slim AS builder

# Install build dependencies for native modules (better-sqlite3, opus, sodium)
RUN apt-get update && apt-get install -y \
    python3 \
    make \
    g++ \
    git \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy package files and scripts needed for setup
COPY package*.json ./
COPY scripts ./scripts

# Install dependencies
RUN npm ci

# Download yt-dlp binary into ./bin (previously a postinstall hook)
RUN node scripts/setup-ytdlp.js

# Copy remaining source code
COPY . .

# Build frontend
WORKDIR /app/web
RUN npm ci && npm run build

WORKDIR /app

# Production stage
FROM node:22-slim

# Install runtime dependencies
# - python3: required for yt-dlp
# - ffmpeg: required for audio processing
RUN apt-get update && apt-get install -y \
    python3 \
    ffmpeg \
    wget \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Create a dedicated unprivileged user/group to run the app as non-root
RUN groupadd --system --gid 1001 appuser \
    && useradd --system --uid 1001 --gid appuser --home-dir /app --no-create-home appuser

# Copy built assets from builder stage, owned by the non-root user.
# Using --chown keeps everything readable/writable by appuser without an extra
# chown layer (node_modules and bin/yt-dlp must be readable at runtime).
COPY --from=builder --chown=appuser:appuser /app/node_modules ./node_modules
COPY --from=builder --chown=appuser:appuser /app/src ./src
COPY --from=builder --chown=appuser:appuser /app/scripts ./scripts
COPY --from=builder --chown=appuser:appuser /app/bin ./bin
COPY --from=builder --chown=appuser:appuser /app/web/dist ./web/dist
COPY --from=builder --chown=appuser:appuser /app/package.json ./

# Create the SQLite data directory and hand ownership to appuser.
# This mount point's ownership is inherited by a fresh named volume on first
# creation, so the non-root user can create/write the DB + WAL/SHM files even
# when docker-compose mounts the persistent volume here.
RUN mkdir -p /app/data && chown -R appuser:appuser /app/data

# Drop privileges: everything below runs as the unprivileged user
USER appuser

# Expose API port
EXPOSE 3000

# Container-level health probe against the app's health endpoint.
# Mirrors the docker-compose probe style (wget -q --spider) and gives the app a
# generous start-period to boot Node + complete Discord login before checks count.
HEALTHCHECK --interval=30s --timeout=10s --start-period=40s --retries=3 \
    CMD wget -q --spider http://localhost:3000/api/health || exit 1

# Start the application
CMD ["node", "src/index.js"]
