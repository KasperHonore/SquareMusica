import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// setupSocketServer transitively pulls in the SQLite-backed db and the Discord
// client (native bindings that cannot boot in CI), so every heavy collaborator
// is mocked. musicManager and botEvents are real EventEmitters (created inside
// the async mock factories, then imported below) so we can assert listenerCount
// before/after to prove setup is idempotent and shutdown reverses it.
vi.mock('../../../src/core/musicManager.js', async () => {
  const { EventEmitter } = await import('events');
  return { musicManager: new EventEmitter() };
});
vi.mock('../../../src/transports/discord/client.js', async () => {
  const { EventEmitter } = await import('events');
  return { botEvents: new EventEmitter() };
});
vi.mock('../../../src/persistence/db.js', () => ({
  db: {
    getPlaylists: vi.fn(() => []),
    createPlaylist: vi.fn(),
    deletePlaylist: vi.fn()
  }
}));
vi.mock('../../../src/utils/logger.js', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() }
}));
vi.mock('../../../src/transports/http/middleware/auth.js', () => ({
  verifyToken: vi.fn(() => ({ user: { username: 'tester' } }))
}));
vi.mock('../../../src/transports/realtime/handlers.js', () => ({
  handleQueueAdd: vi.fn(() => vi.fn()),
  handleQueueRemove: vi.fn(() => vi.fn()),
  handleQueueReorder: vi.fn(() => vi.fn()),
  handlePlayerControl: vi.fn(() => vi.fn()),
  handleVoiceJoin: vi.fn(() => vi.fn()),
  handleVoiceLeave: vi.fn(() => vi.fn())
}));

const fakeIo = { use: vi.fn(), on: vi.fn(), emit: vi.fn(), close: vi.fn() };
vi.mock('socket.io', () => ({
  Server: vi.fn(function Server() {
    return fakeIo;
  })
}));

import { musicManager } from '../../../src/core/musicManager.js';
import { botEvents } from '../../../src/transports/discord/client.js';
import {
  setupSocketServer,
  shutdownSocketServer
} from '../../../src/transports/realtime/socketServer.js';

const MANAGER_EVENTS = [
  'queue:update',
  'track:change',
  'player:state',
  'resolution:progress',
  'voice:context'
];

describe('socketServer setup idempotency', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    shutdownSocketServer();
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it('calling setup twice does not duplicate listeners or the progress interval', () => {
    setupSocketServer({});
    const afterFirst = MANAGER_EVENTS.map((e) => musicManager.listenerCount(e));

    setupSocketServer({});
    const afterSecond = MANAGER_EVENTS.map((e) => musicManager.listenerCount(e));

    // Exactly one listener per event, unchanged across the second setup.
    expect(afterSecond).toEqual(afterFirst);
    afterSecond.forEach((count) => expect(count).toBe(1));
    expect(botEvents.listenerCount('historyCleared')).toBe(1);
    // Exactly one progress interval is pending.
    expect(vi.getTimerCount()).toBe(1);
  });

  it('shutdown fully reverses setup', () => {
    setupSocketServer({});
    shutdownSocketServer();

    MANAGER_EVENTS.forEach((e) => expect(musicManager.listenerCount(e)).toBe(0));
    expect(botEvents.listenerCount('historyCleared')).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    expect(fakeIo.close).toHaveBeenCalledTimes(1);
  });
});
