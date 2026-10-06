import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// djService with its edges mocked: an in-memory db fake, a bare EventEmitter as
// the mediator, a stub planner (so resetCounter calls can be counted) and a
// controllable writeLine.

const usage = new Map();
const store = { settings: { enabled: false, interval: 3, lookahead: 5 } };

vi.mock('../../../src/persistence/db.js', () => ({
  db: {
    getDjSettings: vi.fn(() => ({ ...store.settings })),
    updateDjSettings: vi.fn((partial) => {
      store.settings = { ...store.settings, ...partial };
      return { ...store.settings };
    }),
    getDjUsage: vi.fn((day) => ({ lines: 0, themed_tracks: 0, ...usage.get(day) })),
    incrementDjUsage: vi.fn((day, field) => {
      const row = { lines: 0, themed_tracks: 0, ...usage.get(day) };
      row[field]++;
      usage.set(day, row);
    })
  }
}));

vi.mock('../../../src/core/musicManager.js', async () => {
  const { EventEmitter } = await import('events');
  const mm = new EventEmitter();
  mm.setGetDjState = vi.fn();
  mm.getVoiceContext = vi.fn(() => null);
  return { musicManager: mm };
});

vi.mock('../../../src/services/playback.js', () => ({
  getPlayer: vi.fn(() => null),
  getQueue: vi.fn(() => null)
}));

const plannerStub = {
  onTrackChange: vi.fn(),
  onQueueUpdate: vi.fn(),
  resetCounter: vi.fn(),
  rolloverStats: vi.fn(),
  shutdown: vi.fn()
};
let plannerDeps = null;
vi.mock('../../../src/services/dj/linePlanner.js', () => ({
  createLinePlanner: vi.fn((deps) => {
    plannerDeps = deps;
    return plannerStub;
  })
}));

vi.mock('../../../src/services/dj/lineWriter.js', () => ({ writeLine: vi.fn() }));

const { musicManager } = await import('../../../src/core/musicManager.js');
const { db } = await import('../../../src/persistence/db.js');
const { writeLine } = await import('../../../src/services/dj/lineWriter.js');
const dj = await import('../../../src/services/dj/djService.js');

const DJ_ENV = {
  ELEVENLABS_API_KEY: 'k',
  ELEVENLABS_VOICE_ID: 'v',
  DJ_LLM_BASE_URL: 'http://llm.local',
  DJ_LLM_MODEL: 'm',
  DJ_DAILY_LINE_CAP: '2'
};

let emitted;
function onState(state) {
  emitted.push(state);
}

beforeEach(() => {
  for (const [k, v] of Object.entries(DJ_ENV)) vi.stubEnv(k, v);
  usage.clear();
  store.settings = { enabled: false, interval: 3, lookahead: 5 };
  vi.clearAllMocks();
  emitted = [];
  musicManager.on('dj:state', onState);
  dj.init();
});

