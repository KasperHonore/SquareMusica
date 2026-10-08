import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Settings/breaker/caps part (T026), plus the US1 planner wiring (T030).
vi.mock('../../../src/core/musicManager.js', async () => {
  const { EventEmitter } = await import('events');
  const mm = new EventEmitter();
  mm.setGetDjState = vi.fn((fn) => (mm.getDjState = fn));
  mm.getVoiceContext = vi.fn(() => ({ connectedUsers: [{ id: 'A' }] }));
  return { musicManager: mm };
});
vi.mock('../../../src/persistence/db.js', async () => {
  const { DatabaseManager } = await vi.importActual('../../../src/persistence/db.js');
  return { db: new DatabaseManager(':memory:') };
});
vi.mock('../../../src/services/playback.js', () => ({
  getPlayer: vi.fn(),
  getQueue: vi.fn()
}));
vi.mock('../../../src/services/dj/lineWriter.js', () => ({ writeLine: vi.fn() }));
vi.mock('../../../src/utils/logger.js', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() }
}));

import { musicManager } from '../../../src/core/musicManager.js';
import { db } from '../../../src/persistence/db.js';
import { getPlayer, getQueue } from '../../../src/services/playback.js';
import { writeLine } from '../../../src/services/dj/lineWriter.js';
import { Queue } from '../../../src/core/queue.js';
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

describe('setSettings', () => {
  it('unconfigured service rejects mutations with DJ_UNAVAILABLE', () => {
    expect(() => dj.setSettings({ enabled: true })).toThrow(
      expect.objectContaining({ code: 'DJ_UNAVAILABLE' })
    );
  });

  it('interval 11 throws INVALID_INTERVAL and state is unchanged', () => {
    dj.init();
    const before = dj.getState();
    expect(() => dj.setSettings({ interval: 11 })).toThrow(
      expect.objectContaining({ code: 'INVALID_INTERVAL' })
    );
    expect(dj.getState()).toEqual(before);
    expect(db.getDjSettings().interval).toBe(3);
    expect(states).toHaveLength(0);
  });

  it('lookahead 7 throws INVALID_LOOKAHEAD', () => {
    dj.init();
    expect(() => dj.setSettings({ lookahead: 7 })).toThrow(
      expect.objectContaining({ code: 'INVALID_LOOKAHEAD' })
    );
    expect(states).toHaveLength(0);
  });

  it('a valid mutation emits exactly one dj:state', () => {
    dj.init();
    dj.setSettings({ enabled: true, interval: 2, lookahead: 10 });
    expect(states).toHaveLength(1);
    expect(states[0]).toMatchObject({ enabled: true, interval: 2, lookahead: 10 });
  });

  it('resets the planner counter on an interval change or enabling, not on lookahead', () => {
    dj.init();
    const spy = vi.spyOn(dj._getPlannerForTests(), 'resetCounter');

    dj.setSettings({ interval: 4 });
    expect(spy).toHaveBeenCalledTimes(1);

    dj.setSettings({ enabled: true });
    expect(spy).toHaveBeenCalledTimes(2);

    dj.setSettings({ lookahead: 10 });
    dj.setSettings({ enabled: true }); // already on: no reset
    dj.setSettings({ interval: 4 }); // unchanged: no reset
    expect(spy).toHaveBeenCalledTimes(2);
  });
});

describe('breaker', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    dj.init();
  });

  it('3 consecutive failures set degraded; after 5 min one success restores ok', () => {
    for (let i = 0; i < 3; i++) dj.recordFailure('llm');
    expect(dj.getState().health).toBe('degraded');
    expect(dj.canAttempt()).toBe(false);
    vi.advanceTimersByTime(5 * 60 * 1000);
    expect(dj.canAttempt()).toBe(true);
    dj.recordSuccess();
    expect(dj.getState().health).toBe('ok');
  });

  it('a quota failure keeps it open 30 min', () => {
    dj.recordFailure('quota');
    expect(dj.getState().health).toBe('degraded');
    vi.advanceTimersByTime(30 * 60 * 1000 - 1);
    expect(dj.canAttempt()).toBe(false);
    vi.advanceTimersByTime(1);
    expect(dj.canAttempt()).toBe(true);
  });
});

describe('caps and the planner wiring', () => {
  const PCM = Buffer.alloc(16);
  const track = (id) => ({ title: id, url: `https://y/${id}`, duration: 10 });
  let queue;
  let player;

  beforeEach(() => {
    vi.useFakeTimers();
    queue = new Queue();
    player = { overlay: vi.fn(() => true), isPaused: () => false };
    getQueue.mockReturnValue(queue);
    getPlayer.mockReturnValue(player);
    dj.init();
    dj.setSettings({ enabled: true, interval: 1 });
    states.length = 0;
  });

  function startQueue(ids) {
    for (const id of ids) queue.add(track(id));
    musicManager.emit('track:change', queue.getCurrent());
  }

  it('usage increments only on successful TTS and caps.lines.reached flips at the limit', async () => {
    writeLine.mockRejectedValueOnce(Object.assign(new Error('tts down'), { kind: 'tts' }));
    startQueue(['a', 'b', 'c', 'd']);
    await vi.advanceTimersByTimeAsync(0);
    expect(dj.getState().caps.lines.used).toBe(0);
    expect(dj.getState().health).toBe('ok');

    writeLine.mockImplementation(async (ctx) => ({
      forKey: ctx.forKey,
      text: `Next: ${ctx.next.title}.`,
      pcm: PCM,
      factIds: [],
      namedUserIds: []
    }));
    musicManager.emit('track:change', queue.next()); // b: nothing prepared, re-prepares for c
    await vi.advanceTimersByTimeAsync(0);
    expect(dj.getState().caps.lines).toMatchObject({ used: 1, reached: false });

    musicManager.emit('track:change', queue.next()); // c: spoken, prepares for d
    await vi.advanceTimersByTimeAsync(0);
    expect(player.overlay).toHaveBeenCalledOnce();
    expect(dj.getState().caps.lines).toMatchObject({ used: 2, limit: 2, reached: true });
    expect(states.filter((s) => s.caps.lines.reached)).toHaveLength(1);

    // At the cap no further line is prepared.
    musicManager.emit('track:change', queue.next());
    await vi.advanceTimersByTimeAsync(0);
    expect(writeLine).toHaveBeenCalledTimes(3);
  });

  it('a failed line is recorded against the breaker', async () => {
    writeLine.mockRejectedValue(Object.assign(new Error('llm down'), { kind: 'llm' }));
    startQueue(['a', 'b', 'c', 'd', 'e']);
    for (let i = 0; i < 3; i++) {
      await vi.advanceTimersByTimeAsync(0);
      musicManager.emit('track:change', queue.next());
    }
    await vi.advanceTimersByTimeAsync(0);
    expect(dj.getState().health).toBe('degraded');
  });

  it('crossing local midnight clears reached, moves resetsAt a day, emits one dj:state', async () => {
    dj._resetForTests();
    vi.setSystemTime(new Date('2026-10-06T23:59:00+02:00'));
    dj.init();
    dj.recordUsage('lines');
    dj.recordUsage('lines');
    expect(dj.getState().caps.lines.reached).toBe(true);
    expect(dj.getState().caps.resetsAt).toBe('2026-10-07T00:00:00+02:00');
    states.length = 0;

    vi.advanceTimersByTime(60 * 1000);
    expect(dj.getState().caps.lines.reached).toBe(false);
    expect(dj.getState().caps.resetsAt).toBe('2026-10-08T00:00:00+02:00');
    expect(states).toHaveLength(1);
  });
});
