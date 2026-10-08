import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../../src/utils/logger.js', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() }
}));

import { createLinePlanner } from '../../../src/services/dj/linePlanner.js';
import { keyMatches, trackKey } from '../../../src/services/dj/context.js';
import { Queue } from '../../../src/core/queue.js';
import { logger } from '../../../src/utils/logger.js';

const PCM = Buffer.alloc(16);
const track = (id, duration = 200) => ({ title: id, url: `https://y/${id}`, duration });

let settings;
let queue;
let player;
let users;
let optOuts;
let breakerOk;
let capReached;
let writeLine;
let planner;

function makePlanner() {
  return createLinePlanner({
    getSettings: () => settings,
    getQueue: () => queue,
    getPlayer: () => player,
    getConnectedUsers: () => users,
    getOptOuts: () => optOuts,
    canAttempt: () => breakerOk,
    isLineCapReached: () => capReached,
    writeLine
  });
}

/** writeLine that resolves immediately with a line for the context's next track. */
const instantWriter = () =>
  vi.fn(async (ctx) => ({
    forKey: ctx.forKey,
    text: `Up next: ${ctx.next.title}.`,
    pcm: PCM,
    factIds: [],
    namedUserIds: []
  }));

/** Load the queue and start its first track as the mediator would. */
function startQueue(tracks) {
  for (const t of tracks) queue.add(t);
  queue.currentIndex = 0;
  planner.onTrackChange(queue.getCurrent());
}

/** Advance the queue like advanceAndPlay and report the start. */
function advance() {
  const t = queue.next();
  planner.onTrackChange(t);
  return t;
}

async function flush() {
  await vi.advanceTimersByTimeAsync(0);
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  settings = { enabled: true, interval: 1 };
  queue = new Queue();
  player = { overlay: vi.fn(() => true), isPaused: vi.fn(() => false) };
  users = [{ id: 'A' }];
  optOuts = new Set();
  breakerOk = true;
  capReached = false;
  writeLine = instantWriter();
  planner = makePlanner();
});

afterEach(() => {
  planner.stop();
  vi.useRealTimers();
});

describe('interval and transitions (FR-006)', () => {
  it('interval 3 over 6 transitions speaks exactly 2 times', async () => {
    settings.interval = 3;
    startQueue(Array.from({ length: 7 }, (_, i) => track(`t${i}`, 10)));
    await flush();
    for (let i = 0; i < 6; i++) {
      advance();
      await flush();
    }
    expect(player.overlay).toHaveBeenCalledTimes(2);
  });

  it('seven tracks from an idle queue are six transitions (cold start is not one)', async () => {
    startQueue(Array.from({ length: 7 }, (_, i) => track(`t${i}`, 10)));
    await flush();
    for (let i = 0; i < 6; i++) {
      advance();
      await flush();
    }
    expect(player.overlay).toHaveBeenCalledTimes(6);
  });

  it('the first track:change after track:change(null) is not a transition', async () => {
    startQueue([track('a', 10), track('b', 10)]);
    await flush();
    planner.onTrackChange(null);
    planner.onTrackChange(track('c', 10));
    await flush();
    expect(player.overlay).not.toHaveBeenCalled();
    expect(planner.getTransitionsSinceSpoken()).toBe(0);
  });

  it('a dropped line does not reset transitionsSinceSpoken', async () => {
    settings.interval = 2;
    writeLine = vi.fn(async () => {
      throw Object.assign(new Error('down'), { kind: 'llm' });
    });
    planner = makePlanner();
    startQueue([track('a', 10), track('b', 10), track('c', 10), track('d', 10)]);
    await flush();
    advance();
    await flush();
    advance(); // due, but the line failed: dropped
    await flush();
    expect(planner.getTransitionsSinceSpoken()).toBe(2);
    advance();
    expect(planner.getTransitionsSinceSpoken()).toBe(3);
  });

  it('resetCounter() restarts the count: with interval 4 the next line is at the 4th', async () => {
    settings.interval = 4;
    startQueue(Array.from({ length: 10 }, (_, i) => track(`t${i}`, 10)));
    await flush();
    advance();
    advance();
    await flush();
    planner.resetCounter();
    for (let i = 1; i <= 3; i++) {
      advance();
      await flush();
    }
    expect(player.overlay).not.toHaveBeenCalled();
    advance();
    await flush();
    expect(player.overlay).toHaveBeenCalledOnce();
  });

  it('a skip counts as a transition', async () => {
    startQueue([track('a', 200), track('b', 200)]);
    await vi.advanceTimersByTimeAsync(171_000); // line prepared at 170 s
    advance(); // skipped 29 s before the natural end
    expect(player.overlay).toHaveBeenCalledOnce();
    expect(planner.getTransitionsSinceSpoken()).toBe(0);
  });
});

