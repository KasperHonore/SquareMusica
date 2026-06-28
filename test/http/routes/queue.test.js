import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import express from 'express';

// The queue router transitively imports the SQLite-backed db, the music manager
// (which opens the Discord client), youtube (yt-dlp), and the voice manager.
// All of those are mocked so the router can be mounted without native bindings
// or network. queueHelpers is left REAL because it is pure and part of the
// behavior under test (validation + error mapping). Auth is mocked to a
// pass-through that injects a user so we exercise the validation path directly.
vi.mock('../../../src/core/musicManager.js', () => ({
  musicManager: {
    guildId: 'g1',
    getQueue: vi.fn(() => []),
    getCurrentIndex: vi.fn(() => 0),
    getCurrentTrack: vi.fn(() => null),
    addTracks: vi.fn(() => ({ tracks: [], lazyResolution: false })),
    removeFromQueue: vi.fn(() => true),
    reorderQueue: vi.fn(() => true),
    shuffleQueue: vi.fn(),
    clearQueue: vi.fn()
  }
}));
vi.mock('../../../src/transports/http/middleware/auth.js', () => ({
  authMiddleware: (req, _res, next) => {
    req.user = { username: 'tester', discord_id: 'd1', avatar: null };
    next();
  },
  optionalAuth: (req, _res, next) => {
    req.user = { username: 'tester', discord_id: 'd1', avatar: null };
    next();
  }
}));
vi.mock('../../../src/integrations/youtube.js', () => ({ search: vi.fn() }));
vi.mock('../../../src/transports/discord/voiceManager.js', () => ({
  isConnected: vi.fn(() => true)
}));
vi.mock('../../../src/services/trackResolver.js', () => ({ resolveQuery: vi.fn() }));
vi.mock('../../../src/persistence/db.js', () => ({ db: { getHistory: vi.fn(() => []) } }));
vi.mock('../../../src/utils/logger.js', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() }
}));

import queueRouter from '../../../src/transports/http/routes/queue.js';
import { musicManager } from '../../../src/core/musicManager.js';

let server;
let baseUrl;

beforeEach(async () => {
  vi.clearAllMocks();
  // Re-apply defaults cleared by clearAllMocks.
  musicManager.guildId = 'g1';
  musicManager.removeFromQueue.mockReturnValue(true);
  musicManager.reorderQueue.mockReturnValue(true);

  const app = express();
  app.use(express.json());
  app.use('/api/queue', queueRouter);

  server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

afterEach(async () => {
  await new Promise((resolve) => server.close(resolve));
});

describe('DELETE /api/queue/:position validation', () => {
  it('rejects a non-integer position with 400 Invalid position', async () => {
    musicManager.getQueue.mockReturnValue([{}, {}, {}]);

    const res = await fetch(`${baseUrl}/api/queue/abc`, { method: 'DELETE' });

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'Invalid position' });
    expect(musicManager.removeFromQueue).not.toHaveBeenCalled();
  });

  it('rejects a negative position with 400 Invalid position', async () => {
    musicManager.getQueue.mockReturnValue([{}, {}, {}]);

    const res = await fetch(`${baseUrl}/api/queue/-1`, { method: 'DELETE' });

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'Invalid position' });
    expect(musicManager.removeFromQueue).not.toHaveBeenCalled();
  });

  it('rejects a position >= queue length with 400 Invalid position', async () => {
    musicManager.getQueue.mockReturnValue([{}, {}, {}]); // length 3

    const res = await fetch(`${baseUrl}/api/queue/3`, { method: 'DELETE' });

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'Invalid position' });
    expect(musicManager.removeFromQueue).not.toHaveBeenCalled();
  });

  it('removes a valid in-range position and reports success', async () => {
    musicManager.getQueue.mockReturnValue([{}, {}, {}]);
    musicManager.removeFromQueue.mockReturnValue(true);

    const res = await fetch(`${baseUrl}/api/queue/1`, { method: 'DELETE' });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true });
    expect(musicManager.removeFromQueue).toHaveBeenCalledWith(1);
  });

  it('returns 404 when the manager reports nothing at that position', async () => {
    musicManager.getQueue.mockReturnValue([{}, {}, {}]);
    musicManager.removeFromQueue.mockReturnValue(false);

    const res = await fetch(`${baseUrl}/api/queue/2`, { method: 'DELETE' });

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'Track not found at position' });
  });
});

describe('PATCH /api/queue/reorder validation', () => {
  function patch(body) {
    return fetch(`${baseUrl}/api/queue/reorder`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
  }

  it('rejects a missing from/to with 400 "from and to are required"', async () => {
    musicManager.getQueue.mockReturnValue([{}, {}, {}]);

    const res = await patch({});

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'from and to are required' });
    expect(musicManager.reorderQueue).not.toHaveBeenCalled();
  });

  it('rejects an out-of-range position with 400 Invalid positions', async () => {
    musicManager.getQueue.mockReturnValue([{}, {}, {}]); // length 3

    const res = await patch({ from: 0, to: 5 });

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'Invalid positions' });
    expect(musicManager.reorderQueue).not.toHaveBeenCalled();
  });

  it('rejects a non-integer position with 400 Invalid positions', async () => {
    musicManager.getQueue.mockReturnValue([{}, {}, {}]);

    const res = await patch({ from: 0.5, to: 1 });

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'Invalid positions' });
    expect(musicManager.reorderQueue).not.toHaveBeenCalled();
  });

  it('reorders valid in-range positions and reports success', async () => {
    musicManager.getQueue.mockReturnValue([{}, {}, {}]);
    musicManager.reorderQueue.mockReturnValue(true);

    const res = await patch({ from: 0, to: 2 });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true });
    expect(musicManager.reorderQueue).toHaveBeenCalledWith(0, 2);
  });
});
