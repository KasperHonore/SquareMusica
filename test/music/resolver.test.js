import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock YouTube search so resolveSpotifyTrack's scoring/threshold/caching can be
// exercised deterministically without touching the network or yt-dlp.
vi.mock('../../src/integrations/youtube.js', () => ({
  search: vi.fn()
}));

import { search } from '../../src/integrations/youtube.js';
import { resolveSpotifyTrack } from '../../src/services/resolver.js';

// scoreMatch is NOT exported, so it is characterized indirectly through
// resolveSpotifyTrack: the function returns the best YouTube match only when the
// computed score is >= 50, otherwise null. Tests below pick inputs that flip
// across that 50-point threshold to isolate each scoring contribution.
//
// IMPORTANT: the resolver keeps a module-level cache keyed by
// `${artists}:${title}` with no exported reset, so each test uses a UNIQUE
// artist key to guarantee a fresh cache entry instead of clearing the cache.

const yt = (overrides = {}) => ({
  url: 'https://youtu.be/vid',
  title: 'some title',
  channel: 'Neutral',
  duration: 0,
  thumbnail: 'thumb.jpg',
  ...overrides
});

beforeEach(() => {
  vi.clearAllMocks();
  // Silence the resolver's console chatter during the run.
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('resolveSpotifyTrack', () => {
  describe('short-circuits before searching', () => {
    it('returns null for a local track without searching', async () => {
      const result = await resolveSpotifyTrack({
        is_local: true,
        title: 'whatever',
        artists: ['local']
      });
      expect(result).toBeNull();
      expect(search).not.toHaveBeenCalled();
    });

    it('returns null when the track has no title/name without searching', async () => {
      const result = await resolveSpotifyTrack({ artists: ['notitlekey'] });
      expect(result).toBeNull();
      expect(search).not.toHaveBeenCalled();
    });
  });

  describe('search results handling', () => {
    it('returns null when search yields no results, and serves the negative cache on the next call', async () => {
      search.mockResolvedValue([]);
      const track = { title: 'alpha beta', artists: ['k3empty'], durationMs: 0 };

      expect(await resolveSpotifyTrack(track)).toBeNull();
      expect(await resolveSpotifyTrack(track)).toBeNull();
      // The resolver caches a NEGATIVE sentinel for a no-match and getCached()
      // distinguishes a true miss from a cached negative, so the second lookup
      // of the same not-found track is served from cache without re-searching.
      expect(search).toHaveBeenCalledTimes(1);
    });

    it('returns the best match shape when the top score clears the threshold', async () => {
      search.mockResolvedValue([
        yt({
          url: 'https://youtu.be/best',
          title: 'alpha beta',
          channel: 'Neutral',
          duration: 205,
          thumbnail: 'best.jpg'
        })
      ]);
      const track = { title: 'alpha beta', artists: ['k5'], durationMs: 200000 };
      // title full match (30) + duration diff 5s (<=15 => 40) = 70 >= 50
      const result = await resolveSpotifyTrack(track);
      expect(result).toEqual({
        url: 'https://youtu.be/best',
        title: 'alpha beta',
        channel: 'Neutral',
        duration: 205,
        thumbnail: 'best.jpg'
      });
    });

    it('returns null when the best score is below the threshold', async () => {
      search.mockResolvedValue([yt({ title: 'alpha only', channel: 'Neutral', duration: 0 })]);
      // spotify title "alpha beta" vs youtube "alpha only": 1/2 words => 15, no
      // duration/channel points => 15 < 50.
      const track = { title: 'alpha beta', artists: ['k6'], durationMs: 0 };
      expect(await resolveSpotifyTrack(track)).toBeNull();
    });

    it('chooses the highest-scoring result among several', async () => {
      search.mockResolvedValue([
        yt({ url: 'https://youtu.be/low', title: 'alpha', channel: 'Neutral', duration: 999 }),
        yt({ url: 'https://youtu.be/high', title: 'alpha beta', channel: 'Neutral', duration: 205 })
      ]);
      const track = { title: 'alpha beta', artists: ['k7'], durationMs: 200000 };
      const result = await resolveSpotifyTrack(track);
      expect(result.url).toBe('https://youtu.be/high');
    });

    it('caches a positive result and does not re-search on the second call', async () => {
      search.mockResolvedValue([yt({ title: 'alpha beta', channel: 'Neutral', duration: 205 })]);
      const track = { title: 'alpha beta', artists: ['k8'], durationMs: 200000 };
      const first = await resolveSpotifyTrack(track);
      const second = await resolveSpotifyTrack(track);
      expect(first).not.toBeNull();
      expect(second).toEqual(first);
      expect(search).toHaveBeenCalledTimes(1);
    });
  });

  describe('duration scoring tiers (title contributes a fixed 15)', () => {
    // spotify title "alpha beta" vs youtube "alpha solo" => 1/2 word match = 15.
    const ytPartial = (duration) => yt({ title: 'alpha solo', channel: 'Neutral', duration });

    it('adds 40 points when the duration difference is <= 15s (15 + 40 = 55 passes)', async () => {
      search.mockResolvedValue([ytPartial(110)]); // |100 - 110| = 10
      const track = { title: 'alpha beta', artists: ['k9a'], durationMs: 100000 };
      expect(await resolveSpotifyTrack(track)).not.toBeNull();
    });

    it('adds only 20 points when the difference is in (15s, 30s] (15 + 20 = 35 fails)', async () => {
      search.mockResolvedValue([ytPartial(125)]); // |100 - 125| = 25
      const track = { title: 'alpha beta', artists: ['k9b'], durationMs: 100000 };
      expect(await resolveSpotifyTrack(track)).toBeNull();
    });

    it('adds no duration points when the difference exceeds 30s (15 + 0 = 15 fails)', async () => {
      search.mockResolvedValue([ytPartial(200)]); // |100 - 200| = 100
      const track = { title: 'alpha beta', artists: ['k9c'], durationMs: 100000 };
      expect(await resolveSpotifyTrack(track)).toBeNull();
    });
  });

  describe('channel scoring', () => {
    it('adds 20 points for an official/topic channel (30 + 20 = 50 passes)', async () => {
      search.mockResolvedValue([
        yt({ title: 'alpha beta', channel: 'Some Artist - Topic', duration: 0 })
      ]);
      const track = { title: 'alpha beta', artists: ['k10a'], durationMs: 0 };
      expect(await resolveSpotifyTrack(track)).not.toBeNull();
    });

    it('does not add the official bonus for a plain channel (30 only => fails)', async () => {
      search.mockResolvedValue([
        yt({ title: 'alpha beta', channel: 'Some Random Channel', duration: 0 })
      ]);
      const track = { title: 'alpha beta', artists: ['k10b'], durationMs: 0 };
      expect(await resolveSpotifyTrack(track)).toBeNull();
    });

    it('adds 10 points when an artist name appears in the channel (40 + 10 = 50 passes)', async () => {
      // Title overlap is 0 (no shared words); duration <=15s gives 40; artist match gives 10.
      search.mockResolvedValue([
        yt({ title: 'completely different', channel: 'k11aband uploads', duration: 110 })
      ]);
      const track = { title: 'zulu yankee', artists: ['k11aband'], durationMs: 100000 };
      expect(await resolveSpotifyTrack(track)).not.toBeNull();
    });

    it('does not add the artist bonus when the channel lacks the artist (40 only => fails)', async () => {
      search.mockResolvedValue([
        yt({ title: 'completely different', channel: 'neutral uploads', duration: 110 })
      ]);
      const track = { title: 'zulu yankee', artists: ['k11bband'], durationMs: 100000 };
      expect(await resolveSpotifyTrack(track)).toBeNull();
    });
  });
});
