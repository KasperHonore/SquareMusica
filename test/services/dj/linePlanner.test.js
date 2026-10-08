import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../../src/utils/logger.js', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() }
}));

import { createLinePlanner } from '../../../src/services/dj/linePlanner.js';
import { Queue } from '../../../src/core/queue.js';
import { logger } from '../../../src/utils/logger.js';

function track(n, duration = 180) {
  return {
    title: `Track ${n}`,
    url: `https://youtu.be/t${n}`,
    channel: `Artist ${n}`,
    duration,
    addedAt: new Date(2026, 9, 8, 12, 0, n)
  };
}

/**
 * A small in-memory world: a real Queue, a fake player, and mediator-like
 * start()/stop() helpers that call the planner the way musicManager would.
 */
function harness({ interval = 1, enabled = true, lineDelayMs = 100, tracks = 7 } = {}) {
  const queue = new Queue();
  for (let i = 1; i <= tracks; i++) queue.add(track(i));
  queue.currentIndex = 0;

  const player = {
    paused: false,
    overlays: [],
    overlay: vi.fn((pcm) => {
      if (player.paused) return false;
      player.overlays.push(pcm);
      return true;
    }),
    isPaused: () => player.paused
  };

  const world = {
    settings: { enabled, interval, lookahead: 5 },
    users: [{ id: 'u1', username: 'kasper' }],
    optOuts: new Set(),
    breakerOpen: false,
    capReached: false,
    canAttempt: true,
    lineDelayMs,
    produceFails: false,
    namedUserIds: [],
    texts: null,
    produced: []
  };

  let counter = 0;
  const produceLine = vi.fn(async (ctx) => {
    const forKey = ctx.forKey;
    world.produced.push(forKey);
    await new Promise((resolve) => setTimeout(resolve, world.lineDelayMs));
    if (world.produceFails) throw Object.assign(new Error('down'), { kind: 'llm' });
    counter++;
    const text = world.texts ? world.texts(ctx) : `Line ${counter} for ${ctx.next.title}.`;
    return {
      forKey,
      text,
      pcm: Buffer.from(`pcm:${forKey}:${counter}`),
      factIds: ['f-next'],
      namedUserIds: [...world.namedUserIds],
      preparedAt: Date.now()
    };
  });

  const planner = createLinePlanner({
    getSettings: () => world.settings,
    getVoiceContext: () => (world.users ? { connectedUsers: world.users } : null),
    getQueue: () => queue,
    getPlayer: () => player,
    produceLine,
    canAttempt: () => world.canAttempt && !world.breakerOpen,
    isBreakerOpen: () => world.breakerOpen,
    isCapReached: () => world.capReached,
    getOptOuts: () => world.optOuts
  });

  return {
    queue,
    player,
    world,
    planner,
    produceLine,
    /** Start the current queue entry (cold start or after idle). */
    startCurrent() {
      planner.onTrackChange(queue.getCurrent());
    },
    /** Advance like a natural end or a skip, and announce the new track. */
    advance() {
      const next = queue.next();
      planner.onTrackChange(next);
      return next;
    },
    stop() {
      planner.onTrackChange(null);
    },
    spoken: () => player.overlays.length
  };
}

