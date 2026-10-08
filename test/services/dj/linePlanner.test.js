import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../../src/integrations/llm.js', () => ({ chatJson: vi.fn() }));
vi.mock('../../../src/integrations/elevenlabs.js', () => ({ synthesize: vi.fn() }));

import { createLinePlanner } from '../../../src/services/dj/linePlanner.js';
import { trackKey } from '../../../src/services/dj/context.js';
import { Queue } from '../../../src/core/queue.js';

const PCM = Buffer.alloc(8);
const BUFFER_MS = 40; // time from play() to the resource being readable
const quietLogger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };

function makeTracks(n, duration = 10) {
  return Array.from({ length: n }, (_, i) => ({
    title: `Track ${i}`,
    url: `https://yt/${i}`,
    duration,
    channel: `Artist ${i}`
  }));
}

let h;

function setup({ tracks = makeTracks(7), interval = 1, enabled = true, ...overrides } = {}) {
  const queue = new Queue();
  for (const t of tracks) queue.add(t);
  // Like MusicPlayer: track:change fires while the new resource is still
  // buffering, and overlay() refuses until it is playing. `mix` records the
  // overlays the player actually accepted.
  const player = {
    paused: false,
    status: 'idle',
    isPaused: vi.fn(() => player.paused),
    mix: vi.fn(),
    overlay: vi.fn((pcm) => {
      if (player.paused || player.status !== 'playing') return false;
      player.mix(pcm);
      return true;
    })
  };
  const state = {
    settings: { enabled, interval, lookahead: 5 },
    users: [{ id: 'A' }, { id: 'B' }],
    optOuts: new Set(),
    breakerOpen: false,
    capReached: false
  };
  let n = 0;
  const writeLine = vi.fn(async (ctx) => ({
    forKey: ctx.forKey,
    text: `Line ${++n} into ${ctx.next.title}.`,
    pcm: PCM,
    factIds: ['f1'],
    namedUserIds: [],
    preparedAt: Date.now()
  }));
  const deps = {
    getSettings: () => state.settings,
    getVoiceContext: () => ({ connectedUsers: state.users }),
    getQueue: () => queue,
    getPlayer: () => player,
    getOptOuts: () => state.optOuts,
    isBreakerOpen: () => state.breakerOpen,
    isCapReached: () => state.capReached,
    onLineReady: vi.fn(),
    onLineFailed: vi.fn(),
    writeLine,
    logger: quietLogger,
    ...overrides
  };
  const planner = createLinePlanner(deps);
  return { queue, player, state, writeLine, deps, planner };
}

/** Start the queue entry at `index`, as the mediator would. */
function start(index) {
  h.queue.currentIndex = index;
  h.player.status = 'buffering';
  clearTimeout(h.bufferTimer);
  h.bufferTimer = setTimeout(() => (h.player.status = 'playing'), BUFFER_MS);
  h.planner.onTrackChange(h.queue.tracks[index]);
}

/** Let scheduled preparations and their promises run. */
async function settle(ms = BUFFER_MS * 2) {
  await vi.advanceTimersByTimeAsync(ms);
}

/** Play `count` tracks back to back from index 0, settling between starts. */
async function playThrough(count) {
  for (let i = 0; i < count; i++) {
    start(i);
    await settle();
  }
}

beforeEach(() => {
  vi.useFakeTimers();
  quietLogger.info.mockClear();
});

afterEach(() => {
  h?.planner.shutdown();
  vi.useRealTimers();
});

