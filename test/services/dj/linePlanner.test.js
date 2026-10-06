import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Queue } from '../../../src/core/queue.js';
import { createLinePlanner } from '../../../src/services/dj/linePlanner.js';

// Fake timers, a real Queue and a fake player. writeLine is a controllable fake,
// so every test decides when (and whether) a line is ready.

function track(n, extra = {}) {
  return { title: `Song ${n}`, url: `https://youtu.be/${n}`, duration: 200, ...extra };
}

function setup({ interval = 1, enabled = true, tracks = 7, writeDelayMs = 0 } = {}) {
  const settings = { enabled, interval };
  const queue = new Queue();
  for (let i = 1; i <= tracks; i++) queue.add(track(i));
  const player = {
    paused: false,
    overlay: vi.fn(() => !player.paused),
    isPaused: () => player.paused
  };
  const voice = { connectedUsers: [{ id: 'A', username: 'alice' }] };
  const state = { breakerOpen: false, capReached: false, optOuts: new Set(), lineNo: 0 };

  const writeLine = vi.fn(
    (ctx) =>
      new Promise((resolve, reject) => {
        const n = ++state.lineNo;
        const finish = () => {
          if (state.failNext) {
            state.failNext = false;
            reject(Object.assign(new Error('llm down'), { kind: 'llm' }));
            return;
          }
          resolve({
            forKey: ctx.forKey,
            text: state.fixedText ?? `Line number ${'x'.repeat(n)}.`,
            pcm: Buffer.alloc(4),
            factIds: ['f-next'],
            namedUserIds: state.namedUserIds ?? [],
            preparedAt: Date.now()
          });
        };
        if (writeDelayMs > 0) setTimeout(finish, writeDelayMs);
        else finish();
      })
  );

  const planner = createLinePlanner({
    getSettings: () => settings,
    getVoiceContext: () => voice,
    getQueue: () => queue,
    getPlayer: () => player,
    writeLine,
    isBreakerOpen: () => state.breakerOpen,
    isCapReached: () => state.capReached,
    getOptOuts: () => state.optOuts
  });

  // Mirror what advanceAndPlay + musicManager.onTrackChange do: move the
  // queue, emit track:change, then queue:update.
  function start(t) {
    planner.onTrackChange(t);
    planner.onQueueUpdate();
  }
  function advance() {
    const t = queue.next();
    start(t);
    return t;
  }
  function startFirst() {
    const t = queue.getCurrent();
    start(t);
    return t;
  }

  return { settings, queue, player, voice, state, writeLine, planner, start, advance, startFirst };
}

