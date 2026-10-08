import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// djService keeps module-level state, so each test imports a fresh copy.
const mocks = vi.hoisted(() => ({
  emitter: null,
  db: null,
  planner: null,
  writeLine: null,
  queue: null,
  connected: true
}));

vi.mock('../../../src/core/musicManager.js', async () => {
  const { EventEmitter } = await import('events');
  const mm = new EventEmitter();
  mm.setGetDjState = vi.fn();
  mm.getVoiceContext = vi.fn(() => ({ connectedUsers: [{ id: 'A' }] }));
  mm.onQueueCleared = null;
  mm.setOnQueueCleared = vi.fn((fn) => {
    mm.onQueueCleared = fn;
  });
  mm.getPlayerState = vi.fn(() => ({ connected: mocks.connected }));
  mm.addToQueue = vi.fn((track) => {
    mocks.queue.add(track);
    mm.emit('queue:update', {
      tracks: mocks.queue.getAll(),
      currentIndex: mocks.queue.currentIndex
    });
    return true;
  });
  mm.ensurePlaying = vi.fn(async () => true);
  mocks.emitter = mm;
  return { musicManager: mm };
});
vi.mock('../../../src/persistence/db.js', () => {
  const usage = new Map();
  const db = {
    settings: { enabled: false, interval: 3, lookahead: 5 },
    getDjSettings: vi.fn(() => ({ ...db.settings })),
    updateDjSettings: vi.fn((partial) => Object.assign(db.settings, partial)),
    getDjUsage: vi.fn((day) => ({ lines: 0, themed_tracks: 0, ...usage.get(day) })),
    incrementDjUsage: vi.fn((day, field) => {
      const row = { lines: 0, themed_tracks: 0, ...usage.get(day) };
      row[field]++;
      usage.set(day, row);
    }),
    getShoutoutOptOuts: vi.fn(() => new Set()),
    getTopTracks: vi.fn(() => []),
    usage
  };
  mocks.db = db;
  return { db };
});
vi.mock('../../../src/config/env.js', () => ({
  getDjConfig: () => ({ caps: { lines: 2, themedTracks: 100 } })
}));
vi.mock('../../../src/services/playback.js', () => ({
  getPlayer: vi.fn(() => null),
  getQueue: vi.fn(() => mocks.queue)
}));
vi.mock('../../../src/integrations/llm.js', () => ({ chatJson: vi.fn() }));
vi.mock('../../../src/services/resolver.js', () => ({ resolveSpotifyTrack: vi.fn() }));
vi.mock('../../../src/services/dj/lineWriter.js', () => ({
  writeLine: vi.fn()
}));
vi.mock('../../../src/services/dj/linePlanner.js', () => ({
  createLinePlanner: vi.fn((deps) => {
    mocks.planner = {
      deps,
      onTrackChange: vi.fn(),
      onQueueUpdate: vi.fn(),
      resetCounter: vi.fn(),
      refresh: vi.fn(),
      prepareIntro: vi.fn(),
      rollDay: vi.fn(),
      shutdown: vi.fn()
    };
    return mocks.planner;
  })
}));
vi.mock('../../../src/utils/logger.js', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() }
}));

let dj;
let lineWriter;
let llm;
let resolver;

async function freshService({ settings } = {}) {
  vi.resetModules();
  // Fresh module graph: the mocks re-run and repopulate `mocks` on import.
  const { Queue } = await import('../../../src/core/queue.js');
  mocks.queue = new Queue();
  mocks.connected = true;
  dj = await import('../../../src/services/dj/djService.js');
  lineWriter = await import('../../../src/services/dj/lineWriter.js');
  llm = await import('../../../src/integrations/llm.js');
  resolver = await import('../../../src/services/resolver.js');
  mocks.db.settings = { enabled: false, interval: 3, lookahead: 5, ...settings };
  // Mocked modules can survive resetModules; start every test from zero.
  mocks.db.usage.clear();
  vi.clearAllMocks();
  lineWriter.writeLine.mockReset();
}

