import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// resolver.js imports the YouTube integration (which pulls in yt-dlp/network
// plumbing) and the logger. We only exercise the exported LruCache helper here,
// so both are mocked to keep this a pure unit test with no side effects.
vi.mock('../../src/integrations/youtube.js', () => ({ search: vi.fn() }));
vi.mock('../../src/utils/logger.js', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() }
}));

import { LruCache } from '../../src/services/resolver.js';

describe('LruCache', () => {
  it('stays bounded when driven past its cap', () => {
    const cache = new LruCache({ maxEntries: 3, ttlMs: 60_000 });
    for (let i = 0; i < 50; i++) {
      cache.set(`k${i}`, i);
    }
    expect(cache.size).toBe(3);
    // Only the three most-recently-inserted keys survive.
    expect(cache.has('k49')).toBe(true);
    expect(cache.has('k48')).toBe(true);
    expect(cache.has('k47')).toBe(true);
    expect(cache.has('k46')).toBe(false);
  });

  it('evicts the least-recently-used key, keeping recently-used ones', () => {
    const cache = new LruCache({ maxEntries: 3, ttlMs: 60_000 });
    cache.set('a', 1);
    cache.set('b', 2);
    cache.set('c', 3);

    // Touch 'a' so it becomes most-recently-used; 'b' is now the LRU entry.
    expect(cache.get('a')).toBe(1);

    // Inserting a 4th key evicts the LRU entry ('b'), not the freshly-used 'a'.
    cache.set('d', 4);

    expect(cache.size).toBe(3);
    expect(cache.has('a')).toBe(true);
    expect(cache.has('b')).toBe(false);
    expect(cache.has('c')).toBe(true);
    expect(cache.has('d')).toBe(true);
  });

  it('honors TTL: expired entries miss and are dropped', () => {
    vi.useFakeTimers();
    try {
      const cache = new LruCache({ maxEntries: 10, ttlMs: 1000 });
      cache.set('x', 'value');
      expect(cache.get('x')).toBe('value');

      vi.advanceTimersByTime(1001);

      // get() returns the MISS sentinel (i.e. not the stored value) and prunes it.
      expect(cache.get('x')).not.toBe('value');
      expect(cache.has('x')).toBe(false);
      expect(cache.size).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });
});
