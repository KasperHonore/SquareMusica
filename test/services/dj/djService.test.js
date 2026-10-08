import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// djService pulls in the mediator, the DB singleton and playback. Each is
// replaced by a small fake so settings, breaker and caps are tested alone.
const h = vi.hoisted(() => ({
  usage: new Map(),
  settings: { enabled: false, interval: 3, lookahead: 5 },
  queue: null,
  player: null,
  users: [{ id: 'A' }],
  connected: true
}));

vi.mock('../../../src/utils/logger.js', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() }
}));

vi.mock('../../../src/core/musicManager.js', async () => {
  const { EventEmitter } = await import('events');
  const mm = new EventEmitter();
  mm.setGetDjState = vi.fn();
  mm.onQueueCleared = null;
  mm.setOnQueueCleared = vi.fn((fn) => {
    mm.onQueueCleared = fn;
  });
  mm.getVoiceContext = vi.fn(() => ({ connectedUsers: h.users }));
  mm.getPlayerState = vi.fn(() => ({ connected: h.connected }));
  mm.ensurePlaying = vi.fn(async () => true);
  mm.addToQueue = vi.fn((track) => {
    h.queue.add(track);
    mm.emit('queue:update', { tracks: h.queue.getAll(), currentIndex: h.queue.currentIndex });
    return true;
  });
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
      pruneDjUsage: vi.fn(),
      getTopTracks: vi.fn(() => []),
      getShoutoutOptOuts: vi.fn(() => new Set())
    }
  };
});

vi.mock('../../../src/services/playback.js', () => ({
  getPlayer: () => h.player,
  getQueue: () => h.queue
}));

vi.mock('../../../src/services/dj/lineWriter.js', () => ({ writeLine: vi.fn() }));
vi.mock('../../../src/integrations/llm.js', () => ({ chatJson: vi.fn() }));
vi.mock('../../../src/services/resolver.js', () => ({ resolveSpotifyTrack: vi.fn() }));

vi.mock('../../../src/config/env.js', () => ({
  getDjConfig: () => ({ caps: { lines: 2, themedTracks: h.themedCap ?? 100 } })
}));

