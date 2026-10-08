import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../../src/utils/logger.js', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() }
}));

import { createLinePlanner } from '../../../src/services/dj/linePlanner.js';
import { buildContext, trackKey } from '../../../src/services/dj/context.js';
import { logger } from '../../../src/utils/logger.js';

const PCM = Buffer.alloc(16);

function track(id, duration = 200) {
  return { title: `Song ${id}`, url: `https://yt/${id}`, duration };
}

// A queue that follows the real Queue's peekNext() semantics.
function fakeQueue(tracks) {
  return {
    tracks,
    currentIndex: 0,
    loopMode: 'off',
    peekNext() {
      if (this.tracks.length === 0) return null;
      if (this.loopMode === 'track') return this.tracks[this.currentIndex] ?? null;
      if (this.currentIndex < this.tracks.length - 1) return this.tracks[this.currentIndex + 1];
      if (this.loopMode === 'queue') return this.tracks[0];
      return null;
    }
  };
}

function setup({ tracks = [], interval = 1, enabled = true, writeLine, theme = null } = {}) {
  const state = {
    theme,
    introPending: false,
    settings: { enabled, interval },
    queue: fakeQueue(tracks),
    player: { overlay: vi.fn(() => true), isPaused: vi.fn(() => false) },
    voice: { connectedUsers: [{ id: 'A', username: 'a' }] },
    optOuts: new Set(),
    capReached: false,
    breakerOpen: false
  };
  let counter = 0;
  const write =
    writeLine ??
    vi.fn(async (ctx) => ({
      forKey: ctx.next?.key ?? null,
      text: ctx.intro
        ? `Intro ${++counter} for ${ctx.theme}.`
        : `Line ${++counter} for ${ctx.next.title}.`,
      pcm: PCM,
      factIds: ['f1'],
      namedUserIds: [],
      preparedAt: Date.now()
    }));
  const planner = createLinePlanner({
    getSettings: () => state.settings,
    getQueue: () => state.queue,
    getPlayer: () => state.player,
    getVoiceContext: () => state.voice,
    getOptOuts: () => state.optOuts,
    isCapReached: () => state.capReached,
    isBreakerOpen: () => state.breakerOpen,
    canAttempt: () => !state.breakerOpen,
    buildContext,
    writeLine: write,
    getTheme: () => state.theme,
    isIntroPending: () => state.introPending,
    clearIntroPending: () => {
      state.introPending = false;
    }
  });

  // Start the track at index i, as the player + mediator would.
  async function start(i) {
    state.queue.currentIndex = i;
    planner.onTrackChange(state.queue.tracks[i]);
    await vi.advanceTimersByTimeAsync(0);
  }
  // Play through track i to its end (natural finish), letting preparation run.
  async function playOut(i) {
    await vi.advanceTimersByTimeAsync((state.queue.tracks[i].duration ?? 0) * 1000);
  }
  return { state, planner, write, start, playOut };
}

function droppedReasons() {
  return logger.info.mock.calls
    .map(([msg]) => /Line dropped \((.+)\)/.exec(msg)?.[1])
    .filter(Boolean);
}

