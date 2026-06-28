import { describe, it, expect, vi, beforeEach } from 'vitest';

// trackResolver.js imports youtube.js, spotify.js, and resolutionManager.js at
// module load. tryPlayWithFallback itself uses none of them (it only touches the
// player/queue/connection arguments), so we mock those modules purely to avoid
// any import-time side effects (yt-dlp path resolution, Spotify SDK, etc.).
vi.mock('../../src/integrations/youtube.js', () => ({
  search: vi.fn(),
  getInfo: vi.fn(),
  isValidUrl: vi.fn(),
  isPlaylist: vi.fn(),
  getPlaylist: vi.fn()
}));
vi.mock('../../src/integrations/spotify.js', () => ({
  parseSpotifyUrl: vi.fn(),
  getPublicTrack: vi.fn(),
  getPublicPlaylistTracks: vi.fn(),
  getPublicAlbumTracks: vi.fn()
}));
vi.mock('../../src/services/resolutionManager.js', () => ({
  ResolutionManager: class {}
}));

import { tryPlayWithFallback } from '../../src/services/trackResolver.js';

const connection = { id: 'conn' };

describe('tryPlayWithFallback', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns {played:false} immediately when connection is null', async () => {
    const player = { play: vi.fn() };
    const queue = { getCurrent: vi.fn(), next: vi.fn() };

    const result = await tryPlayWithFallback(player, queue, null);

    expect(result).toEqual({ played: false, track: null });
    expect(player.play).not.toHaveBeenCalled();
    expect(queue.getCurrent).not.toHaveBeenCalled();
    expect(queue.next).not.toHaveBeenCalled();
  });

  it('plays the current track on the first try and does not advance', async () => {
    const current = { id: 'a' };
    const player = { play: vi.fn().mockResolvedValue(true) };
    const queue = {
      getCurrent: vi.fn().mockReturnValue(current),
      next: vi.fn()
    };

    const result = await tryPlayWithFallback(player, queue, connection);

    expect(result).toEqual({ played: true, track: current });
    expect(player.play).toHaveBeenCalledTimes(1);
    expect(player.play).toHaveBeenCalledWith(current, connection);
    expect(queue.next).not.toHaveBeenCalled();
  });

  it('advances through queue.next() until a track plays successfully', async () => {
    const t1 = { id: 'a' };
    const t2 = { id: 'b' };
    const t3 = { id: 'c' };
    const player = {
      play: vi
        .fn()
        .mockResolvedValueOnce(false) // t1 fails
        .mockResolvedValueOnce(false) // t2 fails
        .mockResolvedValueOnce(true) // t3 succeeds
    };
    const queue = {
      getCurrent: vi.fn().mockReturnValue(t1),
      next: vi.fn().mockReturnValueOnce(t2).mockReturnValueOnce(t3)
    };

    const result = await tryPlayWithFallback(player, queue, connection);

    expect(result).toEqual({ played: true, track: t3 });
    expect(player.play).toHaveBeenCalledTimes(3);
    expect(queue.next).toHaveBeenCalledTimes(2);
  });

  it('returns {played:false} when the queue is exhausted without a successful play', async () => {
    const t1 = { id: 'a' };
    const t2 = { id: 'b' };
    const player = { play: vi.fn().mockResolvedValue(false) };
    const queue = {
      getCurrent: vi.fn().mockReturnValue(t1),
      next: vi.fn().mockReturnValueOnce(t2).mockReturnValueOnce(null)
    };

    const result = await tryPlayWithFallback(player, queue, connection);

    expect(result).toEqual({ played: false, track: null });
    expect(player.play).toHaveBeenCalledTimes(2);
    expect(queue.next).toHaveBeenCalledTimes(2);
  });

  it('starts from queue.next() (skipping current) when skipCurrent is true', async () => {
    const next = { id: 'b' };
    const player = { play: vi.fn().mockResolvedValue(true) };
    const queue = {
      getCurrent: vi.fn(),
      next: vi.fn().mockReturnValue(next)
    };

    const result = await tryPlayWithFallback(player, queue, connection, true);

    expect(result).toEqual({ played: true, track: next });
    expect(queue.getCurrent).not.toHaveBeenCalled();
    expect(queue.next).toHaveBeenCalledTimes(1);
    expect(player.play).toHaveBeenCalledWith(next, connection);
  });
});
