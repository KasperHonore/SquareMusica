import jwt from 'jsonwebtoken';
import { db } from '../../../persistence/db.js';
import { logger } from '../../../utils/logger.js';

// Guard so the production misconfiguration warning is logged at most once per
// process instead of on every request.
let warnedDevModeIgnored = false;

function isDeveloperModeEnabled() {
  const raw = process.env.developerMode ?? process.env.DEVELOPER_MODE;
  if (raw == null) return false;
  const requested = String(raw).trim().toLowerCase() === 'true';
  if (!requested) return false;

  // Never honour the auth bypass in production, even if the flag leaks into the
  // image. This keeps the entire REST + Socket.io surface authenticated.
  if (process.env.NODE_ENV === 'production') {
    if (!warnedDevModeIgnored) {
      warnedDevModeIgnored = true;
      logger.warn(
        '[auth] DEVELOPER_MODE is set but ignored because NODE_ENV=production; ' +
          'authentication is enforced. Unset DEVELOPER_MODE to silence this warning.'
      );
    }
    return false;
  }

  return true;
}

function getDeveloperUser() {
  // Stable dev user, persisted like normal users so downstream code behaves consistently.
  return db.findOrCreateUser('developer', 'Developer', null);
}

/**
 * Verify a JWT token and return the associated user
 * @param {string} token - JWT token to verify
 * @returns {{ user?: Object, error?: string }}
 */
export function verifyToken(token) {
  if (isDeveloperModeEnabled()) {
    return { user: getDeveloperUser() };
  }

  if (!token) {
    return { error: 'Authentication required' };
  }

  try {
    jwt.verify(token, process.env.JWT_SECRET);
    const session = db.getSessionByToken(token);

    if (!session) {
      return { error: 'Session expired' };
    }

    const user = db.getUserById(session.user_id);
    if (!user) {
      return { error: 'User not found' };
    }

    return { user };
  } catch {
    return { error: 'Invalid token' };
  }
}

/**
 * Authentication middleware - requires valid token
 */
export function authMiddleware(req, res, next) {
  if (isDeveloperModeEnabled()) {
    req.user = getDeveloperUser();
    req.token = null;
    return next();
  }

  const token = req.cookies?.token || req.headers.authorization?.split(' ')[1];
  const { user, error } = verifyToken(token);

  if (error) {
    return res.status(401).json({ error });
  }

  req.user = user;
  req.token = token;
  next();
}

/**
 * Optional authentication - attaches user if token present
 */
export function optionalAuth(req, res, next) {
  if (isDeveloperModeEnabled()) {
    req.user = getDeveloperUser();
    req.token = null;
    return next();
  }

  const token = req.cookies?.token || req.headers.authorization?.split(' ')[1];

  if (token) {
    const { user } = verifyToken(token);
    if (user) {
      req.user = user;
      req.token = token;
    }
  }

  next();
}