describe('prediction and scheduling', () => {
  it('loop track: the prepared line matches the replayed track', async () => {
    queue.loopMode = 'track';
    startQueue([track('a', 10), track('b', 10)]);
    await flush();
    expect(writeLine.mock.calls[0][0].forKey).toBe('https://y/a');
    advance();
    await flush();
    expect(player.overlay).toHaveBeenCalledOnce();
  });

  it('loop queue at the last index: the prepared line matches tracks[0]', async () => {
    queue.loopMode = 'queue';
    startQueue([track('a', 10), track('b', 10)]);
    await flush();
    advance(); // now at b, the last index
    await flush();
    const last = writeLine.mock.calls.at(-1)[0];
    expect(last.forKey).toBe('https://y/a');
    expect(advance().url).toBe('https://y/a');
    await flush();
    expect(player.overlay).toHaveBeenCalledTimes(2);
  });

  it('preparation runs at max(0, duration − 30 s)', async () => {
    startQueue([track('a', 100), track('b', 100)]);
    await flush();
    expect(writeLine).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(69_999);
    expect(writeLine).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(writeLine).toHaveBeenCalledOnce();
  });

  it.each([
    ['unknown', undefined],
    ['shorter than 30 s', 20]
  ])('preparation runs immediately when the duration is %s', async (_n, duration) => {
    startQueue([{ ...track('a'), duration }, track('b')]);
    await flush();
    expect(writeLine).toHaveBeenCalledOnce();
  });

  it('a prepared line for a different track is discarded (rapid skip)', async () => {
    startQueue([track('a', 10), track('b', 10), track('c', 10)]);
    await flush();
    // Two skips in a row: c starts while the line was for b.
    queue.next();
    planner.onTrackChange(queue.next());
    await flush();
    expect(player.overlay).not.toHaveBeenCalled();
    expect(logger.info).toHaveBeenCalledWith(expect.stringMatching(/dropped \(stale\)/));
  });

  it('a line still in flight 2 s after track start is dropped and the track is not delayed', async () => {
    writeLine = vi.fn(
      (ctx) =>
        new Promise((resolve) =>
          setTimeout(
            () => resolve({ forKey: ctx.forKey, text: 'Late.', pcm: PCM, namedUserIds: [] }),
            5000
          )
        )
    );
    planner = makePlanner();
    startQueue([track('a', 10), track('b', 10)]);
    const started = advance(); // returns synchronously: nothing awaited the DJ
    expect(started.url).toBe('https://y/b');
    await vi.advanceTimersByTimeAsync(2000);
    expect(logger.info).toHaveBeenCalledWith(expect.stringMatching(/dropped \(late\)/));
    await vi.advanceTimersByTimeAsync(5000);
    expect(player.overlay).not.toHaveBeenCalled();
  });

  it('a line landing within 2 s of track start is still spoken', async () => {
    writeLine = vi.fn(
      (ctx) =>
        new Promise((resolve) =>
          setTimeout(
            () =>
              resolve({ forKey: ctx.forKey, text: 'Just in time.', pcm: PCM, namedUserIds: [] }),
            1500
          )
        )
    );
    planner = makePlanner();
    startQueue([track('a', 10), track('b', 10)]);
    advance();
    await vi.advanceTimersByTimeAsync(1500);
    expect(player.overlay).toHaveBeenCalledOnce();
  });

  it('a failed line is not retried for the same predicted track on every queue:update', async () => {
    writeLine = vi.fn(async () => {
      throw Object.assign(new Error('down'), { kind: 'llm' });
    });
    planner = makePlanner();
    startQueue([track('a', 10), track('b', 10)]);
    await flush();
    planner.onQueueUpdate();
    planner.onQueueUpdate();
    await flush();
    expect(writeLine).toHaveBeenCalledOnce();
  });

  it('a queue:update that changes the predicted next track discards and re-prepares', async () => {
    startQueue([track('a', 10), track('b', 10)]);
    await flush();
    expect(planner.getPrepared().forKey).toBe('https://y/b');
    queue.tracks.splice(1, 0, { ...track('z', 10), addedAt: new Date() });
    planner.onQueueUpdate();
    await flush();
    expect(writeLine).toHaveBeenCalledTimes(2);
    expect(planner.getPrepared().forKey).toBe('https://y/z');
    advance();
    expect(player.overlay).toHaveBeenCalledOnce();
  });
});