/** Let the current track play to its end (track duration in seconds). */
async function playThrough(seconds = 180) {
  await vi.advanceTimersByTimeAsync(seconds * 1000);
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(2026, 9, 8, 12, 0, 0));
  vi.clearAllMocks();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('interval and transitions (FR-006)', () => {
  it('interval 3 over 6 transitions speaks exactly 2 times', async () => {
    const h = harness({ interval: 3 });
    h.startCurrent();
    for (let i = 0; i < 6; i++) {
      await playThrough();
      h.advance();
      await vi.advanceTimersByTimeAsync(0);
    }
    expect(h.spoken()).toBe(2);
  });

  it('seven tracks back to back from an idle queue are six transitions', async () => {
    const h = harness({ interval: 1 });
    h.startCurrent(); // cold start: not a transition
    await vi.advanceTimersByTimeAsync(0);
    expect(h.spoken()).toBe(0);
    for (let i = 0; i < 6; i++) {
      await playThrough();
      h.advance();
      await vi.advanceTimersByTimeAsync(0);
    }
    expect(h.spoken()).toBe(6);
  });

  it('the first start after track:change(null) is not a transition', async () => {
    const h = harness({ interval: 1 });
    h.startCurrent();
    await playThrough();
    h.stop();
    h.queue.currentIndex = 1;
    h.startCurrent();
    await vi.advanceTimersByTimeAsync(2000);
    expect(h.spoken()).toBe(0);
    expect(h.planner.getTransitionsSinceSpoken()).toBe(0);
  });

  it('a dropped line does not reset transitionsSinceSpoken', async () => {
    const h = harness({ interval: 2 });
    h.world.produceFails = true;
    h.startCurrent();
    await playThrough();
    h.advance(); // transition 1, not due
    await playThrough();
    h.advance(); // transition 2, due, but no line
    await vi.advanceTimersByTimeAsync(0);
    expect(h.spoken()).toBe(0);
    expect(h.planner.getTransitionsSinceSpoken()).toBe(2);

    h.world.produceFails = false;
    await playThrough();
    h.advance(); // transition 3: still due, speaks
    await vi.advanceTimersByTimeAsync(0);
    expect(h.spoken()).toBe(1);
    expect(h.planner.getTransitionsSinceSpoken()).toBe(0);
  });

  it('resetCounter() makes the next line come at the 4th transition with interval 4', async () => {
    const h = harness({ interval: 4, tracks: 10 });
    h.startCurrent();
    for (let i = 0; i < 3; i++) {
      await playThrough();
      h.advance();
    }
    expect(h.planner.getTransitionsSinceSpoken()).toBe(3);
    h.planner.resetCounter();
    const spokeAt = [];
    for (let i = 1; i <= 4; i++) {
      await playThrough();
      h.advance();
      await vi.advanceTimersByTimeAsync(0);
      if (h.spoken() > 0 && spokeAt.length === 0) spokeAt.push(i);
    }
    expect(spokeAt).toEqual([4]);
  });

  it('a skip counts as a transition', async () => {
    const h = harness({ interval: 2 });
    h.startCurrent();
    await vi.advanceTimersByTimeAsync(5000);
    h.advance(); // skip after 5 s
    expect(h.planner.getTransitionsSinceSpoken()).toBe(1);
  });

  it('never speaks when the DJ is disabled (US1/AC3)', async () => {
    const h = harness({ interval: 1, enabled: false });
    h.startCurrent();
    for (let i = 0; i < 6; i++) {
      await playThrough();
      h.advance();
      await vi.advanceTimersByTimeAsync(0);
    }
    expect(h.spoken()).toBe(0);
    expect(h.produceLine).not.toHaveBeenCalled();
  });
});

describe('preparation timing (R5)', () => {
  it('prepares at duration − 30 s', async () => {
    const h = harness();
    h.startCurrent();
    await vi.advanceTimersByTimeAsync(150 * 1000 - 1);
    expect(h.produceLine).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(h.produceLine).toHaveBeenCalledTimes(1);
    expect(h.world.produced).toEqual(['https://youtu.be/t2']);
  });

  it('prepares immediately when the duration is under 30 s', async () => {
    const h = harness();
    h.queue.tracks[0].duration = 20;
    h.startCurrent();
    await vi.advanceTimersByTimeAsync(0);
    expect(h.produceLine).toHaveBeenCalledTimes(1);
  });

  it('prepares immediately when the duration is unknown', async () => {
    const h = harness();
    delete h.queue.tracks[0].duration;
    h.startCurrent();
    await vi.advanceTimersByTimeAsync(0);
    expect(h.produceLine).toHaveBeenCalledTimes(1);
  });

  it('runs at most one preparation at a time', async () => {
    const h = harness({ lineDelayMs: 60 * 1000 });
    h.queue.tracks[0].duration = 10;
    h.startCurrent();
    await vi.advanceTimersByTimeAsync(0);
    h.planner.onQueueUpdate();
    h.planner.onQueueUpdate();
    expect(h.produceLine).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['track', 0, 'https://youtu.be/t1'],
    ['queue', 6, 'https://youtu.be/t1']
  ])(
    'with loop %s the prepared line matches the track that actually starts',
    async (mode, index, expectedKey) => {
      const h = harness();
      h.queue.loopMode = mode;
      h.queue.currentIndex = index;
      h.startCurrent();
      await playThrough();
      expect(h.world.produced).toEqual([expectedKey]);
      const started = h.advance();
      expect(started.url).toBe(expectedKey);
      await vi.advanceTimersByTimeAsync(0);
      expect(h.spoken()).toBe(1);
    }
  );
});

