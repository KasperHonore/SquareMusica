import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Foundation-phase coverage for the djService skeleton (T021–T023). The fuller
// settings/breaker/caps suite is T026's test/services/dj/djService.test.js.
vi.mock('../../../src/core/musicManager.js', async () => {
  const { EventEmitter } = await import('events');
  const mm = new EventEmitter();
  mm.setGetDjState = vi.fn((fn) => (mm.getDjState = fn));
  return { musicManager: mm };
});
vi.mock('../../../src/persistence/db.js', async () => {
  const { DatabaseManager } = await vi.importActual('../../../src/persistence/db.js');
  return { db: new DatabaseManager(':memory:') };
});
vi.mock('../../../src/utils/logger.js', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() }
}));

import { musicManager } from '../../../src/core/musicManager.js';
import { db } from '../../../src/persistence/db.js';
import { logger } from '../../../src/utils/logger.js';
import * as dj from '../../../src/services/dj/djService.js';

const ENV = {
  ELEVENLABS_API_KEY: 'k',
  ELEVENLABS_VOICE_ID: 'v',
  DJ_LLM_BASE_URL: 'http://llm/v1',
  DJ_LLM_MODEL: 'm',
  DJ_DAILY_LINE_CAP: '2'
};
const saved = {};
let states;
const onState = (s) => states.push(s);

beforeEach(() => {
  for (const [k, v] of Object.entries(ENV)) {
    saved[k] = process.env[k];
    process.env[k] = v;
  }
  db.db.exec('DELETE FROM dj_settings; DELETE FROM dj_usage;');
  states = [];
  musicManager.on('dj:state', onState);
  vi.clearAllMocks();
});

afterEach(() => {
  musicManager.off('dj:state', onState);
  dj._resetForTests();
  vi.useRealTimers();
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

describe('djService skeleton', () => {
  it('is unavailable before init()', () => {
    expect(dj.getState()).toEqual({ available: false });
    expect(dj.getStateOrUnavailable()).toEqual({ available: false });
    expect(() => dj.setSettings({ enabled: true })).toThrow(
      expect.objectContaining({ code: 'DJ_UNAVAILABLE' })
    );
  });

  it('init() registers the state getter and returns the DjState shape', () => {
    dj.init();
    expect(musicManager.setGetDjState).toHaveBeenCalledWith(dj.getState);
    const state = dj.getState();
    expect(state).toMatchObject({
      available: true,
      enabled: false,
      interval: 3,
      lookahead: 5,
      health: 'ok',
      theme: null,
      caps: {
        lines: { used: 0, limit: 2, reached: false },
        themedTracks: { used: 0, limit: 100, reached: false }
      }
    });
    expect(state.caps.resetsAt).toMatch(/^\d{4}-\d{2}-\d{2}T00:00:00[+-]\d{2}:\d{2}$/);
    expect(new Date(state.caps.resetsAt).getTime()).toBeGreaterThan(Date.now());
  });
});

describe('setSettings', () => {
  beforeEach(() => dj.init());

  it.each([0, 11, 2.5, '4'])('rejects interval %s with INVALID_INTERVAL and keeps state', (v) => {
    expect(() => dj.setSettings({ interval: v, enabled: true })).toThrow(
      expect.objectContaining({ code: 'INVALID_INTERVAL' })
    );
    expect(dj.getState()).toMatchObject({ enabled: false, interval: 3 });
    expect(states).toHaveLength(0);
  });

  it('rejects lookahead 7 with INVALID_LOOKAHEAD', () => {
    expect(() => dj.setSettings({ lookahead: 7 })).toThrow(
      expect.objectContaining({ code: 'INVALID_LOOKAHEAD' })
    );
  });

  it('persists a valid change and broadcasts exactly once', () => {
    dj.setSettings({ enabled: true, interval: 4 });
    expect(states).toHaveLength(1);
    expect(states[0]).toMatchObject({ enabled: true, interval: 4 });
    expect(db.getDjSettings()).toEqual({ enabled: true, interval: 4, lookahead: 5 });
  });
});

describe('breaker', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    dj.init();
  });

  it('opens after 3 consecutive failures, half-opens after 5 min, closes on success', () => {
    dj.recordFailure('llm', new Error('boom'));
    dj.recordFailure('tts');
    expect(dj.getState().health).toBe('ok');
    dj.recordFailure('llm');
    expect(dj.getState().health).toBe('degraded');
    expect(states).toHaveLength(1);
    expect(logger.warn).toHaveBeenCalledTimes(3);
    expect(dj.canAttempt()).toBe(false);

    vi.advanceTimersByTime(5 * 60 * 1000);
    expect(dj.canAttempt()).toBe(true);
    expect(dj.canAttempt()).toBe(false); // one half-open attempt only
    dj.recordSuccess();
    expect(dj.getState().health).toBe('ok');
    expect(dj.canAttempt()).toBe(true);
  });

  it('a failed half-open attempt re-opens for 5 min', () => {
    for (let i = 0; i < 3; i++) dj.recordFailure('llm');
    vi.advanceTimersByTime(5 * 60 * 1000);
    expect(dj.canAttempt()).toBe(true);
    dj.recordFailure('llm');
    expect(dj.canAttempt()).toBe(false);
    vi.advanceTimersByTime(5 * 60 * 1000);
    expect(dj.canAttempt()).toBe(true);
  });

  it('a quota failure opens for 30 min', () => {
    dj.recordFailure('quota');
    expect(dj.getState().health).toBe('degraded');
    vi.advanceTimersByTime(29 * 60 * 1000);
    expect(dj.canAttempt()).toBe(false);
    vi.advanceTimersByTime(60 * 1000);
    expect(dj.canAttempt()).toBe(true);
  });
});

describe('caps', () => {
  it('flips reached at the limit and broadcasts once on the flip', () => {
    dj.init();
    dj.recordUsage('lines');
    expect(states).toHaveLength(0);
    dj.recordUsage('lines');
    expect(dj.getState().caps.lines).toEqual({ used: 2, limit: 2, reached: true });
    expect(dj.isLineCapReached()).toBe(true);
    expect(states).toHaveLength(1);
  });

  it('resets at local midnight, moves resetsAt forward a day, broadcasts once', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-06T23:59:00+02:00'));
    dj.init();
    dj.recordUsage('lines');
    dj.recordUsage('lines');
    expect(dj.getState().caps.resetsAt).toBe('2026-10-07T00:00:00+02:00');
    states.length = 0;

    vi.advanceTimersByTime(60 * 1000);
    const state = dj.getState();
    expect(state.caps.lines).toEqual({ used: 0, limit: 2, reached: false });
    expect(state.caps.resetsAt).toBe('2026-10-08T00:00:00+02:00');
    expect(states).toHaveLength(1);
  });
});