describe('queue identity across the switch and resolution', () => {
  it('a queue:update between queue.next() and trackStart keeps the prepared line', async () => {
    startQueue([track('a', 10), track('b', 10), track('c', 10)]);
    await flush();
    expect(planner.getPrepared().forKey).toBe('https://y/b');
    // tryPlayWithFallback: queue.next() runs, then play() is awaited.
    const started = queue.next();
    planner.onQueueUpdate(); // e.g. resolution:complete while play() resolves
    await flush();
    expect(writeLine).toHaveBeenCalledOnce();
    planner.onTrackChange(started);
    expect(player.overlay).toHaveBeenCalledOnce();
    expect(logger.info).not.toHaveBeenCalledWith(expect.stringContaining('Line dropped'));
  });

  it('a Spotify track resolving after its line was prepared keeps the line', async () => {
    const spotify = {
      title: 'b',
      url: null,
      duration: 10,
      spotifyData: { spotifyId: 'sp-b' }
    };
    startQueue([track('a', 10), spotify]);
    await flush();
    expect(planner.getPrepared().forKey).toBe('sp-b');
    spotify.url = 'https://y/resolved-b'; // resolution:complete
    planner.onQueueUpdate();
    await flush();
    expect(writeLine).toHaveBeenCalledOnce();
    expect(planner.getPrepared()).not.toBeNull();
    advance();
    expect(player.overlay).toHaveBeenCalledOnce();
  });
});

describe('silence conditions (R5 step 5)', () => {
  it.each([
    ['disabled', () => (settings.enabled = false)],
    ['paused', () => player.isPaused.mockReturnValue(true)],
    ['breaker open', () => (breakerOk = false)],
    ['line cap reached', () => (capReached = true)],
    ['no human listener (FR-010)', () => (users = [])],
    ['only bots present', () => (users = [{ id: 'bot', bot: true }])]
  ])('no preparation when %s', async (_n, apply) => {
    apply();
    startQueue([track('a', 10), track('b', 10)]);
    await flush();
    expect(writeLine).not.toHaveBeenCalled();
  });

  it('preparation is retried once a silence condition clears mid-window', async () => {
    player.isPaused.mockReturnValue(true);
    startQueue([track('a', 10), track('b', 10)]);
    await flush();
    expect(writeLine).not.toHaveBeenCalled();
    player.isPaused.mockReturnValue(false); // resume emits no queue:update
    await vi.advanceTimersByTimeAsync(10_000);
    expect(writeLine).toHaveBeenCalledOnce();
    advance();
    expect(player.overlay).toHaveBeenCalledOnce();
  });

  it('no preparation when the queue has no next track', async () => {
    startQueue([track('a', 10)]);
    await flush();
    expect(writeLine).not.toHaveBeenCalled();
  });

  it('a disabled DJ never speaks (US1/AC3)', async () => {
    startQueue(Array.from({ length: 4 }, (_, i) => track(`t${i}`, 10)));
    await flush();
    settings.enabled = false;
    for (let i = 0; i < 3; i++) {
      advance();
      await flush();
    }
    expect(player.overlay).not.toHaveBeenCalled();
  });

  it('nobody left in the channel at speak time drops the prepared line', async () => {
    startQueue([track('a', 10), track('b', 10)]);
    await flush();
    users = [];
    advance();
    expect(player.overlay).not.toHaveBeenCalled();
  });
});