describe('speaking and dropping', () => {
  it('overlays the prepared PCM over the start of the next track (US1/AC1)', async () => {
    const h = harness();
    h.startCurrent();
    await playThrough();
    h.advance();
    expect(h.player.overlay).toHaveBeenCalledTimes(1);
    expect(h.player.overlays[0].toString()).toBe('pcm:https://youtu.be/t2:1');
  });

  it('discards a prepared line whose forKey does not match the started track (rapid skip)', async () => {
    const h = harness();
    h.startCurrent();
    await playThrough(); // line for t2 is ready
    h.queue.next(); // t2 skipped before it was announced
    h.planner.onTrackChange(h.queue.next()); // t3 starts
    await vi.advanceTimersByTimeAsync(3000);
    expect(h.spoken()).toBe(0);
  });

  it('drops a line still in flight 2 s after track start and never delays the track (US1/AC4)', async () => {
    const h = harness({ lineDelayMs: 5000 });
    h.queue.tracks[0].duration = 31; // preparation starts at 1 s, done at 6 s
    h.startCurrent();
    await vi.advanceTimersByTimeAsync(2000);
    // advance() is synchronous: the track starts with nothing awaited.
    const started = h.advance();
    expect(started.url).toBe('https://youtu.be/t2');
    await vi.advanceTimersByTimeAsync(2000);
    expect(h.spoken()).toBe(0);
    await vi.advanceTimersByTimeAsync(10000);
    expect(h.spoken()).toBe(0);
    expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('dropped (late)'));
  });

  it('speaks a line that finishes within 2 s of track start', async () => {
    const h = harness({ lineDelayMs: 2500 });
    h.queue.tracks[0].duration = 31; // preparation starts at 1 s, done at 3.5 s
    h.startCurrent();
    await vi.advanceTimersByTimeAsync(2000);
    h.advance();
    expect(h.spoken()).toBe(0);
    await vi.advanceTimersByTimeAsync(1500);
    expect(h.spoken()).toBe(1);
  });

  it('a queue:update that changes the predicted next track discards and re-prepares', async () => {
    const h = harness();
    h.startCurrent();
    await playThrough(); // prepared for t2
    expect(h.world.produced).toEqual(['https://youtu.be/t2']);
    h.queue.reorder(3, 1); // t4 is now next
    h.planner.onQueueUpdate();
    await vi.advanceTimersByTimeAsync(1000);
    expect(h.world.produced).toEqual(['https://youtu.be/t2', 'https://youtu.be/t4']);
    const started = h.advance();
    expect(started.url).toBe('https://youtu.be/t4');
    expect(h.spoken()).toBe(1);
    expect(h.player.overlays[0].toString()).toContain('t4');
  });

  it('loop replays count as transitions but the same text is not spoken twice in a row', async () => {
    const h = harness({ interval: 1 });
    h.queue.loopMode = 'track';
    h.world.texts = (ctx) => `Once more, ${ctx.next.title}.`;
    h.startCurrent();
    await playThrough();
    h.advance();
    expect(h.planner.getTransitionsSinceSpoken()).toBe(0);
    expect(h.spoken()).toBe(1);
    await playThrough();
    h.advance();
    expect(h.spoken()).toBe(1);
    expect(h.planner.getTransitionsSinceSpoken()).toBe(1);
  });
});

