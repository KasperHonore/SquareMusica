import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the Spotify SDK so getClient() builds a fake client whose paged endpoints
// we drive from the tests. withClientCredentials is only consulted once (the
// client is cached), so we keep its implementation and reset the endpoint mocks.
const getPlaylistItems = vi.fn();
const albumsGet = vi.fn();

vi.mock('@spotify/web-api-ts-sdk', () => ({
  SpotifyApi: {
    withClientCredentials: vi.fn(() => ({
      playlists: { getPlaylistItems },
      albums: { get: albumsGet }
    }))
  }
}));

// Credentials must be present before the module is imported so getClient()
// constructs the (mocked) client instead of returning null.
process.env.SPOTIFY_CLIENT_ID = 'test-id';
process.env.SPOTIFY_CLIENT_SECRET = 'test-secret';

const {
  parseSpotifyUrl,
  getPublicPlaylistTracks,
  getPublicAlbumTracks,
  MAX_PLAYLIST_TRACKS,
  MAX_ALBUM_TRACKS
} = await import('../../src/integrations/spotify.js');

function makeTrack(i) {
  return {
    track: {
      id: `t${i}`,
      name: `Track ${i}`,
      artists: [{ name: 'Artist' }],
      duration_ms: 1000,
      external_urls: { spotify: `https://open.spotify.com/track/t${i}` },
      is_local: false
    }
  };
}

function makePlaylistPage(count, { total, next }) {
  return {
    total,
    next,
    items: Array.from({ length: count }, (_, i) => makeTrack(i))
  };
}

function makeAlbum(itemCount, totalTracks) {
  return {
    total_tracks: totalTracks,
    tracks: {
      items: Array.from({ length: itemCount }, (_, i) => ({
        id: `a${i}`,
        name: `Album Track ${i}`,
        artists: [{ name: 'Artist' }],
        duration_ms: 1000,
        external_urls: { spotify: `https://open.spotify.com/track/a${i}` }
      }))
    }
  };
}

describe('parseSpotifyUrl', () => {
  describe('spotify: URI format', () => {
    it('parses a track URI', () => {
      expect(parseSpotifyUrl('spotify:track:6rqhFgbbKwnb9MLmUQDhG6')).toEqual({
        type: 'track',
        id: '6rqhFgbbKwnb9MLmUQDhG6'
      });
    });

    it('parses a playlist URI', () => {
      expect(parseSpotifyUrl('spotify:playlist:37i9dQZF1DXcBWIGoYBM5M')).toEqual({
        type: 'playlist',
        id: '37i9dQZF1DXcBWIGoYBM5M'
      });
    });

    it('parses an album URI', () => {
      expect(parseSpotifyUrl('spotify:album:1DFixLWuPkv3KT3TnV35m3')).toEqual({
        type: 'album',
        id: '1DFixLWuPkv3KT3TnV35m3'
      });
    });

    it('trims surrounding whitespace before matching', () => {
      expect(parseSpotifyUrl('  spotify:track:abc123  ')).toEqual({
        type: 'track',
        id: 'abc123'
      });
    });

    it('rejects an unsupported URI type (e.g. artist)', () => {
      expect(parseSpotifyUrl('spotify:artist:0OdUWJ0sBjDrqHygGUXeCF')).toEqual({
        type: null,
        id: null
      });
    });
  });

  describe('open.spotify.com URL format', () => {
    it('parses a track URL', () => {
      expect(parseSpotifyUrl('https://open.spotify.com/track/6rqhFgbbKwnb9MLmUQDhG6')).toEqual({
        type: 'track',
        id: '6rqhFgbbKwnb9MLmUQDhG6'
      });
    });

    it('parses a playlist URL', () => {
      expect(parseSpotifyUrl('https://open.spotify.com/playlist/37i9dQZF1DXcBWIGoYBM5M')).toEqual({
        type: 'playlist',
        id: '37i9dQZF1DXcBWIGoYBM5M'
      });
    });

    it('parses an album URL', () => {
      expect(parseSpotifyUrl('https://open.spotify.com/album/1DFixLWuPkv3KT3TnV35m3')).toEqual({
        type: 'album',
        id: '1DFixLWuPkv3KT3TnV35m3'
      });
    });

    it('ignores a ?si= share query param', () => {
      expect(
        parseSpotifyUrl('https://open.spotify.com/track/6rqhFgbbKwnb9MLmUQDhG6?si=abc123def456')
      ).toEqual({ type: 'track', id: '6rqhFgbbKwnb9MLmUQDhG6' });
    });

    it('ignores arbitrary query params', () => {
      expect(
        parseSpotifyUrl('https://open.spotify.com/playlist/37i9dQZF1DXcBWIGoYBM5M?foo=bar&x=1')
      ).toEqual({ type: 'playlist', id: '37i9dQZF1DXcBWIGoYBM5M' });
    });

    it('returns nulls for a spotify.com URL with no recognized path', () => {
      expect(parseSpotifyUrl('https://open.spotify.com/search/something')).toEqual({
        type: null,
        id: null
      });
    });
  });

  describe('non-spotify and invalid input', () => {
    it('returns nulls for a non-spotify URL', () => {
      expect(parseSpotifyUrl('https://www.youtube.com/watch?v=dQw4w9WgXcQ')).toEqual({
        type: null,
        id: null
      });
    });

    it('returns nulls for a bare host without a scheme (URL constructor throws)', () => {
      expect(parseSpotifyUrl('open.spotify.com/track/abc123')).toEqual({
        type: null,
        id: null
      });
    });

    it('returns nulls for arbitrary garbage', () => {
      expect(parseSpotifyUrl('not a url at all')).toEqual({ type: null, id: null });
    });

    it('returns nulls for an empty string', () => {
      expect(parseSpotifyUrl('')).toEqual({ type: null, id: null });
    });

    it('returns nulls for null', () => {
      expect(parseSpotifyUrl(null)).toEqual({ type: null, id: null });
    });

    it('returns nulls for undefined', () => {
      expect(parseSpotifyUrl(undefined)).toEqual({ type: null, id: null });
    });

    it('returns nulls for non-string input (number)', () => {
      expect(parseSpotifyUrl(12345)).toEqual({ type: null, id: null });
    });

    it('returns nulls for non-string input (object)', () => {
      expect(parseSpotifyUrl({})).toEqual({ type: null, id: null });
    });
  });
});