function djStateEvents() {
  const events = [];
  mocks.emitter.on('dj:state', (s) => events.push(s));
  return events;
}

beforeEach(async () => {
  vi.useFakeTimers({ now: new Date(2026, 9, 8, 12, 0, 0) });
  await freshService();
});
afterEach(() => {
  dj.shutdown();
  vi.useRealTimers();
});

describe('djService: unconfigured', () => {
  it('reports unavailable and rejects mutations with DJ_UNAVAILABLE', () => {
    expect(dj.getState()).toEqual({ available: false });
    expect(dj.getStateOrUnavailable()).toEqual({ available: false });
    expect(() => dj.setSettings({ enabled: true })).toThrow(
      expect.objectContaining({ code: 'DJ_UNAVAILABLE' })
    );
    expect(mocks.db.updateDjSettings).not.toHaveBeenCalled();
  });
});

describe('djService: settings', () => {
  beforeEach(() => dj.init());

  it('rejects interval 11 with INVALID_INTERVAL and leaves state unchanged', () => {
    const before = dj.getState();
    const events = djStateEvents();
    expect(() => dj.setSettings({ interval: 11, enabled: true })).toThrow(
      expect.objectContaining({ code: 'INVALID_INTERVAL' })
    );
    expect(dj.getState()).toEqual(before);
    expect(mocks.db.updateDjSettings).not.toHaveBeenCalled();
    expect(events).toHaveLength(0);
  });

  it('rejects lookahead 7 with INVALID_LOOKAHEAD', () => {
    expect(() => dj.setSettings({ lookahead: 7 })).toThrow(
      expect.objectContaining({ code: 'INVALID_LOOKAHEAD' })
    );
    expect(mocks.db.updateDjSettings).not.toHaveBeenCalled();
  });

  it('a valid mutation persists once and emits exactly one dj:state', () => {
    const events = djStateEvents();
    const state = dj.setSettings({ enabled: true, interval: 1 });
    expect(mocks.db.updateDjSettings).toHaveBeenCalledTimes(1);
    expect(events).toHaveLength(1);
    expect(state).toMatchObject({ available: true, enabled: true, interval: 1 });
  });

  it('resets the planner counter when interval changes', () => {
    dj.setSettings({ interval: 4 });
    expect(mocks.planner.resetCounter).toHaveBeenCalledTimes(1);
  });

  it('resets the planner counter when enabled goes false → true', () => {
    dj.setSettings({ enabled: true });
    expect(mocks.planner.resetCounter).toHaveBeenCalledTimes(1);
  });

  it('does not reset the counter on a lookahead-only change', () => {
    dj.setSettings({ lookahead: 10 });
    expect(mocks.planner.resetCounter).not.toHaveBeenCalled();
  });

  it('does not reset the counter when enabled is already true', async () => {
    dj.shutdown();
    await freshService({ settings: { enabled: true } });
    dj.init();
    dj.setSettings({ enabled: true });
    expect(mocks.planner.resetCounter).not.toHaveBeenCalled();
  });

  it('forwards mediator track:change and queue:update to the planner', () => {
    const t = { title: 'x' };
    mocks.emitter.emit('track:change', t);
    mocks.emitter.emit('queue:update', { tracks: [] });
    expect(mocks.planner.onTrackChange).toHaveBeenCalledWith(t);
    expect(mocks.planner.onQueueUpdate).toHaveBeenCalledTimes(1);
  });
});