describe('silence conditions (R5 step 5)', () => {
  async function noPreparation(setup) {
    const h = harness();
    setup(h);
    h.startCurrent();
    await playThrough();
    expect(h.produceLine).not.toHaveBeenCalled();
    return h;
  }

  it('no preparation when disabled', () =>
    noPreparation((h) => (h.world.settings.enabled = false)));
  it('no preparation when paused', () => noPreparation((h) => (h.player.paused = true)));
  it('no preparation when the queue has no next track', () =>
    noPreparation((h) => (h.queue.tracks = [h.queue.tracks[0]])));
  it('no preparation when the breaker is open', () =>
    noPreparation((h) => (h.world.breakerOpen = true)));
  it('no preparation when the line cap is reached', () =>
    noPreparation((h) => (h.world.capReached = true)));
  it('no preparation when connectedUsers has no human (FR-010)', () =>
    noPreparation((h) => (h.world.users = [])));
  it('no preparation when there is no voice context', () =>
    noPreparation((h) => (h.world.users = null)));

  it('prepares once playback resumes after a pause', async () => {
    const h = harness();
    h.player.paused = true;
    h.startCurrent();
    await playThrough();
    expect(h.produceLine).not.toHaveBeenCalled();
    h.player.paused = false;
    await vi.advanceTimersByTimeAsync(5000);
    expect(h.produceLine).toHaveBeenCalledTimes(1);
  });

  it('does not speak when everyone left after preparation', async () => {
    const h = harness();
    h.startCurrent();
    await playThrough();
    h.world.users = [];
    h.advance();
    expect(h.spoken()).toBe(0);
  });
});

describe('speak-time member re-check (R7, FR-017, FR-020)', () => {
  it('drops a line naming A when A is missing at speak time, with no voice:context event', async () => {
    const h = harness();
    h.world.users = [
      { id: 'A', username: 'a' },
      { id: 'B', username: 'b' }
    ];
    h.world.namedUserIds = ['A'];
    h.startCurrent();
    await playThrough();
    h.world.users = [{ id: 'B', username: 'b' }];
    h.advance();
    expect(h.spoken()).toBe(0);
    expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('dropped (stale-member)'));
    expect(h.planner.getTransitionsSinceSpoken()).toBe(1);
  });

  it('drops a line naming A when A opted out since preparation', async () => {
    const h = harness();
    h.world.users = [{ id: 'A', username: 'a' }];
    h.world.namedUserIds = ['A'];
    h.startCurrent();
    await playThrough();
    h.world.optOuts.add('A');
    h.advance();
    expect(h.spoken()).toBe(0);
    expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('dropped (stale-member)'));
    expect(h.planner.getTransitionsSinceSpoken()).toBe(1);
  });

  it('speaks a line naming A while A is present and opted in', async () => {
    const h = harness();
    h.world.users = [{ id: 'A', username: 'a' }];
    h.world.namedUserIds = ['A'];
    h.startCurrent();
    await playThrough();
    h.advance();
    expect(h.spoken()).toBe(1);
  });
});

describe('SC-002 bookkeeping (T031)', () => {
  it('counts due and spoken lines and logs them at day rollover', async () => {
    const h = harness({ lineDelayMs: 100 });
    h.startCurrent();
    await playThrough();
    h.advance(); // due + spoken
    h.world.produceFails = true;
    await playThrough();
    h.advance(); // due, dropped
    expect(h.planner.getStats()).toMatchObject({ due: 2, spoken: 1 });

    vi.setSystemTime(new Date(2026, 9, 9, 0, 0, 1));
    h.advance();
    expect(logger.info).toHaveBeenCalledWith(
      expect.stringMatching(/2026-10-08: due=2 spoken=1 ratio=0\.500/)
    );
  });

  it('logs the counters on shutdown and never logs the PCM', async () => {
    const h = harness();
    h.startCurrent();
    await playThrough();
    h.advance();
    h.planner.shutdown();
    expect(logger.info).toHaveBeenCalledWith(expect.stringMatching(/due=1 spoken=1 ratio=1\.000/));
    const logged = logger.info.mock.calls.flat().join(' ');
    expect(logged).not.toContain('pcm:');
  });

  it('does not count a transition as due while a silence condition holds', async () => {
    const h = harness();
    h.startCurrent();
    h.world.users = [];
    await playThrough();
    h.advance();
    expect(h.planner.getStats()).toMatchObject({ due: 0, spoken: 0 });
  });
});