beforeEach(() => {
  vi.useFakeTimers();
  logger.info.mockClear();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('linePlanner: interval and transitions (FR-006)', () => {
  it('interval 3 over 6 transitions speaks exactly 2 times', async () => {
    const h = setup({ tracks: Array.from({ length: 7 }, (_, i) => track(i)), interval: 3 });
    for (let i = 0; i < 7; i++) {
      await h.start(i);
      await h.playOut(i);
    }
    expect(h.state.player.overlay).toHaveBeenCalledTimes(2);
  });

  it('seven tracks from an idle queue are six transitions; the first start is not one', async () => {
    const h = setup({ tracks: Array.from({ length: 7 }, (_, i) => track(i)), interval: 1 });
    h.planner.onTrackChange(null);
    for (let i = 0; i < 7; i++) {
      await h.start(i);
      await h.playOut(i);
    }
    expect(h.state.player.overlay).toHaveBeenCalledTimes(6);
  });

  it('a start after track:change(null) is not a transition', async () => {
    const h = setup({ tracks: [track(0), track(1)], interval: 1 });
    await h.start(0);
    h.planner.onTrackChange(null);
    await h.start(1);
    expect(h.planner.getDebugState().transitionsSinceSpoken).toBe(0);
    expect(h.state.player.overlay).not.toHaveBeenCalled();
  });

  it('a dropped line does not reset transitionsSinceSpoken', async () => {
    const write = vi.fn(async () => {
      throw Object.assign(new Error('down'), { kind: 'llm' });
    });
    const h = setup({
      tracks: Array.from({ length: 4 }, (_, i) => track(i)),
      interval: 2,
      writeLine: write
    });
    for (let i = 0; i < 4; i++) {
      await h.start(i);
      await h.playOut(i);
    }
    expect(h.state.player.overlay).not.toHaveBeenCalled();
    expect(h.planner.getDebugState().transitionsSinceSpoken).toBe(3);
  });

  it('resetCounter() restarts the count: with interval 4 the next line is at the 4th transition', async () => {
    const h = setup({ tracks: Array.from({ length: 8 }, (_, i) => track(i)), interval: 4 });
    await h.start(0);
    await h.playOut(0);
    await h.start(1);
    await h.start(2); // two transitions so far
    h.planner.resetCounter();
    for (let i = 3; i <= 6; i++) {
      await h.playOut(i - 1);
      await h.start(i);
      expect(h.state.player.overlay).toHaveBeenCalledTimes(i === 6 ? 1 : 0);
    }
  });

  it('a skip counts as a transition', async () => {
    const h = setup({ tracks: [track(0), track(1)], interval: 1 });
    await h.start(0); // 200 s track, preparation scheduled at 170 s
    await vi.advanceTimersByTimeAsync(5000);
    await h.start(1); // skipped at 5 s, before any line was prepared
    expect(h.state.player.overlay).not.toHaveBeenCalled();
    expect(h.planner.getDebugState().transitionsSinceSpoken).toBe(1);
  });
});

describe('linePlanner: preparation', () => {
  it('prepares at duration − 30 s', async () => {
    const h = setup({ tracks: [track(0, 100), track(1)] });
    await h.start(0);
    await vi.advanceTimersByTimeAsync(69_999);
    expect(h.write).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(h.write).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['unknown', undefined],
    ['shorter than 30 s', 20]
  ])('prepares immediately when the duration is %s', async (_label, duration) => {
    const first = { ...track(0), duration };
    const h = setup({ tracks: [first, track(1)] });
    await h.start(0);
    expect(h.write).toHaveBeenCalledTimes(1);
  });

  it('predicts the next track with peekNext(): loop track replays the current entry', async () => {
    const tracks = [track(0, 10), track(1)];
    const h = setup({ tracks });
    h.state.queue.loopMode = 'track';
    await h.start(0);
    expect(h.write.mock.calls[0][0].next.key).toBe(trackKey(tracks[0]));
    await h.start(0);
    expect(h.state.player.overlay).toHaveBeenCalledTimes(1);
  });

  it('predicts the next track with peekNext(): loop queue wraps at the last index', async () => {
    const tracks = [track(0), track(1, 10)];
    const h = setup({ tracks });
    h.state.queue.loopMode = 'queue';
    await h.start(1);
    expect(h.write.mock.calls[0][0].next.key).toBe(trackKey(tracks[0]));
    await h.start(0);
    expect(h.state.player.overlay).toHaveBeenCalledTimes(1);
  });

  it('discards a line prepared for a different track than the one that starts (rapid skip)', async () => {
    const h = setup({ tracks: [track(0, 10), track(1), track(2)] });
    await h.start(0);
    await h.start(2); // track 1 was skipped over
    expect(h.state.player.overlay).not.toHaveBeenCalled();
    expect(droppedReasons()).toContain('stale');
  });

  it('drops a line still in flight 2 s after track start without delaying the track', async () => {
    let resolve;
    const write = vi.fn(
      (ctx) =>
        new Promise((r) => {
          resolve = () =>
            r({ forKey: ctx.next.key, text: 'Late.', pcm: PCM, factIds: [], namedUserIds: [] });
        })
    );
    const h = setup({ tracks: [track(0, 10), track(1)], writeLine: write });
    await h.start(0);
    // onTrackChange returns synchronously: nothing in the playback path awaits the DJ.
    const result = h.planner.onTrackChange(h.state.queue.tracks[1]);
    expect(result).toBeUndefined();
    await vi.advanceTimersByTimeAsync(2000);
    resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(h.state.player.overlay).not.toHaveBeenCalled();
    expect(droppedReasons()).toContain('late');
  });

  it('speaks a line that finishes within the 2 s window', async () => {
    let resolve;
    const write = vi.fn(
      (ctx) =>
        new Promise((r) => {
          resolve = () =>
            r({
              forKey: ctx.next.key,
              text: 'Just in time.',
              pcm: PCM,
              factIds: [],
              namedUserIds: []
            });
        })
    );
    const h = setup({ tracks: [track(0, 10), track(1)], writeLine: write });
    await h.start(0);
    await h.start(1);
    await vi.advanceTimersByTimeAsync(1500);
    resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(h.state.player.overlay).toHaveBeenCalledWith(PCM);
  });

  it('keeps at most one preparation in flight', async () => {
    const write = vi.fn(() => new Promise(() => {}));
    const h = setup({ tracks: [track(0, 10), track(1), track(2)], writeLine: write });
    await h.start(0);
    h.state.queue.tracks.splice(1, 0, track(9));
    h.planner.onQueueUpdate();
    await vi.advanceTimersByTimeAsync(0);
    expect(write).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['disabled', (s) => (s.settings = { enabled: false, interval: 1 })],
    ['paused', (s) => s.player.isPaused.mockReturnValue(true)],
    ['the queue has no next track', (s) => s.queue.tracks.splice(1)],
    ['the breaker is open', (s) => (s.breakerOpen = true)],
    ['the line cap is reached', (s) => (s.capReached = true)],
    ['no human is connected', (s) => (s.voice = { connectedUsers: [] })],
    ['there is no voice context', (s) => (s.voice = null)]
  ])('does not prepare when %s (FR-010)', async (_label, apply) => {
    const h = setup({ tracks: [track(0, 10), track(1)] });
    apply(h.state);
    await h.start(0);
    expect(h.write).not.toHaveBeenCalled();
  });

  it('re-prepares when a queue:update changes the predicted next track', async () => {
    const tracks = [track(0, 10), track(1), track(2)];
    const h = setup({ tracks });
    await h.start(0);
    expect(h.write).toHaveBeenCalledTimes(1);

    h.state.queue.tracks.splice(1, 0, track(5)); // member queues ahead
    h.planner.onQueueUpdate();
    await vi.advanceTimersByTimeAsync(0);
    expect(h.write).toHaveBeenCalledTimes(2);
    expect(h.write.mock.calls[1][0].next.key).toBe('https://yt/5');

    await h.start(1);
    expect(h.state.player.overlay).toHaveBeenCalledTimes(1);
    expect(h.planner.getDebugState().recentSpoken[0]).toMatch(/Song 5/);
  });

  it('does not re-prepare on a queue:update that keeps the predicted next track', async () => {
    const h = setup({ tracks: [track(0, 10), track(1), track(2)] });
    await h.start(0);
    h.state.queue.tracks.push(track(3));
    h.planner.onQueueUpdate();
    await vi.advanceTimersByTimeAsync(0);
    expect(h.write).toHaveBeenCalledTimes(1);
  });
});

describe('linePlanner: speaking', () => {
  it('loop replays count as transitions but the same text is not spoken twice in a row for a track', async () => {
    const write = vi.fn(async (ctx) => ({
      forKey: ctx.next.key,
      text: 'Same words.',
      pcm: PCM,
      factIds: [],
      namedUserIds: []
    }));
    const h = setup({ tracks: [track(0, 10)], writeLine: write });
    h.state.queue.loopMode = 'track';
    await h.start(0);
    await h.start(0);
    await h.start(0);
    expect(h.state.player.overlay).toHaveBeenCalledTimes(1);
    expect(droppedReasons()).toContain('repeat');
    expect(h.planner.getDebugState().transitionsSinceSpoken).toBe(1);
  });

  it('drops a line naming a member who left, with no voice:context event (stale-member)', async () => {
    const write = vi.fn(async (ctx) => ({
      forKey: ctx.next.key,
      text: 'For A!',
      pcm: PCM,
      factIds: [],
      namedUserIds: ['A']
    }));
    const h = setup({ tracks: [track(0, 10), track(1)], writeLine: write });
    h.state.voice = { connectedUsers: [{ id: 'A' }, { id: 'B' }] };
    await h.start(0);
    h.state.voice = { connectedUsers: [{ id: 'B' }] };
    await h.start(1);
    expect(h.state.player.overlay).not.toHaveBeenCalled();
    expect(droppedReasons()).toContain('stale-member');
    expect(h.planner.getDebugState().transitionsSinceSpoken).toBe(1);
  });

  it('drops a line naming a member who opted out since preparation (stale-member)', async () => {
    const write = vi.fn(async (ctx) => ({
      forKey: ctx.next.key,
      text: 'For A!',
      pcm: PCM,
      factIds: [],
      namedUserIds: ['A']
    }));
    const h = setup({ tracks: [track(0, 10), track(1)], writeLine: write });
    await h.start(0);
    h.state.optOuts.add('A');
    await h.start(1);
    expect(h.state.player.overlay).not.toHaveBeenCalled();
    expect(droppedReasons()).toContain('stale-member');
    expect(h.planner.getDebugState().transitionsSinceSpoken).toBe(1);
  });

  it('does not speak a prepared line when the DJ was disabled before the transition', async () => {
    const h = setup({ tracks: [track(0, 10), track(1)] });
    await h.start(0);
    h.state.settings = { enabled: false, interval: 1 };
    await h.start(1);
    expect(h.state.player.overlay).not.toHaveBeenCalled();
  });

  it('never speaks when disabled (US1/AC3)', async () => {
    const h = setup({ tracks: Array.from({ length: 5 }, (_, i) => track(i)), enabled: false });
    for (let i = 0; i < 5; i++) {
      await h.start(i);
      await h.playOut(i);
    }
    expect(h.write).not.toHaveBeenCalled();
    expect(h.state.player.overlay).not.toHaveBeenCalled();
  });

  it('logs spoken lines without the PCM buffer', async () => {
    const h = setup({ tracks: [track(0, 10), track(1)] });
    await h.start(0);
    await h.start(1);
    const spokenLog = logger.info.mock.calls.find(([m]) => m === '[DJ] Line spoken');
    expect(spokenLog).toBeDefined();
    expect(JSON.stringify(logger.info.mock.calls)).not.toContain('"pcm"');
  });

  it('logs due, spoken and their ratio on shutdown', async () => {
    const h = setup({ tracks: [track(0, 10), track(1)] });
    await h.start(0);
    await h.start(1);
    h.planner.shutdown();
    expect(logger.info).toHaveBeenCalledWith(expect.stringMatching(/due=1 spoken=1 ratio=1\.00/));
  });
});

describe('linePlanner: themed intro (FR-006 exception, FR-028)', () => {
  const introCalls = (h) => h.write.mock.calls.filter(([ctx]) => ctx.intro === true);

  it('speaks the intro over the first themed track on an empty queue, though it is not a transition', async () => {
    const h = setup({ tracks: [track(0), track(1)], interval: 3, theme: 'classic rock' });
    h.planner.onTrackChange(null);
    h.state.introPending = true;
    h.planner.prepareIntro();
    await vi.advanceTimersByTimeAsync(0);

    await h.start(0);
    expect(h.state.player.overlay).toHaveBeenCalledTimes(1);
    expect(introCalls(h)).toHaveLength(1);
    const [ctx] = introCalls(h)[0];
    expect(ctx.theme).toBe('classic rock');
    expect(ctx.facts).toEqual([expect.objectContaining({ kind: 'theme' })]);
    expect(h.state.introPending).toBe(false);
    expect(h.planner.getDebugState().transitionsSinceSpoken).toBe(0);
  });

  it('after a theme change, the intro is spoken over the next track to start', async () => {
    const h = setup({ tracks: Array.from({ length: 4 }, (_, i) => track(i)), interval: 5 });
    await h.start(0);
    await h.start(1); // one transition
    h.state.theme = 'rainy day lo-fi';
    h.state.introPending = true;
    h.planner.prepareIntro();
    await vi.advanceTimersByTimeAsync(0);

    await h.start(2);
    expect(h.state.player.overlay).toHaveBeenCalledTimes(1);
    expect(introCalls(h)).toHaveLength(1);
    // The intro neither counts as the interval's line nor resets the count.
    expect(h.planner.getDebugState().transitionsSinceSpoken).toBe(2);
    expect(h.state.introPending).toBe(false);
  });

  it('does not reset transitionsSinceSpoken: the next regular line keeps its place', async () => {
    const h = setup({ tracks: Array.from({ length: 6 }, (_, i) => track(i, 10)), interval: 2 });
    h.state.theme = 'rock';
    await h.start(0);
    await h.start(1); // transition 1
    h.state.introPending = true;
    h.planner.prepareIntro();
    await vi.advanceTimersByTimeAsync(0);
    await h.start(2); // transition 2: intro instead of the regular line
    expect(h.planner.getDebugState().transitionsSinceSpoken).toBe(2);
    await h.start(3); // transition 3: still due
    expect(h.state.player.overlay).toHaveBeenCalledTimes(2);
    expect(h.planner.getDebugState().transitionsSinceSpoken).toBe(0);
  });

  it('prepares the intro as soon as it is pending, before any track starts', async () => {
    const h = setup({ tracks: [track(0)], theme: 'rock' });
    h.state.introPending = true;
    h.planner.prepareIntro();
    await vi.advanceTimersByTimeAsync(0);
    expect(introCalls(h)).toHaveLength(1);
    expect(h.planner.getDebugState().intro).toEqual({ status: 'ready' });
  });

  it('with commentary disabled, introPending is cleared and nothing is spoken', async () => {
    const h = setup({ tracks: [track(0), track(1)], enabled: false, theme: 'rock' });
    h.state.introPending = true;
    h.planner.prepareIntro();
    expect(h.state.introPending).toBe(false);

    h.state.introPending = true;
    await h.start(0);
    expect(h.state.introPending).toBe(false);
    expect(h.write).not.toHaveBeenCalled();
    expect(h.state.player.overlay).not.toHaveBeenCalled();
  });
});
