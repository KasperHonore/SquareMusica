import { Router } from 'express';
import { randomUUID } from 'crypto';
import { db } from '../../database/db.js';
import { authMiddleware } from '../middleware/auth.js';
import {
  parseSpotifyUrl,
  getPublicPlaylistTracks,
  getPublicAlbumTracks
} from '../../music/spotify.js';

const router = Router();

// All playlist routes require authentication
router.use(authMiddleware);

// GET /api/playlists - Get all playlists
router.get('/', (req, res) => {
  try {
    const playlists = db.getPlaylists();
    res.json(playlists);
  } catch (error) {
    console.error('[Playlists API] Get failed:', error);
    res.status(500).json({ error: 'Failed to fetch playlists' });
  }
});

// POST /api/playlists - Create a new playlist
router.post('/', (req, res) => {
  try {
    const { name, spotifyUrl, coverImage } = req.body;

    if (!name || !spotifyUrl) {
      return res.status(400).json({ error: 'Name and Spotify URL are required' });
    }

    const id = 'playlist_' + Date.now().toString(36) + randomUUID().slice(0, 8);
    const createdBy = req.user.username;
    const playlist = db.createPlaylist(id, name, spotifyUrl, coverImage, createdBy);

    if (!playlist) {
      return res.status(500).json({ error: 'Failed to create playlist' });
    }

    res.status(201).json(playlist);
  } catch (error) {
    console.error('[Playlists API] Create failed:', error);
    res.status(500).json({ error: 'Failed to create playlist' });
  }
});

// GET /api/playlists/:id/tracks - Get tracks from a playlist's Spotify URL
router.get('/:id/tracks', async (req, res) => {
  try {
    const { id } = req.params;
    const playlist = db.getPlaylistById(id);

    if (!playlist) {
      return res.status(404).json({ error: 'Playlist not found' });
    }

    const { type, id: spotifyId } = parseSpotifyUrl(playlist.spotify_url);

    if (type !== 'playlist' && type !== 'album') {
      return res.status(400).json({ error: 'Invalid Spotify URL type' });
    }

    // Get tracks based on type (playlist or album)
    let tracks;
    if (type === 'playlist') {
      tracks = await getPublicPlaylistTracks(spotifyId);
    } else {
      tracks = await getPublicAlbumTracks(spotifyId);
    }

    res.json({
      playlistId: id,
      name: playlist.name,
      coverImage: playlist.cover_image,
      tracks
    });
  } catch (error) {
    console.error('[Playlists API] Get tracks failed:', error);
    res.status(500).json({ error: 'Failed to fetch playlist tracks' });
  }
});

// DELETE /api/playlists/:id - Delete a playlist
router.delete('/:id', (req, res) => {
  try {
    const { id } = req.params;
    const deleted = db.deletePlaylist(id);

    if (!deleted) {
      return res.status(404).json({ error: 'Playlist not found' });
    }

    res.json({ success: true });
  } catch (error) {
    console.error('[Playlists API] Delete failed:', error);
    res.status(500).json({ error: 'Failed to delete playlist' });
  }
});

export default router;
