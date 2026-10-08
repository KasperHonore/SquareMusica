import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import express from 'express';

// SC-006: all six tracked actions must be recorded on all three surfaces — 18
// combinations. A missed emit site fails silently: the action still works, nothing
// errors, and an award is simply wrong forever, so nothing but a matrix test
// catches it.
//
// Shape-equality between surfaces is deliberately NOT the only assertion here.
// Three surfaces that all uniformly omit `track` on pause are identically shaped
// and identically wrong, so `track` nullability is asserted per action type
// against the contract, not against what the other surfaces happen to do.
vi.mock('../../src/core/musicManager.js', () => {
  const currentTrack = {
    title: 'Current Song',
    url: 'https://example.com/current',
    requestedById: 'queuer-1',
    requestedBy: 'queuer'
  };
  const queuedTrack = {
    title: 'Queued Song',
    url: 'https://example.com/queued',
    requestedById: 'queuer-2',
    requestedBy: 'other-queuer'
  };
  return {
    musicManager: {
      guildId: 'g1',
      __currentTrack: currentTrack,
      __queuedTrack: queuedTrack,
      getCurrentTrack: vi.fn(() => currentTrack),
      getQueue: vi.fn(() => [currentTrack, queuedTrack]),
      getCurrentIndex: vi.fn(() => 0),
      getPlayerState: vi.fn(() => ({ playing: true })),
      play: vi.fn(() => true),
      pause: vi.fn(() => true),
      skip: vi.fn(() => true),
      stop: vi.fn(() => true),
      setLoop: vi.fn(() => true),
      shuffleQueue: vi.fn(() => ({ shuffled: true })),
      clearQueue: vi.fn(),
      clearUpcomingQueue: vi.fn(),
      clearAllButCurrent: vi.fn(),
      removeFromQueue: vi.fn(() => true),
      reorderQueue: vi.fn(() => true),
      emitQueueUpdate: vi.fn(),
      emit: vi.fn(),
      emitState: vi.fn(),
      ensurePlaying: vi.fn().mockResolvedValue(undefined),
      addTracks: vi.fn(() => ({ tracks: [], lazyResolution: false }))
    }
  };
});
vi.mock('../../src/transports/http/middleware/auth.js', () => ({
  authMiddleware: (req, _res, next) => {
    req.user = { username: 'http-actor', discord_id: 'http-1', avatar: 'av-http' };
    next();
  },
  optionalAuth: (req, _res, next) => {
    req.user = { username: 'http-actor', discord_id: 'http-1', avatar: 'av-http' };
    next();
  }
}));
vi.mock('../../src/transports/discord/voiceManager.js', () => ({
  isConnected: vi.fn(() => true),
  getConnection: vi.fn(() => ({ id: 'conn-1' })),
  joinChannel: vi.fn(),
  leaveChannel: vi.fn(() => true),
  setChannelCache: vi.fn(),
  getChannelCache: vi.fn(() => null),
  getChannelInfo: vi.fn(() => null)
}));
vi.mock('../../src/transports/discord/client.js', () => ({
  client: { isReady: vi.fn(() => true), guilds: { fetch: vi.fn() } }
}));
vi.mock('../../src/transports/discord/commands/utils/checks.js', () => ({
  requireVoiceConnection: vi.fn().mockResolvedValue(true)
}));
vi.mock('../../src/services/trackResolver.js', () => ({
  resolveQuery: vi.fn(),
  tryPlayWithFallback: vi.fn()
}));
vi.mock('../../src/persistence/db.js', () => ({
  db: { logEvent: vi.fn(), getHistory: vi.fn(() => []) }
}));
vi.mock('../../src/integrations/youtube.js', () => ({ search: vi.fn() }));
vi.mock('../../src/utils/logger.js', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() }
}));

// The Discord command handlers reach getPlayer()/getQueue()/advanceAndPlay()
// directly, bypassing the mediator — which is exactly why Discord needs its own
// emit sites, and why this module is stubbed rather than the mediator alone.
const discordPlayer = {
  currentTrack: {
    title: 'Current Song',
    url: 'https://example.com/current',
    requestedById: 'queuer-1',
    requestedBy: 'queuer'
  },
  isPlaying: vi.fn(() => true),
  isPaused: vi.fn(() => true),
  pause: vi.fn(),
  resume: vi.fn(),
  stop: vi.fn()
};
const discordQueue = {
  tracks: [],
  currentIndex: 0,
  length: 3,
  getAll: vi.fn(() => [
    { title: 'A', url: 'https://example.com/a', requestedById: 'q1', requestedBy: 'one' },
    { title: 'B', url: 'https://example.com/b', requestedById: 'q2', requestedBy: 'two' },
    { title: 'C', url: 'https://example.com/c', requestedById: 'q3', requestedBy: 'three' }
  ]),
  getCurrent: vi.fn(() => ({
    title: 'A',
    url: 'https://example.com/a',
    requestedById: 'q1',
    requestedBy: 'one'
  })),
  remove: vi.fn(() => ({
    title: 'B',
    url: 'https://example.com/b',
    requestedById: 'q2',
    requestedBy: 'two'
  })),
  shuffle: vi.fn(),
  clear: vi.fn()
};
vi.mock('../../src/services/playback.js', () => ({
  getPlayer: vi.fn(() => discordPlayer),
  getQueue: vi.fn(() => discordQueue),
  advanceAndPlay: vi.fn().mockResolvedValue({ played: true, track: { title: 'Next Song' } })
}));
vi.mock('../../src/services/resolutionManager.js', () => ({
  resolutionManager: { processLookahead: vi.fn(), stop: vi.fn(), processingTracks: new Set() }
}));

