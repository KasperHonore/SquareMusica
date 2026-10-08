import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../../src/utils/logger.js', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() }
}));

// In-memory stand-ins for the dj_settings and dj_usage tables.
const store = vi.hoisted(() => ({ settings: null, usage: new Map() }));
vi.mock('../../../src/persistence/db.js', () => ({
  db: {
    getDjSettings: vi.fn(() => {
      store.settings ??= { enabled: false, interval: 3, lookahead: 5 };
      return { ...store.settings };
    }),
    updateDjSettings: vi.fn((partial) => {
      store.settings = { ...store.settings, ...partial };
    }),
    getDjUsage: vi.fn((day) => ({ lines: 0, themed_tracks: 0, ...store.usage.get(day) })),
    incrementDjUsage: vi.fn((day, field) => {
      const row = { lines: 0, themed_tracks: 0, ...store.usage.get(day) };
      row[field]++;
      store.usage.set(day, row);
    })
  }
}));

vi.mock('../../../src/core/musicManager.js', async () => {
  const { EventEmitter } = await import('events');
  const musicManager = Object.assign(new EventEmitter(), {
    getDjState: null,
    setGetDjState(fn) {
      this.getDjState = fn;
    },
    getVoiceContext: vi.fn(() => ({ connectedUsers: [{ id: 'u1' }] }))
  });
  return { musicManager };
});

vi.mock('../../../src/services/playback.js', () => ({
  getPlayer: vi.fn(() => ({ overlay: vi.fn(() => true), isPaused: () => false })),
  getQueue: vi.fn(() => ({ peekNext: () => null }))
}));

vi.mock('../../../src/services/dj/lineWriter.js', () => ({
  writeLine: vi.fn(),
  REPEAT_WINDOW: 20
}));

const plannerMock = vi.hoisted(() => ({
  resetCounter: null,
  onTrackChange: null,
  onQueueUpdate: null,
  deps: null
}));
vi.mock('../../../src/services/dj/linePlanner.js', () => ({
  createLinePlanner: vi.fn((deps) => {
    plannerMock.deps = deps;
    plannerMock.resetCounter = vi.fn();
    plannerMock.onTrackChange = vi.fn();
    plannerMock.onQueueUpdate = vi.fn();
    return {
      resetCounter: plannerMock.resetCounter,
      onTrackChange: plannerMock.onTrackChange,
      onQueueUpdate: plannerMock.onQueueUpdate,
      shutdown: vi.fn()
    };
  })
}));

import * as djService from '../../../src/services/dj/djService.js';
import { musicManager } from '../../../src/core/musicManager.js';
import { db } from '../../../src/persistence/db.js';
import { writeLine } from '../../../src/services/dj/lineWriter.js';
import {
  DJ_UNAVAILABLE,
  INVALID_INTERVAL,
  INVALID_LOOKAHEAD
} from '../../../src/services/dj/errors.js';

const ENV = {
  ELEVENLABS_API_KEY: 'el-key',
  ELEVENLABS_VOICE_ID: 'voice-1',
  DJ_LLM_BASE_URL: 'http://llm.local/v1',
  DJ_LLM_MODEL: 'model-x',
  DJ_DAILY_LINE_CAP: '2'
};

let emitted;
function onState(state) {
  emitted.push(state);
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(2026, 9, 8, 12, 0, 0));
  Object.assign(process.env, ENV);
  store.settings = null;
  store.usage = new Map();
  vi.clearAllMocks();
  emitted = [];
  musicManager.on('dj:state', onState);
  djService.init();
});

afterEach(() => {
  djService.shutdown();
  musicManager.off('dj:state', onState);
  for (const key of Object.keys(ENV)) delete process.env[key];
  vi.useRealTimers();
});

describe('setSettings validation', () => {
  it('rejects interval 11 with INVALID_INTERVAL and leaves state unchanged', () => {
    const before = djService.getState();
    expect(() => djService.setSettings({ interval: 11 }, null)).toThrow(
      expect.objectContaining({ code: INVALID_INTERVAL })
    );
    expect(djService.getState()).toEqual(before);
    expect(db.updateDjSettings).not.toHaveBeenCalled();
    expect(emitted).toHaveLength(0);
  });

  it('rejects lookahead 7 with INVALID_LOOKAHEAD', () => {
    expect(() => djService.setSettings({ lookahead: 7 }, null)).toThrow(
      expect.objectContaining({ code: INVALID_LOOKAHEAD })
    );
  });

  it('a valid mutation emits exactly one dj:state', () => {
    djService.setSettings({ enabled: true, interval: 2 }, { id: 'u1', name: 'Kasper' });
    expect(emitted).toHaveLength(1);
    expect(emitted[0]).toMatchObject({ enabled: true, interval: 2 });
    expect(store.settings).toMatchObject({ enabled: true, interval: 2 });
  });

  it('rejects mutations with DJ_UNAVAILABLE when the service is not configured', () => {
    djService.shutdown();
    expect(() => djService.setSettings({ enabled: true }, null)).toThrow(
      expect.objectContaining({ code: DJ_UNAVAILABLE })
    );
    expect(djService.getState()).toEqual({ available: false });
  });
});