import { musicManager } from '../../../src/core/musicManager.js';
import { db } from '../../../src/persistence/db.js';
import { writeLine } from '../../../src/services/dj/lineWriter.js';
import { chatJson } from '../../../src/integrations/llm.js';
import { resolveSpotifyTrack } from '../../../src/services/resolver.js';
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
  h.connected = true;
  h.themedCap = 100;
  h.queue = new Queue();
  for (const t of tracks(6)) h.queue.add(t);
  // Like MusicPlayer: refuses overlays until the new resource is playing.
  h.player = {
    status: 'idle',
    isPaused: () => false,
    isPlaying: () => h.player.status === 'playing',
    isBuffering: () => h.player.status === 'buffering',
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
  vi.mocked(musicManager.ensurePlaying).mockClear();
  let n = 0;
  chatJson.mockReset();
  chatJson.mockImplementation(async ({ user }) => ({
    picks: Array.from({ length: user.count }, () => ({ artist: `A${++n}`, title: `S${n}` }))
  }));
  resolveSpotifyTrack.mockReset();
  resolveSpotifyTrack.mockImplementation(async ({ title, artists }) => ({
    url: `https://yt/${artists[0]}-${title}`,
    title,
    duration: 120
  }));
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

describe('djService: themed mode (US4, contracts §3)', () => {
  beforeEach(() => {
    h.queue = new Queue();
    dj.init();
  });

  const actor = { id: 'A', name: 'Alice' };
  const origin = { transport: 'http' };

  it.each([
    ['empty', '   '],
    ['too long', 'x'.repeat(201)],
    ['not a string', 42],
    ['failing the content filter', 'songs for a retard']
  ])('startTheme rejects a theme that is %s with INVALID_THEME', async (_label, theme) => {
    await expect(dj.startTheme({ theme }, actor, origin)).rejects.toMatchObject({
      code: 'INVALID_THEME'
    });
    expect(dj.getState().theme).toBeNull();
    expect(emitted).toHaveLength(0);
  });

  it('accepts a 200-character theme after trimming', async () => {
    const state = await dj.startTheme({ theme: `  ${'x'.repeat(200)}  ` }, actor, origin);
    expect(state.theme.theme).toHaveLength(200);
  });

  it('rejects a bad lookahead with INVALID_LOOKAHEAD', async () => {
    await expect(
      dj.startTheme({ theme: 'rock', lookahead: 7 }, actor, origin)
    ).rejects.toMatchObject({ code: 'INVALID_LOOKAHEAD' });
  });

  it('bot not connected → NOT_IN_VOICE', async () => {
    h.connected = false;
    await expect(dj.startTheme({ theme: 'rock' }, actor, origin)).rejects.toMatchObject({
      code: 'NOT_IN_VOICE'
    });
  });

  it('breaker open → SERVICE_UNAVAILABLE', async () => {
    for (let i = 0; i < 3; i++) dj.recordFailure('llm');
    emitted = [];
    await expect(dj.startTheme({ theme: 'rock' }, actor, origin)).rejects.toMatchObject({
      code: 'SERVICE_UNAVAILABLE'
    });
    expect(chatJson).not.toHaveBeenCalled();
  });

  it('themed cap reached → CAP_REACHED', async () => {
    h.themedCap = 0;
    dj.shutdown();
    dj.init();
    await expect(dj.startTheme({ theme: 'rock' }, actor, origin)).rejects.toMatchObject({
      code: 'CAP_REACHED'
    });
  });

  it('no playable tracks → NO_TRACKS_FOR_THEME, no session, flag cleared (US4/AC5)', async () => {
    resolveSpotifyTrack.mockResolvedValue(null);
    await expect(dj.startTheme({ theme: 'zzzzqqqq' }, actor, origin)).rejects.toMatchObject({
      code: 'NO_TRACKS_FOR_THEME'
    });
    expect(dj.getState().theme).toBeNull();
    expect(h.queue.prioritizeMemberTracks).toBe(false);
    expect(emitted.filter((s) => s.theme)).toHaveLength(0);
  });

  it('starts: sets prioritizeMemberTracks, starts playback, broadcasts ThemeState (US4/AC1)', async () => {
    const state = await dj.startTheme({ theme: 'classic rock', lookahead: 10 }, actor, origin);
    expect(h.queue.prioritizeMemberTracks).toBe(true);
    expect(musicManager.ensurePlaying).toHaveBeenCalled();
    expect(state.theme).toMatchObject({
      theme: 'classic rock',
      startedBy: actor,
      status: 'running',
      reason: null
    });
    expect(state.lookahead).toBe(10);
    expect(db.updateDjSettings).toHaveBeenCalledWith({ lookahead: 10 });
    expect(emitted.filter((s) => s.theme?.theme === 'classic rock').length).toBeGreaterThan(0);

    await vi.advanceTimersByTimeAsync(1500);
    expect(h.queue.countUpcoming((t) => t.addedByDj)).toBeGreaterThanOrEqual(9);
  });

  it('picks landing while the first track buffers do not restart playback', async () => {
    // Like MusicPlayer: after play() hands over the resource it sits in Buffering.
    musicManager.ensurePlaying.mockImplementation(async () => {
      h.player.status = 'buffering';
      return true;
    });
    await dj.startTheme({ theme: 'classic rock', lookahead: 10 }, actor, origin);
    await vi.advanceTimersByTimeAsync(1500);
    expect(h.queue.countUpcoming((t) => t.addedByDj)).toBeGreaterThanOrEqual(9);
    expect(musicManager.ensurePlaying).toHaveBeenCalledTimes(1);
    musicManager.ensurePlaying.mockImplementation(async () => true);
  });

  it('startTheme while running changes the theme, keeps usedKeys and sets introPending (US4/AC7)', async () => {
    dj.setSettings({ enabled: true });
    await dj.startTheme({ theme: 'old' }, actor, origin);
    await vi.advanceTimersByTimeAsync(1500);
    const before = dj.getState().theme;
    emitted = [];

    const state = await dj.startTheme({ theme: 'new' }, { id: 'B', name: 'Bob' }, origin);
    expect(state.theme.theme).toBe('new');
    expect(state.theme.startedAt).toBe(before.startedAt);
    expect(emitted).toHaveLength(1);
    // introPending set: the planner starts writing the new theme's intro at once.
    await vi.advanceTimersByTimeAsync(0);
    expect(writeLine).toHaveBeenLastCalledWith(
      expect.objectContaining({ intro: true, theme: 'new' }),
      expect.any(Array)
    );
    expect(dj.getThemeOrigin()).toEqual(origin);
  });

  it('a lookahead given with a failed start is not persisted', async () => {
    resolveSpotifyTrack.mockResolvedValue(null);
    await expect(
      dj.startTheme({ theme: 'nothing', lookahead: 10 }, actor, origin)
    ).rejects.toBeTruthy();
    expect(db.updateDjSettings).not.toHaveBeenCalled();
    expect(dj.getState().lookahead).toBe(5);
  });

  it('stopTheme clears the flag, keeps queued picks and broadcasts once (US4/AC4)', async () => {
    await dj.startTheme({ theme: 'rock' }, actor, origin);
    await vi.advanceTimersByTimeAsync(1500);
    const queued = h.queue.length;
    emitted = [];

    const state = dj.stopTheme(actor);
    expect(state.theme).toBeNull();
    expect(h.queue.prioritizeMemberTracks).toBe(false);
    expect(h.queue.length).toBe(queued);
    expect(emitted).toHaveLength(1);
    expect(emitted[0].theme).toBeNull();

    await vi.advanceTimersByTimeAsync(5000);
    expect(h.queue.length).toBe(queued);
  });

  it('works with commentary disabled: builds the queue silently (FR-028)', async () => {
    expect(dj.getState().enabled).toBe(false);
    await dj.startTheme({ theme: 'rock' }, actor, origin);
    await vi.advanceTimersByTimeAsync(1500);
    expect(h.queue.countUpcoming((t) => t.addedByDj)).toBe(5);
    expect(writeLine).not.toHaveBeenCalled();
  });

  it('the queue-cleared hook stops a running theme with one dj:state (FR-024b)', async () => {
    expect(musicManager.setOnQueueCleared).toHaveBeenCalledWith(expect.any(Function));
    await dj.startTheme({ theme: 'rock' }, actor, origin);
    emitted = [];

    musicManager.onQueueCleared();
    expect(h.queue.prioritizeMemberTracks).toBe(false);
    expect(emitted).toHaveLength(1);
    expect(emitted[0].theme).toBeNull();
    expect(dj.getState().theme).toBeNull();
  });

  it('a clear before the first pick lands resolves startTheme with theme null', async () => {
    const resolvers = [];
    resolveSpotifyTrack.mockImplementation(
      ({ title }) =>
        new Promise((r) => resolvers.push(() => r({ url: `https://yt/${title}`, title })))
    );
    const p = dj.startTheme({ theme: 'rock' }, actor, origin);
    await vi.advanceTimersByTimeAsync(0);

    musicManager.onQueueCleared();
    resolvers.forEach((r) => r());
    const state = await p;
    expect(state.theme).toBeNull();
    expect(h.queue.prioritizeMemberTracks).toBe(false);
    expect(h.queue.countUpcoming((t) => t.addedByDj)).toBe(0);
  });

  it('the queue-cleared hook is a no-op with no broadcast when no theme runs', () => {
    musicManager.onQueueCleared();
    expect(emitted).toHaveLength(0);
  });

  it('after a clear, the emptied queue:update triggers no top-up', async () => {
    await dj.startTheme({ theme: 'rock' }, actor, origin);
    await vi.advanceTimersByTimeAsync(1500);
    chatJson.mockClear();

    musicManager.onQueueCleared();
    h.queue.clear();
    musicManager.emit('queue:update', { tracks: [], currentIndex: 0 });
    await vi.advanceTimersByTimeAsync(70_000);
    expect(chatJson).not.toHaveBeenCalled();
    expect(h.queue.length).toBe(0);
  });

  it('bot leaving voice marks the theme stalled NOT_IN_VOICE', async () => {
    await dj.startTheme({ theme: 'rock' }, actor, origin);
    emitted = [];
    h.connected = false;
    musicManager.emit('voice:context', null);
    expect(dj.getState().theme).toMatchObject({ status: 'stalled', reason: 'NOT_IN_VOICE' });
    expect(emitted).toHaveLength(1);
  });

  it('stopTheme and startTheme throw DJ_UNAVAILABLE when unconfigured', async () => {
    dj.shutdown();
    expect(() => dj.stopTheme(actor)).toThrow(expect.objectContaining({ code: 'DJ_UNAVAILABLE' }));
    await expect(dj.startTheme({ theme: 'x' }, actor, origin)).rejects.toMatchObject({
      code: 'DJ_UNAVAILABLE'
    });
  });
});

describe('djService: lookahead change during themed mode (FR-022, FR-023)', () => {
  beforeEach(() => {
    h.queue = new Queue();
    dj.init();
  });

  it('raising the lookahead to 10 tops up to 10 upcoming picks', async () => {
    await dj.startTheme({ theme: 'rock' }, { id: 'A', name: 'Alice' }, { transport: 'http' });
    await vi.advanceTimersByTimeAsync(1500);
    expect(h.queue.countUpcoming((t) => t.addedByDj)).toBe(5);

    dj.setSettings({ lookahead: 10 });
    await vi.advanceTimersByTimeAsync(1500);
    expect(h.queue.countUpcoming((t) => t.addedByDj)).toBe(10);
  });
});
