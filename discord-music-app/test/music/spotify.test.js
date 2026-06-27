import { describe, it, expect } from 'vitest';
import { parseSpotifyUrl } from '../../src/music/spotify.js';

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