describe('getPublicPlaylistTracks', () => {
  beforeEach(() => {
    getPlaylistItems.mockReset();
  });

  it('returns { tracks, total, truncated } for a small playlist (not truncated)', async () => {
    getPlaylistItems.mockResolvedValueOnce(makePlaylistPage(50, { total: 50, next: null }));

    const result = await getPublicPlaylistTracks('pl-small');

    expect(result.tracks).toHaveLength(50);
    expect(result.total).toBe(50);
    expect(result.truncated).toBe(false);
    expect(result.tracks[0]).toEqual({
      spotifyId: 't0',
      title: 'Track 0',
      artists: ['Artist'],
      durationMs: 1000,
      spotifyUrl: 'https://open.spotify.com/track/t0'
    });
  });

  it('truncates and reports the true total when the playlist exceeds the cap', async () => {
    // Each page returns 100 items and signals more pages via `next`, with a
    // total well above the cap.
    getPlaylistItems.mockResolvedValue(
      makePlaylistPage(100, { total: 650, next: 'https://api.spotify.com/next' })
    );

    const result = await getPublicPlaylistTracks('pl-huge');

    expect(result.tracks).toHaveLength(MAX_PLAYLIST_TRACKS);
    expect(result.total).toBe(650);
    expect(result.truncated).toBe(true);
  });

  it('does not flag truncation for a playlist exactly at the cap', async () => {
    getPlaylistItems.mockResolvedValue(
      makePlaylistPage(100, { total: MAX_PLAYLIST_TRACKS, next: 'https://api.spotify.com/next' })
    );

    const result = await getPublicPlaylistTracks('pl-exact');

    expect(result.tracks).toHaveLength(MAX_PLAYLIST_TRACKS);
    expect(result.total).toBe(MAX_PLAYLIST_TRACKS);
    expect(result.truncated).toBe(false);
  });
});

describe('getPublicAlbumTracks', () => {
  beforeEach(() => {
    albumsGet.mockReset();
  });

  it('returns { tracks, total, truncated } for a small album (not truncated)', async () => {
    albumsGet.mockResolvedValueOnce(makeAlbum(10, 10));

    const result = await getPublicAlbumTracks('al-small');

    expect(result.tracks).toHaveLength(10);
    expect(result.total).toBe(10);
    expect(result.truncated).toBe(false);
    expect(result.tracks[0]).toEqual({
      spotifyId: 'a0',
      title: 'Album Track 0',
      artists: ['Artist'],
      durationMs: 1000,
      spotifyUrl: 'https://open.spotify.com/track/a0'
    });
  });

  it('truncates and reports the true total when the album exceeds the embed limit', async () => {
    albumsGet.mockResolvedValueOnce(makeAlbum(MAX_ALBUM_TRACKS, 72));

    const result = await getPublicAlbumTracks('al-huge');

    expect(result.tracks).toHaveLength(MAX_ALBUM_TRACKS);
    expect(result.total).toBe(72);
    expect(result.truncated).toBe(true);
  });
});
