import { Router } from 'express';
import jwt from 'jsonwebtoken';
import { db } from '../../../persistence/db.js';
import { authMiddleware } from '../middleware/auth.js';

const router = Router();

const DISCORD_API = 'https://discord.com/api/v10';

/**
 * Get the frontend URL for redirects.
 * Avoid deriving redirect targets from request headers to prevent host-header / forwarded-header injection.
 */
function getWebUrl() {
  return process.env.WEB_URL || 'http://localhost:5173';
}

/**
 * GET /api/auth/discord - Redirect to Discord OAuth
 */
router.get('/discord', (req, res) => {
  const params = new URLSearchParams({
    client_id: process.env.APP_ID,
    redirect_uri: process.env.OAUTH_REDIRECT_URI,
    response_type: 'code',
    scope: 'identify guilds'
  });
  res.redirect(`https://discord.com/api/oauth2/authorize?${params}`);
});

/**
 * GET /api/auth/callback - Handle OAuth callback
 */
router.get('/callback', async (req, res) => {
  const { code } = req.query;

  if (!code) {
    return res.redirect(`${getWebUrl()}?error=no_code`);
  }

  try {
    // Exchange code for access token
    const tokenResponse = await fetch(`${DISCORD_API}/oauth2/token`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: new URLSearchParams({
        client_id: process.env.APP_ID,
        client_secret: process.env.DISCORD_CLIENT_SECRET,
        grant_type: 'authorization_code',
        code,
        redirect_uri: process.env.OAUTH_REDIRECT_URI
      })
    });

    if (!tokenResponse.ok) {
      console.error('Token exchange failed:', await tokenResponse.text());
      return res.redirect(`${getWebUrl()}?error=token_exchange`);
    }

    const tokens = await tokenResponse.json();

    // Get user info from Discord
    const userResponse = await fetch(`${DISCORD_API}/users/@me`, {
      headers: {
        Authorization: `Bearer ${tokens.access_token}`
      }
    });

    if (!userResponse.ok) {
      console.error('User fetch failed:', await userResponse.text());
      return res.redirect(`${getWebUrl()}?error=user_fetch`);
    }

    const discordUser = await userResponse.json();

    // Fetch user's guilds to verify membership
    const guildsResponse = await fetch(`${DISCORD_API}/users/@me/guilds`, {
      headers: {
        Authorization: `Bearer ${tokens.access_token}`
      }
    });

    if (!guildsResponse.ok) {
      console.error('Guild fetch failed:', await guildsResponse.text());
      return res.redirect(`${getWebUrl()}?error=guild_fetch`);
    }

    const guilds = await guildsResponse.json();
    const isMember = guilds.some((g) => g.id === process.env.GUILD_ID);

    if (!isMember) {
      return res.redirect(`${getWebUrl()}?error=not_member`);
    }

    // Create or update user in database
    const user = db.findOrCreateUser(discordUser.id, discordUser.username, discordUser.avatar);

    // Create JWT token
    const jwtToken = jwt.sign(
      { userId: user.id, discordId: discordUser.id },
      process.env.JWT_SECRET,
      { expiresIn: '7d' }
    );

    // Create session
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000); // 7 days
    db.createSession(user.id, jwtToken, expiresAt);

    // Set cookie and redirect
    res.cookie('token', jwtToken, {
      httpOnly: true,
      secure: process.env.NODE_ENV !== 'development',
      sameSite: 'lax',
      maxAge: 7 * 24 * 60 * 60 * 1000 // 7 days
    });

    // Cookie-based auth: do not put tokens in URLs.
    res.redirect(`${getWebUrl()}?auth=success`);
  } catch (error) {
    console.error('OAuth callback error:', error);
    res.redirect(`${getWebUrl()}?error=server_error`);
  }
});

/**
 * GET /api/auth/me - Get current user
 */
router.get('/me', authMiddleware, (req, res) => {
  res.json({
    user: req.user
  });
});

/**
 * POST /api/auth/logout - End session
 */
router.post('/logout', authMiddleware, (req, res) => {
  db.deleteSessionByToken(req.token);
  res.clearCookie('token');
  res.json({ success: true });
});

export default router;