describe('djService: breaker (R9)', () => {
  beforeEach(() => dj.init());

  it('3 consecutive failures degrade health; after 5 min one success restores ok', () => {
    dj.recordFailure('llm');
    dj.recordFailure('llm');
    expect(dj.getState().health).toBe('ok');
    dj.recordFailure('llm');
    expect(dj.getState().health).toBe('degraded');
    expect(dj.canAttempt()).toBe(false);

    vi.advanceTimersByTime(5 * 60 * 1000);
    expect(dj.canAttempt()).toBe(true); // half-open: one attempt
    expect(dj.canAttempt()).toBe(false);
    dj.recordSuccess();
    expect(dj.getState().health).toBe('ok');
  });

  it('a quota failure keeps the breaker open for 30 min', () => {
    dj.recordFailure('quota');
    expect(dj.getState().health).toBe('degraded');
    vi.advanceTimersByTime(29 * 60 * 1000);
    expect(dj.canAttempt()).toBe(false);
    vi.advanceTimersByTime(60 * 1000);
    expect(dj.canAttempt()).toBe(true);
  });

  it('feeds writeLine outcomes to the breaker through the planner dependency', async () => {
    const failure = Object.assign(new Error('down'), { kind: 'llm' });
    lineWriter.writeLine.mockRejectedValue(failure);
    for (let i = 0; i < 3; i++) {
      await expect(mocks.planner.deps.writeLine({}, [])).rejects.toBe(failure);
    }
    expect(dj.getState().health).toBe('degraded');
    expect(mocks.db.incrementDjUsage).not.toHaveBeenCalled();
  });
});

describe('djService: caps', () => {
  beforeEach(() => dj.init());

  it('counts usage only on successful TTS and flips caps.lines.reached at the limit', async () => {
    lineWriter.writeLine.mockRejectedValueOnce(Object.assign(new Error('x'), { kind: 'rate' }));
    await expect(mocks.planner.deps.writeLine({}, [])).rejects.toThrow();
    expect(mocks.db.incrementDjUsage).not.toHaveBeenCalled();

    lineWriter.writeLine.mockResolvedValue({ text: 'ok', pcm: Buffer.alloc(4) });
    const events = djStateEvents();
    await mocks.planner.deps.writeLine({}, []);
    expect(mocks.db.incrementDjUsage).toHaveBeenCalledWith('2026-10-08', 'lines');
    expect(dj.getState().caps.lines).toMatchObject({ used: 1, limit: 2, reached: false });
    expect(mocks.planner.deps.isCapReached()).toBe(false);

    await mocks.planner.deps.writeLine({}, []);
    expect(dj.getState().caps.lines).toMatchObject({ used: 2, reached: true });
    expect(mocks.planner.deps.isCapReached()).toBe(true);
    expect(events.filter((s) => s.caps.lines.reached)).toHaveLength(1);
  });

  it('crossing local midnight clears reached, moves resetsAt a day, and emits one dj:state', async () => {
    lineWriter.writeLine.mockResolvedValue({ text: 'ok', pcm: Buffer.alloc(4) });
    await mocks.planner.deps.writeLine({}, []);
    await mocks.planner.deps.writeLine({}, []);
    const before = dj.getState();
    expect(before.caps.lines.reached).toBe(true);

    const events = djStateEvents();
    vi.advanceTimersByTime(12 * 60 * 60 * 1000); // to 2026-10-09 00:00 local
    expect(events).toHaveLength(1);
    expect(events[0].caps.lines.reached).toBe(false);
    expect(
      new Date(events[0].caps.resetsAt).getTime() - new Date(before.caps.resetsAt).getTime()
    ).toBe(24 * 60 * 60 * 1000);
    expect(mocks.planner.rollDay).toHaveBeenCalledTimes(1);
  });
});