import { botEvents } from '../../src/events/bus.js';
import { STATS_EVENT } from '../../src/shared/statsEvents.js';
import playbackRouter from '../../src/transports/http/routes/playback.js';
import queueRouter from '../../src/transports/http/routes/queue.js';
import { handlePlayerControl, handleQueueRemove } from '../../src/transports/realtime/handlers.js';
import {
  handlePause as discordPause,
  handleResume as discordResume,
  handleSkip as discordSkip,
  handleStop as discordStop
} from '../../src/transports/discord/commands/playback.js';
import {
  handleRemove as discordRemove,
  handleShuffle as discordShuffle,
  handleClear as discordClear
} from '../../src/transports/discord/commands/queue.js';

/**
 * The contract's nullability table. `track` is non-null for actions that target
 * one specific track, and null for the two that act on the queue as a whole.
 */
const TRACK_EXPECTATION = {
  skip: 'non-null',
  pause: 'non-null',
  resume: 'non-null',
  remove: 'non-null',
  shuffle: 'null',
  clear_queue: 'null'
};

const TRACKED_ACTIONS = Object.keys(TRACK_EXPECTATION);

let captured;
let server;
let baseUrl;

function listener(payload) {
  captured.push(payload);
}

beforeEach(async () => {
  captured = [];
  botEvents.on(STATS_EVENT, listener);

  const app = express();
  app.use(express.json());
  app.use('/api/player', playbackRouter);
  app.use('/api/queue', queueRouter);
  server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

afterEach(async () => {
  botEvents.off(STATS_EVENT, listener);
  await new Promise((resolve) => server.close(resolve));
});

/** Events of one type seen since the last reset. */
function eventsOfType(type) {
  return captured.filter((e) => e.type === type);
}

function socket() {
  return {
    emit: vi.fn(),
    user: { username: 'socket-actor', discord_id: 'socket-1', avatar: 'av-socket' }
  };
}

function interaction() {
  return {
    guildId: 'g1',
    user: { id: 'discord-1', username: 'discord-actor', avatar: 'av-discord' },
    options: { getInteger: vi.fn(() => 2) },
    reply: vi.fn().mockResolvedValue(undefined),
    editReply: vi.fn().mockResolvedValue(undefined),
    deferReply: vi.fn().mockResolvedValue(undefined)
  };
}

/**
 * The three surfaces, each exposing one trigger per tracked action.
 *
 * HTTP records `resume` from its `play` action and realtime from its `'play'`
 * case: on both surfaces musicManager.play() calls player.resume(), and neither
 * has a separate resume action.
 */
const SURFACES = {
  http: {
    skip: () => fetch(`${baseUrl}/api/player/skip`, { method: 'POST' }),
    pause: () => fetch(`${baseUrl}/api/player/pause`, { method: 'POST' }),
    resume: () => fetch(`${baseUrl}/api/player/play`, { method: 'POST' }),
    remove: () => fetch(`${baseUrl}/api/queue/1`, { method: 'DELETE' }),
    shuffle: () => fetch(`${baseUrl}/api/queue/shuffle`, { method: 'POST' }),
    clear_queue: () => fetch(`${baseUrl}/api/queue`, { method: 'DELETE' })
  },
  realtime: {
    skip: () => handlePlayerControl(socket())({ action: 'skip' }),
    pause: () => handlePlayerControl(socket())({ action: 'pause' }),
    resume: () => handlePlayerControl(socket())({ action: 'play' }),
    remove: () => handleQueueRemove(socket())({ position: 1 }),
    shuffle: () => handlePlayerControl(socket())({ action: 'shuffle' }),
    clear_queue: () => handlePlayerControl(socket())({ action: 'clear' })
  },
  discord: {
    skip: () => discordSkip(interaction()),
    pause: () => discordPause(interaction()),
    resume: () => discordResume(interaction()),
    remove: () => discordRemove(interaction()),
    shuffle: () => discordShuffle(interaction()),
    clear_queue: () => discordClear(interaction())
  }
};

const EXPECTED_ACTOR = {
  http: 'http-1',
  realtime: 'socket-1',
  discord: 'discord-1'
};

describe('SC-006: all 18 action/surface combinations are recorded', () => {
  for (const surface of Object.keys(SURFACES)) {
    for (const action of TRACKED_ACTIONS) {
      it(`records ${action} from ${surface}`, async () => {
        await SURFACES[surface][action]();

        const events = eventsOfType(action);
        expect(events, `${surface} did not emit ${action}`).toHaveLength(1);
      });
    }
  }
});

describe('recorded payloads carry a non-null actor on every surface', () => {
  for (const surface of Object.keys(SURFACES)) {
    for (const action of TRACKED_ACTIONS) {
      it(`${surface} ${action} names who did it`, async () => {
        await SURFACES[surface][action]();

        const [event] = eventsOfType(action);
        expect(event.actor).not.toBeNull();
        expect(event.actor.id).toBe(EXPECTED_ACTOR[surface]);
        expect(event.actor.name).toBeTruthy();
      });
    }
  }
});

describe('track nullability matches the contract, per action type', () => {
  for (const surface of Object.keys(SURFACES)) {
    for (const action of TRACKED_ACTIONS) {
      const expectation = TRACK_EXPECTATION[action];
      it(`${surface} ${action} records track as ${expectation}`, async () => {
        await SURFACES[surface][action]();

        const [event] = eventsOfType(action);
        if (expectation === 'null') {
          expect(event.track).toBeNull();
        } else {
          expect(event.track, `${surface} ${action} recorded no track`).not.toBeNull();
          expect(event.track.title).toBeTruthy();
          expect(event.track.url).toBeTruthy();
          // The original requester is what lets an action be attributed to the
          // member whose track it affected (DJ Skip depends on this).
          expect(event.track).toHaveProperty('requestedById');
        }
      });
    }
  }
});

describe('payload shape is identical across surfaces', () => {
  for (const action of TRACKED_ACTIONS) {
    it(`${action} has the same keys from all three surfaces`, async () => {
      const shapes = {};
      for (const surface of Object.keys(SURFACES)) {
        captured = [];
        await SURFACES[surface][action]();
        const [event] = eventsOfType(action);
        shapes[surface] = Object.keys(event).sort();
      }

      expect(shapes.realtime).toEqual(shapes.http);
      expect(shapes.discord).toEqual(shapes.http);
      expect(shapes.http).toEqual(['actor', 'guildId', 'metadata', 'track', 'type']);
    });
  }
});

describe('clear_queue records which variant occurred', () => {
  // The three surfaces do not clear the same thing and never have. Without the
  // variant, one event type silently equates three different user-visible
  // outcomes, and any count derived from it is meaningless.
  it.each([
    ['http', 'all'],
    ['realtime', 'upcoming'],
    ['discord', 'all_but_current']
  ])('%s records variant %s', async (surface, variant) => {
    await SURFACES[surface].clear_queue();

    const [event] = eventsOfType('clear_queue');
    expect(event.metadata).not.toBeNull();
    expect(event.metadata.variant).toBe(variant);
  });

  it('gives the three surfaces three distinct variants', async () => {
    const variants = [];
    for (const surface of Object.keys(SURFACES)) {
      captured = [];
      await SURFACES[surface].clear_queue();
      variants.push(eventsOfType('clear_queue')[0].metadata.variant);
    }

    expect(new Set(variants).size).toBe(3);
  });
});

describe('stop is recorded on no surface', () => {
  // Stopping DOES empty the queue, so emitting clear_queue from a stop handler
  // looks like closing a gap. Instrumenting one surface's stop and not the others
  // is the parity violation this matrix exists to prevent.
  it('emits nothing from the HTTP stop action', async () => {
    await fetch(`${baseUrl}/api/player/stop`, { method: 'POST' });

    expect(captured).toHaveLength(0);
  });

  it('emits nothing from the realtime stop action', async () => {
    await handlePlayerControl(socket())({ action: 'stop' });

    expect(captured).toHaveLength(0);
  });

  it('emits nothing from the Discord stop command', async () => {
    await discordStop(interaction());

    expect(captured).toHaveLength(0);
  });
});

describe('emit coverage is complete', () => {
  it('covers exactly the six tracked actions across three surfaces', () => {
    // Guards the matrix itself: an action added to the contract without a
    // corresponding trigger here would otherwise go untested on every surface.
    expect(TRACKED_ACTIONS).toHaveLength(6);
    for (const surface of Object.keys(SURFACES)) {
      expect(Object.keys(SURFACES[surface]).sort()).toEqual([...TRACKED_ACTIONS].sort());
    }
    expect(Object.keys(SURFACES)).toHaveLength(3);
  });
});
