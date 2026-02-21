# Build stage
FROM node:20-alpine AS builder

# Install build dependencies for native modules (better-sqlite3, opus, sodium)
RUN apk add --no-cache python3 make g++ git

WORKDIR /app

# Copy package files and install dependencies
COPY package*.json ./
RUN npm ci

# Copy source code
COPY . .

# Build frontend
WORKDIR /app/web
RUN npm ci && npm run build

WORKDIR /app

# Production stage
FROM node:20-alpine

# Install runtime dependencies
# - python3: required for yt-dlp
# - ffmpeg: required for audio processing
RUN apk add --no-cache python3 ffmpeg

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
