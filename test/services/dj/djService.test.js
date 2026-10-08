import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// djService pulls in the mediator, the DB singleton and playback. Each is
// replaced by a small fake so settings, breaker and caps are tested alone.
const h = vi.hoisted(() => ({
  usage: new Map(),
  settings: { enabled: false, interval: 3, lookahead: 5 },
  queue: null,
  player: null,
  users: [{ id: 'A' }]
}));

vi.mock('../../../src/utils/logger.js', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() }
}));

vi.mock('../../../src/core/musicManager.js', async () => {
  const { EventEmitter } = await import('events');
  const mm = new EventEmitter();
  mm.setGetDjState = vi.fn();
  mm.getVoiceContext = vi.fn(() => ({ connectedUsers: h.users }));
  return { musicManager: mm };
});

vi.mock('../../../src/persistence/db.js', () => {
  const pad = (n) => String(n).padStart(2, '0');
  const localDay = (ms = Date.now()) => {
    const d = new Date(ms);
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  };
  return {
    db: {
      getDjSettings: vi.fn(() => ({ ...h.settings })),
      updateDjSettings: vi.fn((p) => Object.assign(h.settings, p)),
      getDjUsage: vi.fn((day) => h.usage.get(day) ?? { lines: 0, themed_tracks: 0 }),
      incrementDjUsage: vi.fn((day, field) => {
        const row = h.usage.get(day) ?? { lines: 0, themed_tracks: 0 };
        row[field]++;
        h.usage.set(day, row);
      }),
      getLocalDay: vi.fn(localDay),
      pruneDjUsage: vi.fn()
    }
  };
});

vi.mock('../../../src/services/playback.js', () => ({
  getPlayer: () => h.player,
  getQueue: () => h.queue
}));

vi.mock('../../../src/services/dj/lineWriter.js', () => ({ writeLine: vi.fn() }));

vi.mock('../../../src/config/env.js', () => ({
  getDjConfig: () => ({ caps: { lines: 2, themedTracks: 100 } })
}));

import { musicManager } from '../../../src/core/musicManager.js';
import { db } from '../../../src/persistence/db.js';
import { writeLine } from '../../../src/services/dj/lineWriter.js';
import { Queue } from '../../../src/core/queue.js';
import * as dj from '../../../src/services/dj/djService.js';

let emitted;
const onState = (s) => emitted.push(s);

function tracks(n) {
  return Array.from({ length: n }, (_, i) => ({ title: `T${i}`, url: `u${i}`, duration: 10 }));
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-10-08T12:00:00+02:00'));
  h.usage.clear();
  h.settings = { enabled: false, interval: 3, lookahead: 5 };
  h.users = [{ id: 'A' }];
  h.queue = new Queue();
  for (const t of tracks(6)) h.queue.add(t);
  // Like MusicPlayer: refuses overlays until the new resource is playing.
  h.player = {
    status: 'idle',
    isPaused: () => false,
    overlay: vi.fn(() => h.player.status === 'playing')
  };
  writeLine.mockReset();
  writeLine.mockImplementation(async (ctx) => ({
    forKey: ctx.forKey,
    text: `Into ${ctx.next.title}.`,
    pcm: Buffer.alloc(4),
    factIds: [],
    namedUserIds: [],
    preparedAt: Date.now()
  }));
  vi.mocked(db.updateDjSettings).mockClear();
  emitted = [];
  musicManager.on('dj:state', onState);
});

afterEach(() => {
  dj.shutdown();
  musicManager.off('dj:state', onState);
  vi.useRealTimers();
});

describe('djService: unconfigured', () => {
  it('rejects mutations with DJ_UNAVAILABLE and reports available: false', () => {
    expect(() => dj.setSettings({ enabled: true })).toThrow(
      expect.objectContaining({ code: 'DJ_UNAVAILABLE' })
    );
    expect(dj.getStateOrUnavailable()).toEqual({ available: false });
  });
});