describe('interval count restarts (FR-006)', () => {
  it('changing interval calls resetCounter once', () => {
    djService.setSettings({ interval: 5 }, null);
    expect(plannerMock.resetCounter).toHaveBeenCalledTimes(1);
  });

  it('enabled false → true calls resetCounter once', () => {
    djService.setSettings({ enabled: true }, null);
    expect(plannerMock.resetCounter).toHaveBeenCalledTimes(1);
  });

  it('a lookahead-only change does not reset', () => {
    djService.setSettings({ lookahead: 10 }, null);
    expect(plannerMock.resetCounter).not.toHaveBeenCalled();
  });

  it('turning the DJ off, or re-sending the same interval, does not reset', () => {
    djService.setSettings({ enabled: true }, null);
    plannerMock.resetCounter.mockClear();
    djService.setSettings({ enabled: false, interval: 3 }, null);
    expect(plannerMock.resetCounter).not.toHaveBeenCalled();
  });
});

describe('planner wiring', () => {
  it('forwards mediator track:change and queue:update to the planner', () => {
    const track = { title: 'x' };
    musicManager.emit('track:change', track);
    musicManager.emit('queue:update', { tracks: [] });
    expect(plannerMock.onTrackChange).toHaveBeenCalledWith(track);
    expect(plannerMock.onQueueUpdate).toHaveBeenCalledTimes(1);
  });

  it('stops forwarding after shutdown', () => {
    const { onTrackChange } = plannerMock;
    djService.shutdown();
    musicManager.emit('track:change', { title: 'x' });
    expect(onTrackChange).not.toHaveBeenCalled();
  });
});

describe('breaker (R9)', () => {
  const failingLine = () => plannerMock.deps.produceLine({}, []).catch(() => {});

  it('3 consecutive failures degrade health; after 5 min one success restores ok', async () => {
    writeLine.mockRejectedValue(Object.assign(new Error('down'), { kind: 'llm' }));
    await failingLine();
    await failingLine();
    expect(djService.getState().health).toBe('ok');
    await failingLine();
    expect(djService.getState().health).toBe('degraded');
    expect(emitted.at(-1).health).toBe('degraded');
    expect(plannerMock.deps.canAttempt()).toBe(false);

    vi.advanceTimersByTime(5 * 60 * 1000);
    expect(plannerMock.deps.canAttempt()).toBe(true); // half-open
    writeLine.mockResolvedValueOnce({ text: 'ok', pcm: Buffer.alloc(4) });
    await plannerMock.deps.produceLine({}, []);
    expect(djService.getState().health).toBe('ok');
    expect(emitted.at(-1).health).toBe('ok');
  });

  it('a quota failure keeps the breaker open for 30 min', async () => {
    writeLine.mockRejectedValue(Object.assign(new Error('quota'), { kind: 'quota' }));
    await failingLine();
    expect(djService.getState().health).toBe('degraded');
    vi.advanceTimersByTime(29 * 60 * 1000);
    expect(plannerMock.deps.canAttempt()).toBe(false);
    expect(plannerMock.deps.isBreakerOpen()).toBe(true);
    vi.advanceTimersByTime(60 * 1000);
    expect(plannerMock.deps.canAttempt()).toBe(true);
  });
});

describe('caps', () => {
  it('usage increments only on successful TTS and caps.lines.reached flips at the limit', async () => {
    writeLine.mockRejectedValueOnce(Object.assign(new Error('tts'), { kind: 'rate' }));
    await plannerMock.deps.produceLine({}, []).catch(() => {});
    expect(db.incrementDjUsage).not.toHaveBeenCalled();

    writeLine.mockResolvedValue({ text: 'ok', pcm: Buffer.alloc(4) });
    await plannerMock.deps.produceLine({}, []);
    expect(djService.getState().caps.lines).toMatchObject({ used: 1, limit: 2, reached: false });
    expect(plannerMock.deps.isCapReached()).toBe(false);

    emitted = [];
    await plannerMock.deps.produceLine({}, []);
    expect(djService.getState().caps.lines).toMatchObject({ used: 2, reached: true });
    expect(plannerMock.deps.isCapReached()).toBe(true);
    expect(emitted).toHaveLength(1);
    expect(db.incrementDjUsage).toHaveBeenCalledWith('2026-10-08', 'lines');
  });

  it('crossing local midnight clears reached, moves resetsAt a day, and emits once', async () => {
    writeLine.mockResolvedValue({ text: 'ok', pcm: Buffer.alloc(4) });
    await plannerMock.deps.produceLine({}, []);
    await plannerMock.deps.produceLine({}, []);
    const before = djService.getState().caps;
    expect(before.lines.reached).toBe(true);
    expect(before.resetsAt).toBe('2026-10-09T00:00:00+02:00');

    emitted = [];
    vi.advanceTimersByTime(12 * 60 * 60 * 1000);
    const after = djService.getState().caps;
    expect(after.lines).toMatchObject({ used: 0, reached: false });
    expect(after.resetsAt).toBe('2026-10-10T00:00:00+02:00');
    expect(emitted).toHaveLength(1);
  });
});