describe('linePlanner: transitions and the interval (FR-006)', () => {
  it('interval 3 over 6 transitions speaks exactly 2 times (US1/AC2)', async () => {
    h = setup({ interval: 3 });
    await playThrough(7);
    expect(h.player.mix).toHaveBeenCalledTimes(2);
  });

  it('interval 1 speaks at every transition, each line for the started track (US1/AC1)', async () => {
    h = setup({ interval: 1, tracks: makeTracks(3) });
    await playThrough(3);
    expect(h.player.mix).toHaveBeenCalledTimes(2);
    expect(h.planner.spoken).toEqual(['Line 1 into Track 1.', 'Line 2 into Track 2.']);
  });

  it('never speaks when disabled (US1/AC3)', async () => {
    h = setup({ enabled: false });
    await playThrough(7);
    expect(h.writeLine).not.toHaveBeenCalled();
    expect(h.player.mix).not.toHaveBeenCalled();
  });

  it('seven tracks from an idle queue are six transitions; first start is not one', async () => {
    h = setup({ interval: 1 });
    start(0);
    await settle();
    expect(h.planner.transitionsSinceSpoken).toBe(0);
    // Cut the line so nothing resets the counter, then count raw transitions.
    h.player.overlay.mockReturnValue(false);
    for (let i = 1; i < 7; i++) {
      start(i);
      await settle();
    }
    expect(h.planner.transitionsSinceSpoken).toBe(6);
  });

  it('the first start after track:change(null) is not a transition', async () => {
    h = setup({ interval: 1 });
    h.player.overlay.mockReturnValue(false);
    start(0);
    start(1);
    expect(h.planner.transitionsSinceSpoken).toBe(1);
    h.planner.onTrackChange(null);
    start(2);
    expect(h.planner.transitionsSinceSpoken).toBe(1);
    start(3);
    expect(h.planner.transitionsSinceSpoken).toBe(2);
  });

  it('a dropped line does not reset transitionsSinceSpoken', async () => {
    h = setup({ interval: 2 });
    h.writeLine.mockRejectedValue(Object.assign(new Error('down'), { kind: 'llm' }));
    await playThrough(4);
    expect(h.player.mix).not.toHaveBeenCalled();
    expect(h.planner.transitionsSinceSpoken).toBe(3);
  });

  it('resetCounter(): with interval 4 the next line is at the 4th transition after the call', async () => {
    h = setup({ interval: 4, tracks: makeTracks(10) });
    await playThrough(3); // 2 transitions so far
    expect(h.planner.transitionsSinceSpoken).toBe(2);
    h.planner.resetCounter();
    for (let i = 3; i <= 5; i++) {
      start(i);
      await settle();
    }
    expect(h.player.mix).not.toHaveBeenCalled();
    start(6);
    await settle();
    expect(h.player.mix).toHaveBeenCalledTimes(1);
  });

  it('a skip counts as a transition', async () => {
    h = setup({ interval: 1, tracks: makeTracks(3, 600) });
    start(0);
    // Skipped well before the preparation point: no line, but still a transition.
    await settle(1000);
    h.player.overlay.mockReturnValue(false);
    start(1);
    expect(h.planner.transitionsSinceSpoken).toBe(1);
  });
});

describe('linePlanner: preparation timing', () => {
  it('prepares at duration − 30 s', async () => {
    h = setup({ interval: 1, tracks: makeTracks(3, 200) });
    start(0);
    await settle(169_000);
    expect(h.writeLine).not.toHaveBeenCalled();
    await settle(1000);
    expect(h.writeLine).toHaveBeenCalledTimes(1);
  });

  it('prepares immediately when duration is unknown or under 30 s', async () => {
    h = setup({ interval: 1, tracks: [{ title: 'x', url: 'u0' }, ...makeTracks(2, 20)] });
    start(0);
    await settle();
    expect(h.writeLine).toHaveBeenCalledTimes(1);
    start(1);
    await settle();
    expect(h.writeLine).toHaveBeenCalledTimes(2);
  });

  it('uses queue.peekNext(): loop track prepares for the same entry', async () => {
    h = setup({ interval: 1, tracks: makeTracks(3) });
    h.queue.loopMode = 'track';
    start(0);
    await settle();
    expect(h.writeLine.mock.calls[0][0].forKey).toBe(trackKey(h.queue.tracks[0]));
    start(0);
    await settle();
    expect(h.player.mix).toHaveBeenCalledTimes(1);
  });

  it('uses queue.peekNext(): loop queue at the last index prepares for tracks[0]', async () => {
    h = setup({ interval: 1, tracks: makeTracks(3) });
    h.queue.loopMode = 'queue';
    start(2);
    await settle();
    expect(h.writeLine.mock.calls[0][0].forKey).toBe(trackKey(h.queue.tracks[0]));
    start(0);
    await settle();
    expect(h.player.mix).toHaveBeenCalledTimes(1);
  });

  it('a queue:update that changes the predicted next track discards and re-prepares', async () => {
    h = setup({ interval: 1, tracks: makeTracks(3) });
    start(0);
    await settle();
    expect(h.planner.prepared.forKey).toBe('https://yt/1');
    h.queue.tracks.splice(1, 0, { title: 'Jumped', url: 'https://yt/jump', duration: 10 });
    h.planner.onQueueUpdate();
    await settle();
    expect(h.writeLine).toHaveBeenCalledTimes(2);
    expect(h.planner.prepared.forKey).toBe('https://yt/jump');
    start(1);
    await settle();
    expect(h.player.mix).toHaveBeenCalledTimes(1);
    expect(h.planner.spoken[0]).toMatch(/Jumped/);
  });

  it('a prepared line whose forKey differs from the started track is discarded (rapid skip)', async () => {
    h = setup({ interval: 1, tracks: makeTracks(4) });
    start(0);
    await settle();
    expect(h.planner.prepared.forKey).toBe('https://yt/1');
    // Skip twice quickly: track 2 starts without a queue:update in between.
    h.queue.currentIndex = 2;
    h.planner.onTrackChange(h.queue.tracks[2]);
    expect(h.player.mix).not.toHaveBeenCalled();
  });

  it('only one preparation is in flight at a time', async () => {
    h = setup({ interval: 1, tracks: makeTracks(4) });
    let release;
    h.writeLine.mockImplementationOnce(
      (ctx) =>
        new Promise((r) => {
          release = () =>
            r({ forKey: ctx.forKey, text: 'a.', pcm: PCM, factIds: [], namedUserIds: [] });
        })
    );
    start(0);
    await settle();
    h.planner.onQueueUpdate();
    h.planner.onQueueUpdate();
    await settle();
    expect(h.writeLine).toHaveBeenCalledTimes(1);
    release();
    await settle();
  });
});

