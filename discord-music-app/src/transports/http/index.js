import express from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import rateLimit from 'express-rate-limit';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { existsSync } from 'fs';
import { getBotInfo } from '../discord/client.js';
import { logger } from '../../utils/logger.js';
import authRoutes from './routes/auth.js';
import queueRoutes from './routes/queue.js';
import playbackRoutes from './routes/playback.js';
import spotifyRoutes from './routes/spotify.js';
import playlistRoutes from './routes/playlists.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();

// Trust the given number of reverse-proxy hops so the rate limiter keys on the
// real client IP (via X-Forwarded-For) instead of the proxy's. Unset = no trust
// (correct for direct local runs). Set TRUST_PROXY=1 behind one proxy / Docker.
// Never default to `true` — that trusts a spoofable header from any client.
if (process.env.TRUST_PROXY) {
  app.set('trust proxy', Number(process.env.TRUST_PROXY));
}

// CORS configuration
app.use(
  cors({
    origin: process.env.WEB_URL || 'http://localhost:5173',
    credentials: true
  })
);

// Body parsing
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Cookie parsing
app.use(cookieParser());

// Rate limit mutating requests on the state-changing route groups. Read-only
// (GET/HEAD) requests and the health/bot-info endpoints are left unthrottled so
// the UI can poll freely; only writes count against the budget.
const mutationLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 60,
  standardHeaders: true,
  legacyHeaders: false,
  skip: (req) => req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS',
  message: { error: 'Too many requests, please slow down.' }
});

// API routes
app.use('/api/auth', authRoutes);
app.use('/api/queue', mutationLimiter, queueRoutes);
app.use('/api/player', mutationLimiter, playbackRoutes);
app.use('/api/spotify', spotifyRoutes);
app.use('/api/playlists', mutationLimiter, playlistRoutes);

// Public bot info (no auth required)
app.get('/api/bot-info', (req, res) => {
  const info = getBotInfo();
  if (!info) return res.status(503).json({ error: 'Bot not ready' });
  res.json(info);
});

// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok' });
});

// Error handling middleware
app.use((err, req, res, _next) => {
  logger.error('API Error:', err);
  res.status(500).json({ error: 'Internal server error' });
});

// Serve static frontend in production (when web/dist exists)
const webDistPath = join(__dirname, '../../web/dist');
if (existsSync(webDistPath)) {
  app.use(express.static(webDistPath));

  // SPA fallback - serve index.html for non-API routes
  app.get('*', (req, res, next) => {
    if (req.path.startsWith('/api') || req.path.startsWith('/socket.io')) {
      return next();
    }
    res.sendFile(join(webDistPath, 'index.html'));
  });
}

export { app };