describe('repeats and member re-check', () => {
  it('loop replays count as transitions but the same text is not spoken twice in a row', async () => {
    queue.loopMode = 'track';
    startQueue([track('a', 10)]);
    await flush();
    advance();
    await flush();
    expect(player.overlay).toHaveBeenCalledOnce();
    advance();
    await flush();
    expect(player.overlay).toHaveBeenCalledOnce();
    expect(planner.getTransitionsSinceSpoken()).toBe(1);
  });

  const namingWriter = () =>
    vi.fn(async (ctx) => ({
      forKey: ctx.forKey,
      text: 'This one is for A.',
      pcm: PCM,
      factIds: [],
      namedUserIds: ['A']
    }));

  it('a line naming A is dropped (stale-member) when A left without a voice:context event', async () => {
    users = [{ id: 'A' }, { id: 'B' }];
    writeLine = namingWriter();
    planner = makePlanner();
    startQueue([track('a', 10), track('b', 10)]);
    await flush();
    users = [{ id: 'B' }];
    advance();
    expect(player.overlay).not.toHaveBeenCalled();
    expect(logger.info).toHaveBeenCalledWith(expect.stringMatching(/dropped \(stale-member\)/));
    expect(planner.getTransitionsSinceSpoken()).toBe(1);
  });

  it('a line naming A is dropped (stale-member) when A opted out since preparation', async () => {
    writeLine = namingWriter();
    planner = makePlanner();
    startQueue([track('a', 10), track('b', 10)]);
    await flush();
    optOuts = new Set(['A']);
    advance();
    expect(player.overlay).not.toHaveBeenCalled();
    expect(logger.info).toHaveBeenCalledWith(expect.stringMatching(/dropped \(stale-member\)/));
    expect(planner.getTransitionsSinceSpoken()).toBe(1);
  });
});

describe('logging (T031)', () => {
  it('logs prepared and spoken lines without the buffer, and daily due/spoken counters', async () => {
    startQueue([track('a', 10), track('b', 10), track('c', 10)]);
    await flush();
    advance();
    await flush();
    users = [];
    advance(); // not due: no listeners, so not counted as due
    expect(planner.getDailyStats()).toEqual({ due: 1, spoken: 1 });

    const messages = logger.info.mock.calls.map((c) => c.join(' '));
    expect(messages.some((m) => /Line prepared key=\S+ chars=\d+ ms=\d+/.test(m))).toBe(true);
    expect(messages.some((m) => /Line spoken/.test(m))).toBe(true);
    for (const call of logger.info.mock.calls) {
      for (const arg of call) expect(Buffer.isBuffer(arg)).toBe(false);
    }

    planner.logDailyStats();
    expect(logger.info).toHaveBeenLastCalledWith('[DJ] Daily lines: due=1 spoken=1 ratio=1.00');
    expect(planner.getDailyStats()).toEqual({ due: 0, spoken: 0 });
  });
});

describe('trackKey', () => {
  it('prefers url, then spotifyId, then title|addedAt', () => {
    expect(trackKey({ url: 'u', spotifyData: { spotifyId: 's' } })).toBe('u');
    expect(trackKey({ url: null, spotifyData: { spotifyId: 's' } })).toBe('s');
    const addedAt = new Date('2026-10-08T10:00:00Z');
    expect(trackKey({ url: null, title: 'T', addedAt })).toBe(`T|${addedAt.toISOString()}`);
  });

  it('keyMatches accepts the pre-resolution spotifyId key once url is set', () => {
    const t = { url: 'u', spotifyData: { spotifyId: 's' } };
    expect(keyMatches('s', t)).toBe(true);
    expect(keyMatches('u', t)).toBe(true);
    expect(keyMatches('x', t)).toBe(false);
    expect(keyMatches(null, t)).toBe(false);
  });
});