describe('linePlanner: never delays playback (FR-008, US1/AC4)', () => {
  it('waits up to 2 s for an in-flight line, then drops it', async () => {
    h = setup({ interval: 1, tracks: makeTracks(3) });
    h.writeLine.mockImplementation(
      (ctx) =>
        new Promise((r) =>
          setTimeout(
            () => r({ forKey: ctx.forKey, text: 'slow.', pcm: PCM, factIds: [], namedUserIds: [] }),
            5000
          )
        )
    );
    start(0);
    await settle(0);
    const result = h.planner.onTrackChange(((h.queue.currentIndex = 1), h.queue.tracks[1]));
    expect(result).toBeUndefined(); // synchronous, nothing to await
    await settle(2000);
    await settle(5000);
    expect(h.player.mix).not.toHaveBeenCalled();
    expect(h.planner.transitionsSinceSpoken).toBe(1);
  });

  it('speaks an in-flight line that lands within 2 s of track start', async () => {
    h = setup({ interval: 1, tracks: makeTracks(3) });
    h.writeLine.mockImplementationOnce(
      (ctx) =>
        new Promise((r) =>
          setTimeout(
            () => r({ forKey: ctx.forKey, text: 'ok.', pcm: PCM, factIds: [], namedUserIds: [] }),
            1500
          )
        )
    );
    start(0);
    await settle(0);
    await settle(1000);
    start(1);
    await settle(1000);
    expect(h.player.mix).toHaveBeenCalledTimes(1);
  });

  it('an LLM/TTS failure drops the line and reports it to the breaker', async () => {
    h = setup({ interval: 1, tracks: makeTracks(3) });
    const err = Object.assign(new Error('down'), { kind: 'llm' });
    h.writeLine.mockRejectedValue(err);
    await playThrough(3);
    expect(h.deps.onLineFailed).toHaveBeenCalledWith(err);
    expect(h.player.mix).not.toHaveBeenCalled();
  });

  it('reports a successful TTS to onLineReady (usage counting)', async () => {
    h = setup({ interval: 1, tracks: makeTracks(2) });
    start(0);
    await settle();
    expect(h.deps.onLineReady).toHaveBeenCalledTimes(1);
  });
});

describe('linePlanner: silence conditions (R5 step 5, FR-010)', () => {
  const cases = [
    ['disabled', (s) => (s.state.settings = { ...s.state.settings, enabled: false })],
    ['paused', (s) => (s.player.paused = true)],
    ['no next track', (s) => (s.queue.tracks = s.queue.tracks.slice(0, 1))],
    ['breaker open', (s) => (s.state.breakerOpen = true)],
    ['line cap reached', (s) => (s.state.capReached = true)],
    ['no human listeners', (s) => (s.state.users = [])]
  ];
  for (const [name, apply] of cases) {
    it(`does not prepare when ${name}`, async () => {
      h = setup({ interval: 1, tracks: makeTracks(3) });
      apply(h);
      start(0);
      await settle();
      expect(h.writeLine).not.toHaveBeenCalled();
    });
  }

  it('does not speak when listeners left after preparation', async () => {
    h = setup({ interval: 1, tracks: makeTracks(3) });
    start(0);
    await settle();
    h.state.users = [];
    start(1);
    await settle();
    expect(h.player.mix).not.toHaveBeenCalled();
  });
});