describe('djService: themed mode (US4, contracts §3)', () => {
  const ACTOR = { id: 'A', name: 'Alice' };
  const ORIGIN = { transport: 'http' };

  function picks(n, prefix = 'p') {
    return {
      picks: Array.from({ length: n }, (_, i) => ({
        artist: `Artist ${i}`,
        title: `${prefix}${i}`
      }))
    };
  }

  beforeEach(() => {
    dj.init();
    llm.chatJson.mockResolvedValue(picks(9));
    resolver.resolveSpotifyTrack.mockImplementation(async ({ title }) => ({
      url: `https://yt/${title}`,
      title,
      duration: 200
    }));
  });

  it.each([
    ['empty', '   '],
    ['over 200 characters', 'x'.repeat(201)],
    ['not clean', 'songs for a retard']
  ])('rejects a theme that is %s with INVALID_THEME', async (_label, theme) => {
    const events = djStateEvents();
    await expect(dj.startTheme({ theme }, ACTOR, ORIGIN)).rejects.toMatchObject({
      code: 'INVALID_THEME'
    });
    expect(dj.getState().theme).toBeNull();
    expect(events).toHaveLength(0);
    expect(llm.chatJson).not.toHaveBeenCalled();
  });

  it('accepts exactly 200 characters after trimming', async () => {
    const theme = '  ' + 'a'.repeat(200) + '  ';
    const state = await dj.startTheme({ theme }, ACTOR, ORIGIN);
    expect(state.theme.theme).toBe('a'.repeat(200));
  });

  it('rejects with NOT_IN_VOICE when the bot is not connected', async () => {
    mocks.connected = false;
    await expect(dj.startTheme({ theme: 'rock' }, ACTOR, ORIGIN)).rejects.toMatchObject({
      code: 'NOT_IN_VOICE'
    });
    expect(mocks.queue.prioritizeMemberTracks).toBe(false);
  });

  it('rejects with SERVICE_UNAVAILABLE while the breaker is open', async () => {
    dj.recordFailure('quota');
    await expect(dj.startTheme({ theme: 'rock' }, ACTOR, ORIGIN)).rejects.toMatchObject({
      code: 'SERVICE_UNAVAILABLE'
    });
    expect(llm.chatJson).not.toHaveBeenCalled();
  });

  it('rejects with CAP_REACHED when the themed-track cap is reached', async () => {
    for (let i = 0; i < 100; i++) dj.recordUsage('themed_tracks');
    await expect(dj.startTheme({ theme: 'rock' }, ACTOR, ORIGIN)).rejects.toMatchObject({
      code: 'CAP_REACHED'
    });
  });

  it('rejects an invalid lookahead with INVALID_LOOKAHEAD and persists a valid one', async () => {
    await expect(
      dj.startTheme({ theme: 'rock', lookahead: 7 }, ACTOR, ORIGIN)
    ).rejects.toMatchObject({ code: 'INVALID_LOOKAHEAD' });
    await dj.startTheme({ theme: 'rock', lookahead: 10 }, ACTOR, ORIGIN);
    expect(mocks.db.updateDjSettings).toHaveBeenCalledWith({ lookahead: 10 });
    expect(dj.getState().lookahead).toBe(10);
  });

  it('starts: sets the flag, queues picks, starts playback, reports ThemeState once', async () => {
    const events = djStateEvents();
    const state = await dj.startTheme({ theme: ' classic rock ' }, ACTOR, ORIGIN);
    expect(mocks.queue.prioritizeMemberTracks).toBe(true);
    expect(mocks.queue.length).toBeGreaterThanOrEqual(1);
    expect(mocks.emitter.ensurePlaying).toHaveBeenCalledTimes(1);
    expect(state.theme).toEqual({
      theme: 'classic rock',
      startedBy: ACTOR,
      startedAt: expect.any(String),
      status: 'running',
      reason: null
    });
    expect(events.filter((s) => s.theme?.theme === 'classic rock')).toHaveLength(1);

    // The rest of the batch lands in the background; the first entry is
    // playing, so 5 more make the lookahead.
    await vi.advanceTimersByTimeAsync(0);
    expect(mocks.queue.countUpcoming((t) => t.addedByDj)).toBe(5);
  });

  it('throws NO_TRACKS_FOR_THEME and leaves no session when nothing resolves', async () => {
    resolver.resolveSpotifyTrack.mockResolvedValue(null);
    await expect(dj.startTheme({ theme: 'zzzzqqqq' }, ACTOR, ORIGIN)).rejects.toMatchObject({
      code: 'NO_TRACKS_FOR_THEME'
    });
    expect(dj.getState().theme).toBeNull();
    expect(mocks.queue.prioritizeMemberTracks).toBe(false);
    expect(mocks.emitter.ensurePlaying).not.toHaveBeenCalled();
  });

  it('a second start changes the theme, keeps usedKeys and sets introPending', async () => {
    await dj.startTheme({ theme: 'rock' }, ACTOR, ORIGIN);
    await vi.advanceTimersByTimeAsync(0);
    const queuedBefore = mocks.queue.getAll().map((t) => t.url);
    const events = djStateEvents();

    llm.chatJson.mockClear();
    const state = await dj.startTheme({ theme: 'lo-fi' }, { id: 'B', name: 'Bob' }, ORIGIN);
    expect(state.theme.theme).toBe('lo-fi');
    expect(state.theme.startedBy).toEqual(ACTOR);
    expect(events).toHaveLength(1);
    expect(mocks.planner.deps.isIntroPending()).toBe(true);
    expect(mocks.planner.prepareIntro).toHaveBeenCalled();
    // Previously queued themed tracks stay (US4/AC7).
    expect(
      mocks.queue
        .getAll()
        .map((t) => t.url)
        .slice(0, queuedBefore.length)
    ).toEqual(queuedBefore);

    // Advance a track so a top-up runs; it must avoid the old picks.
    mocks.queue.currentIndex = 1;
    mocks.emitter.emit('track:change', mocks.queue.getCurrent());
    await vi.advanceTimersByTimeAsync(1000);
    const avoid = llm.chatJson.mock.calls.at(-1)[0].user.avoid;
    expect(avoid).toContain('artist 0 - p0');
    expect(llm.chatJson.mock.calls.at(-1)[0].user.theme).toBe('lo-fi');
  });

  it('stopTheme clears the flag, keeps queued picks, and broadcasts once', async () => {
    await dj.startTheme({ theme: 'rock' }, ACTOR, ORIGIN);
    await vi.advanceTimersByTimeAsync(0);
    const queued = mocks.queue.length;
    const events = djStateEvents();

    const state = dj.stopTheme(ACTOR);
    expect(state.theme).toBeNull();
    expect(mocks.queue.prioritizeMemberTracks).toBe(false);
    expect(mocks.queue.length).toBe(queued);
    expect(events).toHaveLength(1);

    // No further additions.
    llm.chatJson.mockClear();
    mocks.queue.currentIndex = 3;
    mocks.emitter.emit('track:change', mocks.queue.getCurrent());
    await vi.advanceTimersByTimeAsync(5000);
    expect(llm.chatJson).not.toHaveBeenCalled();
  });

  it('works with commentary disabled (silent build)', async () => {
    expect(dj.getState().enabled).toBe(false);
    const state = await dj.startTheme({ theme: 'rock' }, ACTOR, ORIGIN);
    expect(state.theme.status).toBe('running');
    expect(mocks.queue.length).toBeGreaterThan(0);
    expect(lineWriter.writeLine).not.toHaveBeenCalled();
  });

  it('init() registers a clear hook that stops a running session (FR-024b)', async () => {
    expect(mocks.emitter.setOnQueueCleared).toHaveBeenCalledTimes(1);
    await dj.startTheme({ theme: 'rock' }, ACTOR, ORIGIN);
    const events = djStateEvents();

    mocks.emitter.onQueueCleared();
    expect(mocks.queue.prioritizeMemberTracks).toBe(false);
    expect(events).toHaveLength(1);
    expect(events[0].theme).toBeNull();
  });

  it('the clear hook is a no-op with no broadcast when no session exists', () => {
    const events = djStateEvents();
    mocks.emitter.onQueueCleared();
    expect(events).toHaveLength(0);
  });

  it('stopTheme and startTheme throw DJ_UNAVAILABLE when unconfigured', async () => {
    dj.shutdown();
    await freshService();
    expect(() => dj.stopTheme(ACTOR)).toThrow(expect.objectContaining({ code: 'DJ_UNAVAILABLE' }));
    await expect(dj.startTheme({ theme: 'rock' }, ACTOR, ORIGIN)).rejects.toMatchObject({
      code: 'DJ_UNAVAILABLE'
    });
  });
});
