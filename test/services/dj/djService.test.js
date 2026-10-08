import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// djService keeps module-level state, so each test imports a fresh copy.
const mocks = vi.hoisted(() => ({
  emitter: null,
  db: null,
  planner: null,
  writeLine: null
}));

vi.mock('../../../src/core/musicManager.js', async () => {
  const { EventEmitter } = await import('events');
  const mm = new EventEmitter();
  mm.setGetDjState = vi.fn();
  mm.getVoiceContext = vi.fn(() => ({ connectedUsers: [{ id: 'A' }] }));
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
  getQueue: vi.fn(() => null)
}));
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

async function freshService({ settings } = {}) {
  vi.resetModules();
  // Fresh module graph: the mocks re-run and repopulate `mocks` on import.
  dj = await import('../../../src/services/dj/djService.js');
  lineWriter = await import('../../../src/services/dj/lineWriter.js');
  mocks.db.settings = { enabled: false, interval: 3, lookahead: 5, ...settings };
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