describe('djService: settings', () => {
  beforeEach(() => dj.init());

  it('setSettings({ interval: 11 }) throws INVALID_INTERVAL and state is unchanged', () => {
    const before = dj.getState();
    expect(() => dj.setSettings({ interval: 11 })).toThrow(
      expect.objectContaining({ code: 'INVALID_INTERVAL' })
    );
    expect(dj.getState()).toEqual(before);
    expect(db.updateDjSettings).not.toHaveBeenCalled();
    expect(emitted).toHaveLength(0);
  });

  it('setSettings({ lookahead: 7 }) throws INVALID_LOOKAHEAD', () => {
    expect(() => dj.setSettings({ lookahead: 7 })).toThrow(
      expect.objectContaining({ code: 'INVALID_LOOKAHEAD' })
    );
    expect(emitted).toHaveLength(0);
  });

  it('a valid mutation emits exactly one dj:state', () => {
    dj.setSettings({ enabled: true, interval: 1 });
    expect(emitted).toHaveLength(1);
    expect(emitted[0]).toMatchObject({ enabled: true, interval: 1 });
  });

  it('changing interval or enabling calls resetCounter() once; lookahead-only does not (FR-006)', () => {
    const spy = vi.spyOn(dj.getPlanner(), 'resetCounter');
    dj.setSettings({ interval: 4 });
    expect(spy).toHaveBeenCalledTimes(1);
    dj.setSettings({ enabled: true });
    expect(spy).toHaveBeenCalledTimes(2);
    dj.setSettings({ lookahead: 10 });
    expect(spy).toHaveBeenCalledTimes(2);
    dj.setSettings({ enabled: true }); // already on: not a false→true change
    expect(spy).toHaveBeenCalledTimes(2);
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
    expect(dj.canAttempt()).toBe(true); // half-open trial
    expect(dj.canAttempt()).toBe(false); // only one
    dj.recordSuccess();
    expect(dj.getState().health).toBe('ok');
  });

  it('a quota failure keeps it open for 30 min', () => {
    dj.recordFailure('quota');
    expect(dj.getState().health).toBe('degraded');
    vi.advanceTimersByTime(29 * 60 * 1000);
    expect(dj.canAttempt()).toBe(false);
    vi.advanceTimersByTime(60 * 1000);
    expect(dj.canAttempt()).toBe(true);
  });

  it('planner failures feed the breaker and turn health degraded (quickstart §7)', async () => {
    writeLine.mockRejectedValue(Object.assign(new Error('down'), { kind: 'llm' }));
    dj.setSettings({ enabled: true, interval: 1 });
    for (let i = 0; i < 4; i++) {
      h.queue.currentIndex = i;
      musicManager.emit('track:change', h.queue.tracks[i]);
      await vi.advanceTimersByTimeAsync(0);
    }
    expect(dj.getState().health).toBe('degraded');
    expect(h.player.overlay).not.toHaveBeenCalled();
  });
});

describe('djService: speaking through the mediator (US1/AC1)', () => {
  beforeEach(() => dj.init());

  it('speaks the prepared line once the new track leaves buffering', async () => {
    dj.setSettings({ enabled: true, interval: 1 });
    for (let i = 0; i < 2; i++) {
      h.queue.currentIndex = i;
      // MusicPlayer.play() emits trackStart while the resource is buffering.
      h.player.status = 'buffering';
      musicManager.emit('track:change', h.queue.tracks[i]);
      await vi.advanceTimersByTimeAsync(30);
      h.player.status = 'playing';
      await vi.advanceTimersByTimeAsync(100);
    }
    const accepted = h.player.overlay.mock.results.filter((r) => r.value === true);
    expect(accepted).toHaveLength(1);
  });
});

describe('djService: caps (FR-033, FR-034)', () => {
  beforeEach(() => dj.init());

  it('usage increments only on successful TTS and lines.reached flips at the limit', async () => {
    dj.setSettings({ enabled: true, interval: 1 });
    writeLine.mockRejectedValueOnce(Object.assign(new Error('tts'), { kind: 'rate' }));

    h.queue.currentIndex = 0;
    musicManager.emit('track:change', h.queue.tracks[0]);
    await vi.advanceTimersByTimeAsync(0);
    expect(dj.getState().caps.lines.used).toBe(0);

    for (let i = 1; i <= 3; i++) {
      h.queue.currentIndex = i;
      musicManager.emit('track:change', h.queue.tracks[i]);
      await vi.advanceTimersByTimeAsync(0);
    }
    const { lines } = dj.getState().caps;
    expect(lines).toMatchObject({ used: 2, limit: 2, reached: true });
    // Cap reached: no further preparation.
    expect(writeLine).toHaveBeenCalledTimes(3);
  });

  it('crossing local midnight clears reached, moves resetsAt a day and emits one dj:state', async () => {
    const today = db.getLocalDay();
    h.usage.set(today, { lines: 2, themed_tracks: 0 });
    dj.shutdown();
    dj.init();
    const before = dj.getState().caps;
    expect(before.lines.reached).toBe(true);
    emitted = [];

    const msToMidnight = new Date(before.resetsAt).getTime() - Date.now();
    vi.advanceTimersByTime(msToMidnight + 10);

    const after = dj.getState().caps;
    expect(after.lines.reached).toBe(false);
    expect(new Date(after.resetsAt).getTime() - new Date(before.resetsAt).getTime()).toBe(
      24 * 60 * 60 * 1000
    );
    expect(emitted).toHaveLength(1);
  });
});
