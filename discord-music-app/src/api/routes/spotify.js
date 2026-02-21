import { Router } from 'express';
import { parseSpotifyUrl, getPublicAlbum, getPublicPlaylist, isSpotifyConfigured } from '../../music/spotify.js';
import { authMiddleware } from '../middleware/auth.js';

const router = Router();

/**
 * GET /api/spotify/info?url=... - Get Spotify album/playlist metadata
 * Returns: { type, name, images, trackCount }
 */
router.get('/info', authMiddleware, async (req, res) => {
  const { url } = req.query;

  if (!url) {
    return res.status(400).json({ error: 'URL is required' });
  }

  if (!isSpotifyConfigured()) {
    return res.status(503).json({ error: 'Spotify not configured' });
  }

  const parsed = parseSpotifyUrl(url);

  if (parsed.type === 'album') {
    const album = await getPublicAlbum(parsed.id);
    if (!album) {
      return res.status(404).json({ error: 'Album not found' });
    }
    return res.json({
      type: 'album',
      name: album.name,
      images: album.images,
      trackCount: album.totalTracks
    });
  }

  if (parsed.type === 'playlist') {
    const playlist = await getPublicPlaylist(parsed.id);
    if (!playlist) {
      return res.status(404).json({ error: 'Playlist not found' });
    }
    return res.json({
      type: 'playlist',
      name: playlist.name,
      images: playlist.images,
      owner: playlist.owner,
      trackCount: playlist.totalTracks
    });
  }

  return res.status(400).json({ error: 'Invalid Spotify URL. Please use an album or playlist link.' });
});

export default router;
