import express from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import authRoutes from './routes/auth.js';
import queueRoutes from './routes/queue.js';
import playbackRoutes from './routes/playback.js';

const app = express();

// CORS configuration
app.use(cors({
  origin: process.env.WEB_URL || 'http://localhost:5173',
  credentials: true
}));

// Body parsing
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Cookie parsing
app.use(cookieParser());

// API routes
app.use('/api/auth', authRoutes);
app.use('/api/queue', queueRoutes);
app.use('/api/player', playbackRoutes);

// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok' });
});

// Error handling middleware
app.use((err, req, res, next) => {
  console.error('API Error:', err);
  res.status(500).json({ error: 'Internal server error' });
});

export { app };