// Let the preparation timer fire and its promise chain settle.
async function playOut(ms = 200 * 1000) {
  await vi.advanceTimersByTimeAsync(ms);
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('linePlanner: counting transitions (FR-006)', () => {
  it('interval 3 over 6 transitions speaks exactly 2 times', async () => {
    const t = setup({ interval: 3 });
    t.startFirst();
    for (let i = 0; i < 6; i++) {
      await playOut();
      t.advance();
    }
    expect(t.player.overlay).toHaveBeenCalledTimes(2);
  });

  it('seven tracks from an idle queue are six transitions (US1/AC2)', async () => {
    const t = setup({ interval: 1 });
    t.start(null); // idle
    t.startFirst();
    for (let i = 0; i < 6; i++) {
      await playOut();
      t.advance();
    }
    expect(t.player.overlay).toHaveBeenCalledTimes(6);
    expect(t.planner.getStats()).toMatchObject({ due: 6, spoken: 6 });
  });

  it('the first start after track:change(null) is not a transition', async () => {
    const t = setup({ interval: 2 });
    t.startFirst();
    await playOut();
    t.advance(); // transition 1
    t.start(null); // stopped
    t.start(t.queue.getCurrent()); // not a transition
    expect(t.planner.getCounter()).toBe(1);
    await playOut();
    t.advance(); // transition 2: due
    expect(t.player.overlay).toHaveBeenCalledTimes(1);
  });

  it('a dropped line does not reset transitionsSinceSpoken', async () => {
    const t = setup({ interval: 2 });
    t.startFirst();
    await playOut();
    t.advance(); // 1
    t.state.failNext = true;
    await playOut();
    t.advance(); // 2: due, but the line failed
    expect(t.player.overlay).not.toHaveBeenCalled();
    expect(t.planner.getCounter()).toBe(2);
    await playOut();
    t.advance(); // 3: still due, speaks
    expect(t.player.overlay).toHaveBeenCalledTimes(1);
    expect(t.planner.getCounter()).toBe(0);
  });

  it('resetCounter() restarts the count: with interval 4 the next line is at the 4th transition after the call', async () => {
    const t = setup({ interval: 4, tracks: 10 });
    t.startFirst();
    await playOut();
    t.advance();
    await playOut();
    t.advance(); // counter 2
    t.planner.resetCounter();
    for (let i = 1; i <= 3; i++) {
      await playOut();
      t.advance();
      expect(t.player.overlay).not.toHaveBeenCalled();
    }
    await playOut();
    t.advance();
    expect(t.player.overlay).toHaveBeenCalledTimes(1);
  });

  it('a skip counts as a transition', async () => {
    const t = setup({ interval: 1 });
    t.startFirst();
    await vi.advanceTimersByTimeAsync(1000); // skipped 1 s in
    t.advance();
    expect(t.planner.getCounter()).toBe(1);
  });

  it('loop replays count as transitions but the same text is not spoken twice in a row for the same track', async () => {
    const t = setup({ interval: 1, tracks: 1 });
    t.queue.loopMode = 'track';
    t.state.fixedText = 'Here it comes again.';
    t.startFirst();
    await playOut();
    t.advance();
    expect(t.planner.getCounter()).toBe(0);
    expect(t.player.overlay).toHaveBeenCalledTimes(1);
    await playOut();
    t.advance();
    expect(t.player.overlay).toHaveBeenCalledTimes(1);
    expect(t.planner.getCounter()).toBe(1);
  });
});

describe('linePlanner: preparation timing (R5)', () => {
  it('prepares at max(0, duration - 30 s)', async () => {
    const t = setup({ interval: 1 });
    t.startFirst(); // duration 200 s
    await vi.advanceTimersByTimeAsync(169 * 1000);
    expect(t.writeLine).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1000);
    expect(t.writeLine).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['unknown', undefined],
    ['under 30 s', 20]
  ])('prepares immediately when the duration is %s', async (_name, duration) => {
    const t = setup({ interval: 1 });
    t.queue.tracks[0].duration = duration;
    t.startFirst();
    await vi.advanceTimersByTimeAsync(0);
    expect(t.writeLine).toHaveBeenCalledTimes(1);
  });

  it('predicts the next track with queue.peekNext() (loop track)', async () => {
    const t = setup({ interval: 1, tracks: 3 });
    t.queue.loopMode = 'track';
    t.startFirst();
    await playOut();
    expect(t.writeLine.mock.calls[0][0].forKey).toBe('https://youtu.be/1');
    t.advance();
    expect(t.player.overlay).toHaveBeenCalledTimes(1);
  });

  it('predicts the next track with queue.peekNext() (loop queue at the last index)', async () => {
    const t = setup({ interval: 1, tracks: 2 });
    t.queue.loopMode = 'queue';
    t.startFirst();
    await playOut();
    t.advance(); // now at the last index
    await playOut();
    expect(t.writeLine.mock.calls[1][0].forKey).toBe('https://youtu.be/1');
    const started = t.advance();
    expect(started.url).toBe('https://youtu.be/1');
    expect(t.player.overlay).toHaveBeenCalledTimes(2);
  });

  it('discards a prepared line whose forKey is not the started track (rapid skip)', async () => {
    const t = setup({ interval: 1 });
    t.startFirst();
    await playOut(); // line for track 2 ready
    // Skip straight to track 3, as if track 2 failed or was removed.
    t.queue.currentIndex = 1;
    t.advance();
    expect(t.player.overlay).not.toHaveBeenCalled();
  });

  it('drops a line still in flight 2 s after track start, never delaying the track', async () => {
    const t = setup({ interval: 1, writeDelayMs: 5000 });
    t.startFirst();
    await vi.advanceTimersByTimeAsync(170 * 1000); // prep starts, needs 5 s
    const started = t.advance(); // synchronous: never awaits the DJ
    expect(started.url).toBe('https://youtu.be/2');
    await vi.advanceTimersByTimeAsync(2000);
    await vi.advanceTimersByTimeAsync(5000);
    expect(t.player.overlay).not.toHaveBeenCalled();
    expect(t.planner.getCounter()).toBe(1);
  });

  it('speaks a line that lands within the 2 s window', async () => {
    const t = setup({ interval: 1, writeDelayMs: 1500 });
    t.startFirst();
    await vi.advanceTimersByTimeAsync(170 * 1000);
    t.advance();
    await vi.advanceTimersByTimeAsync(1600);
    expect(t.player.overlay).toHaveBeenCalledTimes(1);
  });

  it('re-prepares when a queue:update changes the predicted next track', async () => {
    const t = setup({ interval: 1 });
    t.startFirst();
    await playOut();
    expect(t.writeLine).toHaveBeenCalledTimes(1);
    t.queue.reorder(2, 1); // song 3 is now next
    t.planner.onQueueUpdate();
    await vi.advanceTimersByTimeAsync(0);
    expect(t.writeLine).toHaveBeenCalledTimes(2);
    expect(t.writeLine.mock.calls[1][0].forKey).toBe('https://youtu.be/3');
    t.advance();
    expect(t.player.overlay).toHaveBeenCalledTimes(1);
  });

  it('does not re-prepare on a queue:update that keeps the next track', async () => {
    const t = setup({ interval: 1 });
    t.startFirst();
    await playOut();
    t.queue.add(track(99));
    t.planner.onQueueUpdate();
    await vi.advanceTimersByTimeAsync(0);
    expect(t.writeLine).toHaveBeenCalledTimes(1);
  });

  it('keeps a prepared line when the next Spotify track resolves in the background', async () => {
    const t = setup({ interval: 1, tracks: 1 });
    const lazy = {
      title: 'Lazy',
      url: null,
      duration: 200,
      spotifyData: { spotifyId: 'sp-lazy' }
    };
    t.queue.add(lazy);
    t.startFirst();
    await playOut();
    expect(t.writeLine.mock.calls[0][0].forKey).toBe('sp-lazy');
    // Background resolution mutates the queue entry: its key goes from the
    // Spotify id to the URL.
    t.queue.peekNext().url = 'https://youtu.be/lazy';
    t.planner.onQueueUpdate();
    await vi.advanceTimersByTimeAsync(0);
    expect(t.writeLine).toHaveBeenCalledTimes(1);
    t.advance();
    expect(t.player.overlay).toHaveBeenCalledTimes(1);
  });

  it('keeps an in-flight line when the next Spotify track resolves meanwhile', async () => {
    const t = setup({ interval: 1, tracks: 1, writeDelayMs: 10000 });
    const lazy = { title: 'Lazy', url: null, duration: 200, spotifyData: { spotifyId: 'sp-lazy' } };
    t.queue.add(lazy);
    t.startFirst();
    await vi.advanceTimersByTimeAsync(170 * 1000);
    t.queue.peekNext().url = 'https://youtu.be/lazy';
    t.planner.onQueueUpdate();
    await vi.advanceTimersByTimeAsync(10000);
    expect(t.writeLine).toHaveBeenCalledTimes(1);
    t.advance();
    expect(t.player.overlay).toHaveBeenCalledTimes(1);
  });

  it('keeps one preparation in flight at a time', async () => {
    const t = setup({ interval: 1, writeDelayMs: 10000 });
    t.startFirst();
    await vi.advanceTimersByTimeAsync(170 * 1000);
    t.queue.reorder(2, 1);
    t.planner.onQueueUpdate();
    t.queue.reorder(2, 1);
    t.planner.onQueueUpdate();
    expect(t.writeLine).toHaveBeenCalledTimes(1);
  });
});