describe('linePlanner: overlay while the new track is still buffering (US1/AC1)', () => {
  it('a line prepared ahead is spoken once the player reaches playing, not dropped', async () => {
    h = setup({ interval: 1, tracks: makeTracks(3) });
    start(0);
    await settle();
    expect(h.planner.prepared.forKey).toBe('https://yt/1');
    start(1);
    // track:change fired during buffering: the player refused the overlay.
    expect(h.player.overlay).toHaveBeenCalled();
    expect(h.player.mix).not.toHaveBeenCalled();
    await settle();
    expect(h.player.mix).toHaveBeenCalledTimes(1);
    expect(h.planner.spoken).toEqual(['Line 1 into Track 1.']);
    expect(h.planner.transitionsSinceSpoken).toBe(0);
  });

  it('drops the line as not-playing if the track never becomes playable within 2 s', async () => {
    h = setup({ interval: 1, tracks: makeTracks(3) });
    start(0);
    await settle();
    start(1);
    clearTimeout(h.bufferTimer);
    await settle(2500);
    expect(h.player.mix).not.toHaveBeenCalled();
    expect(h.planner.transitionsSinceSpoken).toBe(1);
    expect(quietLogger.info).toHaveBeenCalledWith(expect.stringContaining('not-playing'));
  });

  it('a skip during buffering cancels the pending overlay for the skipped track', async () => {
    h = setup({ interval: 1, tracks: makeTracks(3) });
    start(0);
    await settle();
    start(1);
    h.planner.onTrackChange(null);
    await settle();
    expect(h.player.mix).not.toHaveBeenCalled();
  });
});

describe('linePlanner: loops and repeats', () => {
  it('loop replays count as transitions but the same text is not spoken twice in a row', async () => {
    h = setup({ interval: 1, tracks: makeTracks(2) });
    h.writeLine.mockImplementation(async (ctx) => ({
      forKey: ctx.forKey,
      text: 'Same line.',
      pcm: PCM,
      factIds: [],
      namedUserIds: []
    }));
    h.queue.loopMode = 'track';
    start(0);
    await settle();
    start(0);
    await settle();
    expect(h.player.mix).toHaveBeenCalledTimes(1);
    start(0);
    await settle();
    expect(h.player.mix).toHaveBeenCalledTimes(1);
    expect(h.planner.transitionsSinceSpoken).toBe(1);
  });
});

describe('linePlanner: speak-time member re-check (R7, FR-017, FR-020)', () => {
  function namingA(h) {
    h.writeLine.mockImplementation(async (ctx) => ({
      forKey: ctx.forKey,
      text: 'For you, A.',
      pcm: PCM,
      factIds: [],
      namedUserIds: ['A']
    }));
  }

  it('drops a line naming a member who left, with no voice:context event', async () => {
    h = setup({ interval: 1, tracks: makeTracks(3) });
    namingA(h);
    start(0);
    await settle();
    h.state.users = [{ id: 'B' }];
    start(1);
    await settle();
    expect(h.player.mix).not.toHaveBeenCalled();
    expect(h.planner.transitionsSinceSpoken).toBe(1);
    expect(quietLogger.info).toHaveBeenCalledWith(expect.stringContaining('stale-member'));
  });

  it('drops a line naming a member who opted out since preparation', async () => {
    h = setup({ interval: 1, tracks: makeTracks(3) });
    namingA(h);
    start(0);
    await settle();
    h.state.optOuts = new Set(['A']);
    start(1);
    await settle();
    expect(h.player.mix).not.toHaveBeenCalled();
    expect(h.planner.transitionsSinceSpoken).toBe(1);
  });
});

describe('linePlanner: logging (T031, SC-002)', () => {
  it('logs prepared/spoken lines without the PCM buffer and counts due vs spoken', async () => {
    h = setup({ interval: 1, tracks: makeTracks(3) });
    await playThrough(3);
    const messages = quietLogger.info.mock.calls.map((c) => c.join(' '));
    expect(messages.some((m) => m.includes('Line prepared') && m.includes('chars='))).toBe(true);
    expect(messages.some((m) => m.includes('Line spoken'))).toBe(true);
    expect(quietLogger.info.mock.calls.flat().some((a) => Buffer.isBuffer(a))).toBe(false);
    expect(h.planner.stats).toMatchObject({ due: 2, spoken: 2 });
    h.planner.shutdown();
    expect(quietLogger.info).toHaveBeenLastCalledWith(
      expect.stringMatching(/due=2 spoken=2 ratio=1\.00/)
    );
  });
});