describe('themed intro (FR-006 exception, FR-028)', () => {
  let session;

  function makeThemedPlanner() {
    return createLinePlanner({
      getSettings: () => settings,
      getQueue: () => queue,
      getPlayer: () => player,
      getConnectedUsers: () => users,
      getOptOuts: () => optOuts,
      canAttempt: () => breakerOk,
      isLineCapReached: () => capReached,
      writeLine,
      getTheme: () => session?.theme ?? null,
      getIntroTheme: () => (session?.introPending ? session.theme : null),
      clearIntro: () => {
        if (session) session.introPending = false;
      }
    });
  }

  beforeEach(() => {
    settings = { enabled: true, interval: 3 };
    session = null;
    planner.stop();
    planner = makeThemedPlanner();
  });

  it('on an empty queue the intro is spoken over the first themed track', async () => {
    session = { theme: 'classic rock', introPending: true };
    planner.onIntroPending(); // nothing queued yet: nothing to prepare
    expect(writeLine).not.toHaveBeenCalled();

    queue.add(track('p1', 200));
    planner.onQueueUpdate(); // the first pick lands: prepare its intro now
    await flush();
    expect(writeLine).toHaveBeenCalledOnce();
    const ctx = writeLine.mock.calls[0][0];
    expect(ctx).toMatchObject({ intro: true, theme: 'classic rock' });
    expect(keyMatches(ctx.forKey, queue.getCurrent())).toBe(true);

    planner.onTrackChange(queue.getCurrent()); // cold start: not a transition
    expect(player.overlay).toHaveBeenCalledOnce();
    expect(session.introPending).toBe(false);
    expect(planner.getTransitionsSinceSpoken()).toBe(0);
  });

  it('an intro still being written when the track starts is spoken within the grace window', async () => {
    let release;
    writeLine = vi.fn(
      (ctx) =>
        new Promise((resolve) => {
          release = () =>
            resolve({
              forKey: ctx.forKey,
              text: 'Welcome!',
              pcm: PCM,
              factIds: [],
              namedUserIds: []
            });
        })
    );
    planner = makeThemedPlanner();
    session = { theme: 'rock', introPending: true };
    queue.add(track('p1', 200));
    planner.onQueueUpdate();
    await flush(); // the intro request is out, not answered
    planner.onTrackChange(queue.getCurrent());
    expect(player.overlay).not.toHaveBeenCalled();
    release();
    await flush();
    expect(player.overlay).toHaveBeenCalledOnce();
    expect(session.introPending).toBe(false);
  });

  it('after a theme change the intro is spoken over the next track to start', async () => {
    startQueue([track('a', 200), track('b', 200), track('c', 200)]);
    await flush();
    writeLine.mockClear();
    session = { theme: 'jazz', introPending: true };
    planner.onIntroPending();
    await flush();
    expect(writeLine).toHaveBeenCalledOnce();
    expect(writeLine.mock.calls[0][0]).toMatchObject({ intro: true, theme: 'jazz' });
    expect(keyMatches(writeLine.mock.calls[0][0].forKey, queue.peekNext())).toBe(true);

    advance(); // transition 1 of 3: not due, but the intro is
    expect(player.overlay).toHaveBeenCalledOnce();
    expect(session.introPending).toBe(false);
  });

  it('the intro does not change transitionsSinceSpoken', async () => {
    startQueue([track('a', 10), track('b', 10), track('c', 10), track('d', 10)]);
    await flush();
    advance();
    await flush();
    expect(planner.getTransitionsSinceSpoken()).toBe(1);
    session = { theme: 'jazz', introPending: true };
    planner.onIntroPending();
    await flush();
    advance(); // intro spoken; this transition still counts
    expect(player.overlay).toHaveBeenCalledOnce();
    expect(planner.getTransitionsSinceSpoken()).toBe(2);
    await flush();
    advance(); // third transition: the ordinary line is due
    await flush();
    expect(player.overlay).toHaveBeenCalledTimes(2);
    expect(planner.getTransitionsSinceSpoken()).toBe(0);
  });

  it('with commentary disabled introPending is cleared and nothing is spoken', async () => {
    settings.enabled = false;
    session = { theme: 'rock', introPending: true };
    queue.add(track('p1', 200));
    planner.onIntroPending();
    planner.onQueueUpdate();
    planner.onTrackChange(queue.getCurrent());
    await flush();
    expect(session.introPending).toBe(false);
    expect(writeLine).not.toHaveBeenCalled();
    expect(player.overlay).not.toHaveBeenCalled();
  });

  it('ordinary lines carry the active theme into the context', async () => {
    settings.interval = 1;
    session = { theme: 'rock', introPending: false };
    startQueue([track('a', 10), track('b', 10)]);
    await flush();
    expect(writeLine.mock.calls[0][0]).toMatchObject({ theme: 'rock', intro: false });
  });
});
