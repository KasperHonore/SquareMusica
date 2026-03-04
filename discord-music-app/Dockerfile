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

# Copy package files and scripts needed for postinstall
COPY package*.json ./
COPY scripts ./scripts

# Install dependencies (postinstall runs setup-ytdlp.js)
RUN npm ci

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

# Copy built assets from builder stage
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/src ./src
COPY --from=builder /app/scripts ./scripts
COPY --from=builder /app/bin ./bin
COPY --from=builder /app/web/dist ./web/dist
COPY --from=builder /app/package.json ./

# Create data directory for SQLite database
RUN mkdir -p /app/data

# Expose API port
EXPOSE 3000

# Start the application
CMD ["node", "src/index.js"]
