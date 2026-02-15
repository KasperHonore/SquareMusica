import jwt from 'jsonwebtoken';
import { db } from '../../database/db.js';

/**
 * Authentication middleware - requires valid token
 */
export function authMiddleware(req, res, next) {
  const token = req.cookies?.token || req.headers.authorization?.split(' ')[1];

  if (!token) {
    return res.status(401).json({ error: 'Authentication required' });
  }

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    const session = db.getSessionByToken(token);

    if (!session) {
      console.log('Auth failed: No session found for token');
      return res.status(401).json({ error: 'Session expired' });
    }

    const user = db.getUserById(session.user_id);
    if (!user) {
      console.log('Auth failed: User not found for session', session.user_id);
      return res.status(401).json({ error: 'User not found' });
    }

    req.user = user;
    req.token = token;
    next();
  } catch (err) {
    console.log('Auth failed: JWT verification error:', err.message);
    return res.status(401).json({ error: 'Invalid token' });
  }
}

/**
 * Optional authentication - attaches user if token present
 */
export function optionalAuth(req, res, next) {
  const token = req.cookies?.token || req.headers.authorization?.split(' ')[1];

  if (!token) {
    return next();
  }

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    const session = db.getSessionByToken(token);

    if (session) {
      req.user = db.getUserById(session.user_id);
      req.token = token;
    }
  } catch (err) {
    // Ignore invalid tokens for optional auth
  }

  next();
}