afterEach(() => {
  dj.shutdown();
  musicManager.off('dj:state', onState);
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

describe('djService.setSettings (FR-011–FR-013)', () => {
  it('rejects interval 11 with INVALID_INTERVAL and leaves state unchanged', () => {
    const before = dj.getState();
    expect(() => dj.setSettings({ interval: 11, enabled: true })).toThrow(
      expect.objectContaining({ code: 'INVALID_INTERVAL' })
    );
    expect(dj.getState()).toEqual(before);
    expect(db.updateDjSettings).not.toHaveBeenCalled();
    expect(emitted).toHaveLength(0);
  });

  it('rejects lookahead 7 with INVALID_LOOKAHEAD', () => {
    expect(() => dj.setSettings({ lookahead: 7 })).toThrow(
      expect.objectContaining({ code: 'INVALID_LOOKAHEAD' })
    );
    expect(emitted).toHaveLength(0);
  });

  it('emits exactly one dj:state per valid mutation', () => {
    dj.setSettings({ enabled: true, interval: 2, lookahead: 10 });
    expect(emitted).toHaveLength(1);
    expect(emitted[0]).toMatchObject({ enabled: true, interval: 2, lookahead: 10 });
  });

  it('restarts the planner count when the interval changes', () => {
    dj.setSettings({ interval: 5 });
    expect(plannerStub.resetCounter).toHaveBeenCalledTimes(1);
  });

  it('restarts the planner count when the DJ is turned on, not when it stays on', () => {
    dj.setSettings({ enabled: true });
    expect(plannerStub.resetCounter).toHaveBeenCalledTimes(1);
    dj.setSettings({ enabled: true });
    expect(plannerStub.resetCounter).toHaveBeenCalledTimes(1);
  });

  it('does not restart the count for a lookahead-only change', () => {
    dj.setSettings({ lookahead: 10 });
    expect(plannerStub.resetCounter).not.toHaveBeenCalled();
  });

  it('rejects mutations with DJ_UNAVAILABLE when the service is not configured', () => {
    vi.stubEnv('DJ_LLM_MODEL', '');
    expect(() => dj.setSettings({ enabled: true })).toThrow(
      expect.objectContaining({ code: 'DJ_UNAVAILABLE' })
    );
  });

  it('rejects mutations with DJ_UNAVAILABLE when the service was never initialised', () => {
    dj.shutdown();
    expect(() => dj.setSettings({ enabled: true })).toThrow(
      expect.objectContaining({ code: 'DJ_UNAVAILABLE' })
    );
    expect(dj.getStateOrUnavailable()).toEqual({ available: false });
  });
});

describe('djService breaker (R9)', () => {
  it('3 consecutive failures degrade health; after 5 min one success restores ok', () => {
    vi.useFakeTimers();
    dj.recordFailure('llm');
    dj.recordFailure('llm');
    expect(dj.getState().health).toBe('ok');
    dj.recordFailure('llm');
    expect(dj.getState().health).toBe('degraded');
    expect(dj.breakerAllows()).toBe(false);

    vi.advanceTimersByTime(5 * 60 * 1000);
    expect(dj.breakerAllows()).toBe(true);
    expect(dj.breakerAllows()).toBe(false); // only one half-open attempt
    dj.recordSuccess();
    expect(dj.getState().health).toBe('ok');
  });

  it('a quota failure keeps the breaker open for 30 min', () => {
    vi.useFakeTimers();
    dj.recordFailure('quota');
    expect(dj.getState().health).toBe('degraded');
    vi.advanceTimersByTime(29 * 60 * 1000);
    expect(dj.breakerAllows()).toBe(false);
    vi.advanceTimersByTime(60 * 1000);
    expect(dj.breakerAllows()).toBe(true);
  });

  it('feeds line failures to the breaker and tells the planner it is open', async () => {
    writeLine.mockRejectedValue(Object.assign(new Error('down'), { kind: 'llm' }));
    for (let i = 0; i < 3; i++) {
      await expect(plannerDeps.writeLine({}, [])).rejects.toThrow();
    }
    expect(dj.getState().health).toBe('degraded');
    expect(plannerDeps.isBreakerOpen()).toBe(true);
    expect(db.incrementDjUsage).not.toHaveBeenCalled();
  });
});

describe('djService caps (FR-033, FR-034)', () => {
  it('counts usage only on successful TTS and flips caps.lines.reached at the limit', async () => {
    writeLine.mockRejectedValueOnce(Object.assign(new Error('tts'), { kind: 'tts' }));
    await expect(plannerDeps.writeLine({}, [])).rejects.toThrow();
    expect(dj.getState().caps.lines.used).toBe(0);

    writeLine.mockResolvedValue({ text: 'ok.' });
    await plannerDeps.writeLine({}, []);
    expect(dj.getState().caps.lines).toMatchObject({ used: 1, limit: 2, reached: false });
    expect(plannerDeps.isCapReached()).toBe(false);

    emitted = [];
    await plannerDeps.writeLine({}, []);
    expect(dj.getState().caps.lines).toMatchObject({ used: 2, reached: true });
    expect(plannerDeps.isCapReached()).toBe(true);
    expect(emitted).toHaveLength(1);
  });

  it('flips caps.lines.reached back at local midnight with exactly one dj:state', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 9, 6, 23, 59, 0));
    dj.shutdown();
    usage.set('2026-10-06', { lines: 2, themed_tracks: 0 });
    dj.init();
    const state = dj.getState();
    expect(state.caps.lines.reached).toBe(true);
    const resetsAt = new Date(state.caps.resetsAt).getTime();
    expect(resetsAt).toBe(new Date(2026, 9, 7, 0, 0, 0).getTime());

    emitted = [];
    vi.advanceTimersByTime(60 * 1000);
    expect(emitted).toHaveLength(1);
    expect(emitted[0].caps.lines.reached).toBe(false);
    expect(new Date(emitted[0].caps.resetsAt).getTime()).toBe(
      new Date(2026, 9, 8, 0, 0, 0).getTime()
    );
  });
});

describe('djService planner wiring', () => {
  it('forwards the mediator track:change and queue:update to the planner', () => {
    const t = { title: 'x' };
    musicManager.emit('track:change', t);
    musicManager.emit('queue:update', { tracks: [], currentIndex: 0 });
    expect(plannerStub.onTrackChange).toHaveBeenCalledWith(t);
    expect(plannerStub.onQueueUpdate).toHaveBeenCalledTimes(1);
  });

  it('unsubscribes on shutdown', () => {
    dj.shutdown();
    musicManager.emit('track:change', null);
    expect(plannerStub.onTrackChange).not.toHaveBeenCalled();
    expect(plannerStub.shutdown).toHaveBeenCalled();
  });
});
