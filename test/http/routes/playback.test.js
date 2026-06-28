import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import express from 'express';

// The playback router transitively imports the music manager (Discord client),
// the voice manager, and the SQLite-backed db via the auth middleware. All are
// mocked so the router mounts without native bindings. Auth is a pass-through
// that injects a user, and isConnected returns true, so each request reaches
// the action-validation logic under test.
vi.mock('../../../src/core/musicManager.js', () => ({
  musicManager: {
    guildId: 'g1',
    getPlayerState: vi.fn(() => ({ playing: false })),
    play: vi.fn(() => true),
    pause: vi.fn(() => true),
    skip: vi.fn(() => true),
    stop: vi.fn(() => true),
    setLoop: vi.fn(() => true)
  }
}));
vi.mock('../../../src/transports/http/middleware/auth.js', () => ({
  authMiddleware: (req, _res, next) => {
    req.user = { username: 'tester', discord_id: 'd1' };
    next();
  },
  optionalAuth: (req, _res, next) => {
    req.user = { username: 'tester', discord_id: 'd1' };
    next();
  }
}));
vi.mock('../../../src/transports/discord/voiceManager.js', () => ({
  isConnected: vi.fn(() => true)
}));

import playbackRouter from '../../../src/transports/http/routes/playback.js';
import { musicManager } from '../../../src/core/musicManager.js';
import { isConnected } from '../../../src/transports/discord/voiceManager.js';

let server;
let baseUrl;

function post(action, body) {
  return fetch(`${baseUrl}/api/player/${action}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body ?? {})
  });
}

beforeEach(async () => {
  vi.clearAllMocks();
  musicManager.guildId = 'g1';
  isConnected.mockReturnValue(true);
  musicManager.getPlayerState.mockReturnValue({ playing: false });

  const app = express();
  app.use(express.json());
  app.use('/api/player', playbackRouter);

  server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

afterEach(async () => {
  await new Promise((resolve) => server.close(resolve));
});

describe('POST /api/player/:action validation', () => {
  it('rejects an action outside the allowed set with 400 Unknown action', async () => {
    const res = await post('explode');

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'Unknown action' });
    expect(musicManager.play).not.toHaveBeenCalled();
  });

  it('rejects loop with an invalid value with 400 Invalid loop mode', async () => {
    const res = await post('loop', { value: 'sideways' });

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'Invalid loop mode' });
    expect(musicManager.setLoop).not.toHaveBeenCalled();
  });

  it('returns 400 when the bot is not in a voice channel', async () => {
    isConnected.mockReturnValue(false);

    const res = await post('play');

    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/not in a voice channel/i);
    expect(musicManager.play).not.toHaveBeenCalled();
  });

  it('dispatches a valid play action to the music manager', async () => {
    const res = await post('play');

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.state).toEqual({ playing: false });
    expect(musicManager.play).toHaveBeenCalledTimes(1);
  });

  it('dispatches a valid loop action with an allowed value', async () => {
    const res = await post('loop', { value: 'track' });

    expect(res.status).toBe(200);
    expect((await res.json()).success).toBe(true);
    expect(musicManager.setLoop).toHaveBeenCalledWith('track');
  });

  it('dispatches pause/skip/stop actions to the matching manager method', async () => {
    await post('pause');
    await post('skip');
    await post('stop');

    expect(musicManager.pause).toHaveBeenCalledTimes(1);
    expect(musicManager.skip).toHaveBeenCalledTimes(1);
    expect(musicManager.stop).toHaveBeenCalledTimes(1);
  });
});