describe('linePlanner: silence conditions (R5 step 5, FR-010)', () => {
  it.each([
    ['disabled', (t) => (t.settings.enabled = false)],
    ['paused', (t) => (t.player.paused = true)],
    ['no next track', (t) => (t.queue.tracks.length = 1)],
    ['breaker open', (t) => (t.state.breakerOpen = true)],
    ['line cap reached', (t) => (t.state.capReached = true)],
    ['no human listener', (t) => (t.voice.connectedUsers = [])]
  ])('does not prepare when %s', async (_name, arrange) => {
    const t = setup({ interval: 1 });
    arrange(t);
    t.startFirst();
    await playOut();
    expect(t.writeLine).not.toHaveBeenCalled();
  });

  it('never speaks when disabled (US1/AC3)', async () => {
    const t = setup({ interval: 1, enabled: false });
    t.startFirst();
    for (let i = 0; i < 6; i++) {
      await playOut();
      t.advance();
    }
    expect(t.writeLine).not.toHaveBeenCalled();
    expect(t.player.overlay).not.toHaveBeenCalled();
  });

  it('does not speak a prepared line when everyone has left by track start', async () => {
    const t = setup({ interval: 1 });
    t.startFirst();
    await playOut();
    t.voice.connectedUsers = [];
    t.advance();
    expect(t.player.overlay).not.toHaveBeenCalled();
  });

  it('drops a line naming a member who left, without a voice:context event (stale-member)', async () => {
    const t = setup({ interval: 1 });
    t.state.namedUserIds = ['A'];
    t.startFirst();
    await playOut();
    t.voice.connectedUsers = [{ id: 'B', username: 'bob' }];
    t.advance();
    expect(t.player.overlay).not.toHaveBeenCalled();
    expect(t.planner.getCounter()).toBe(1);
  });

  it('drops a line naming a member who opted out since preparation (stale-member)', async () => {
    const t = setup({ interval: 1 });
    t.state.namedUserIds = ['A'];
    t.startFirst();
    await playOut();
    t.state.optOuts.add('A');
    t.advance();
    expect(t.player.overlay).not.toHaveBeenCalled();
    expect(t.planner.getCounter()).toBe(1);
  });

  it('speaks a line naming a member who is still present and opted in', async () => {
    const t = setup({ interval: 1 });
    t.state.namedUserIds = ['A'];
    t.startFirst();
    await playOut();
    t.advance();
    expect(t.player.overlay).toHaveBeenCalledTimes(1);
  });
});
