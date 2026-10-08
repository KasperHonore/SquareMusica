import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../../src/utils/logger.js', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() }
}));
vi.mock('../../../src/integrations/llm.js', () => ({ chatJson: vi.fn() }));
vi.mock('../../../src/services/resolver.js', () => ({ resolveSpotifyTrack: vi.fn() }));

import { createThemeEngine, PICKS_SYSTEM_PROMPT } from '../../../src/services/dj/themeEngine.js';
import { Queue } from '../../../src/core/queue.js';
import { chatJson } from '../../../src/integrations/llm.js';
import { resolveSpotifyTrack } from '../../../src/services/resolver.js';

const newPick = (i, prefix = 'new') => ({ artist: `Artist ${prefix}${i}`, title: `${prefix}${i}` });
const newPicks = (n, prefix = 'new') => ({
  picks: Array.from({ length: n }, (_, i) => newPick(i, prefix))
});

// Resolves "Artist X - title" to https://yt/<title>.
function resolveByTitle() {
  resolveSpotifyTrack.mockImplementation(async ({ title }) => ({
    url: `https://yt/${title}`,
    title,
    duration: 200,
    thumbnail: null,
    channel: 'c'
  }));
}

function setup({ lookahead = 5, topTracks = () => [], present = ['A'] } = {}) {
  const queue = new Queue();
  const state = {
    connected: true,
    listeners: true,
    capReached: false,
    canAttempt: true,
    lookahead,
    usage: 0,
    statusChanges: []
  };
  const deps = {
    getQueue: () => queue,
    addToQueue: vi.fn((track) => queue.add(track)),
    getLookahead: () => state.lookahead,
    chatJson,
    resolveTrack: resolveSpotifyTrack,
    getTopTracks: vi.fn(topTracks),
    getPresentMemberIds: () => present,
    isConnected: () => state.connected,
    hasListeners: () => state.listeners,
    isCapReached: () => state.capReached,
    canAttempt: () => state.canAttempt,
    recordSuccess: vi.fn(),
    recordFailure: vi.fn(),
    recordUsage: vi.fn(() => {
      state.usage++;
    }),
    onStatusChange: vi.fn((s) => state.statusChanges.push([s.status, s.reason]))
  };
  const engine = createThemeEngine(deps);

  // Finish every pending top-up and debounce.
  async function settle() {
    for (let i = 0; i < 5; i++) {
      await vi.advanceTimersByTimeAsync(1000);
      await engine.getInFlight();
    }
  }
  const djUpcoming = () => queue.countUpcoming((t) => t.addedByDj === true);
  return { queue, state, deps, engine, settle, djUpcoming };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  resolveByTitle();
  chatJson.mockResolvedValue(newPicks(9));
});
afterEach(() => {
  vi.useRealTimers();
});

describe('themeEngine: start and top-up (FR-021a, FR-022)', () => {
  it('on an empty queue tops up to the lookahead counting only addedByDj upcoming entries', async () => {
    const { engine, settle, djUpcoming, queue } = setup();
    await engine.start({ theme: 'rock' });
    await settle();
    // Index 0 is what plays first; 5 DJ picks are upcoming behind it.
    expect(djUpcoming()).toBe(5);
    expect(queue.tracks.every((t) => t.addedByDj)).toBe(true);
  });

  it('keeps existing member tracks ahead and does not count them (FR-021a, US4/AC6)', async () => {
    const { engine, settle, queue, djUpcoming } = setup();
    for (const id of ['m0', 'm1', 'm2', 'm3']) queue.add({ title: id, url: `https://yt/${id}` });
    await engine.start({ theme: 'rock' });
    await settle();
    expect(queue.tracks.slice(0, 4).map((t) => t.title)).toEqual(['m0', 'm1', 'm2', 'm3']);
    expect(djUpcoming()).toBe(5);
    expect(queue.length).toBe(9);
  });

  it('tags picks as the DJ (FR-027)', async () => {
    const { engine, queue } = setup();
    await engine.start({ theme: 'rock' });
    expect(queue.tracks[0]).toMatchObject({
      addedByDj: true,
      requestedBy: 'SquareMusica DJ',
      requestedById: null
    });
  });

  it('asks for needed + 4 picks with at most 60 deduped history candidates', async () => {
    const rows = Array.from({ length: 50 }, (_, i) => ({
      url: `https://yt/h${i}`,
      title: `h${i}`,
      artist: i % 2 ? `Band ${i}` : null,
      count: 3,
      duration: 200,
      thumbnail: null
    }));
    const { engine, deps } = setup({ topTracks: () => rows });
    await engine.start({ theme: 'rock' });

    const request = chatJson.mock.calls[0][0];
    expect(request.user.count).toBe(5 + 4);
    expect(request.user.candidates.length).toBeLessThanOrEqual(60);
    // Present members' top tracks and the server's overlap: deduped by URL.
    expect(request.user.candidates).toHaveLength(50);
    expect(request.user.candidates[0]).toEqual({ id: 'c1', title: 'h0', artist: null });
    expect(request.user.candidates[1].artist).toBe('Band 1');
    expect(deps.getTopTracks).toHaveBeenCalledWith({ userIds: ['A'], limit: 60 });
    expect(deps.getTopTracks).toHaveBeenCalledWith({ limit: 60 });
    expect(request.temperature).toBe(0.7);
    expect(request.timeoutMs).toBe(20000);
  });

  it('caps candidates at 60', async () => {
    const rows = Array.from({ length: 80 }, (_, i) => ({
      url: `https://yt/h${i}`,
      title: `h${i}`
    }));
    const { engine } = setup({ topTracks: () => rows });
    await engine.start({ theme: 'rock' });
    expect(chatJson.mock.calls[0][0].user.candidates).toHaveLength(60);
  });

  it('the system prompt asks for about half of the picks from candidates (FR-021b)', () => {
    expect(PICKS_SYSTEM_PROMPT).toMatch(/about half/);
    expect(PICKS_SYSTEM_PROMPT).toMatch(/none of the candidates fit, pick only new songs/);
  });

  it('adds history picks directly and resolves only new picks', async () => {
    const rows = [{ url: 'https://yt/hist', title: 'Hist', artist: 'Band', duration: 180 }];
    chatJson.mockResolvedValue({
      picks: [{ candidateId: 'c1' }, newPick(0), newPick(1), newPick(2), newPick(3), newPick(4)]
    });
    const { engine, settle, queue } = setup({ topTracks: () => rows });
    await engine.start({ theme: 'rock' });
    await settle();
    expect(queue.tracks[0]).toMatchObject({ url: 'https://yt/hist', title: 'Hist' });
    expect(resolveSpotifyTrack).not.toHaveBeenCalledWith(
      expect.objectContaining({ title: 'Hist' })
    );
    expect(resolveSpotifyTrack).toHaveBeenCalledWith({ title: 'new0', artists: ['Artist new0'] });
  });

  it('ignores an unknown candidateId', async () => {
    chatJson.mockResolvedValue({ picks: [{ candidateId: 'c99' }, ...newPicks(6).picks] });
    const { engine, settle, queue } = setup();
    await engine.start({ theme: 'rock' });
    await settle();
    expect(queue.tracks.map((t) => t.title)).toEqual([
      'new0',
      'new1',
      'new2',
      'new3',
      'new4',
      'new5'
    ]);
  });

  it('drops unresolvable new picks and replaces them (FR-026)', async () => {
    resolveSpotifyTrack.mockImplementation(async ({ title }) =>
      title === 'new1' || title === 'new3' ? null : { url: `https://yt/${title}`, title }
    );
    const { engine, settle, queue, djUpcoming } = setup();
    await engine.start({ theme: 'rock' });
    await settle();
    expect(queue.tracks.map((t) => t.title)).not.toContain('new1');
    expect(queue.tracks.map((t) => t.title)).not.toContain('new3');
    expect(djUpcoming()).toBe(5);
  });

  it('counts themed_tracks usage once per added pick', async () => {
    const { engine, settle, state, queue } = setup();
    await engine.start({ theme: 'rock' });
    await settle();
    expect(state.usage).toBe(queue.length);
  });
});

describe('themeEngine: dedupe (FR-025)', () => {
  it('ignores picks in avoid / usedKeys and sends them as avoid', async () => {
    const { engine, settle, queue } = setup();
    queue.add({ title: 'new0', url: 'https://yt/new0', spotifyData: { artists: ['Artist new0'] } });
    await engine.start({ theme: 'rock' });
    await settle();
    expect(chatJson.mock.calls[0][0].user.avoid).toContain('artist new0 - new0');
    expect(queue.tracks.filter((t) => t.title === 'new0')).toHaveLength(1);
  });

  it('a batch emptied by dedupe triggers one allowRepeats retry', async () => {
    const { engine, queue } = setup();
    queue.add({ title: 'new0', url: 'https://yt/new0', spotifyData: { artists: ['Artist new0'] } });
    chatJson.mockResolvedValueOnce({ picks: [newPick(0)] }).mockResolvedValueOnce({
      picks: [newPick(0)]
    });
    await engine.start({ theme: 'rock' });
    expect(chatJson).toHaveBeenCalledTimes(2);
    expect(chatJson.mock.calls[1][0].user.allowRepeats).toBe(true);
    expect(chatJson.mock.calls[1][0].user.avoid).toEqual([]);
    expect(queue.tracks.filter((t) => t.title === 'new0')).toHaveLength(2);
  });

  it('member-queued tracks seen in queue:update are never picked', async () => {
    const { engine, settle, queue } = setup();
    await engine.start({ theme: 'rock' });
    await settle();
    const member = { title: 'member', url: 'https://yt/member' };
    queue.add(member);
    engine.onQueueUpdate({ tracks: queue.getAll() });

    chatJson.mockResolvedValue({ picks: [{ artist: 'X', title: 'member' }, newPick(0, 'next')] });
    queue.currentIndex = 3;
    engine.onTrackChange(queue.getCurrent());
    await settle();
    expect(queue.tracks.filter((t) => t.url === 'https://yt/member')).toHaveLength(1);
  });

  it('every track that starts playing is added to usedKeys', async () => {
    const { engine, settle, queue } = setup();
    await engine.start({ theme: 'rock' });
    await settle();
    // A track that only ever played (e.g. resolved later) is still avoided.
    engine.onTrackChange({ title: 'played', url: 'https://yt/played', artist: 'Someone' });
    chatJson.mockClear();
    chatJson.mockResolvedValueOnce({ picks: [{ artist: 'Someone', title: 'played' }] });
    chatJson.mockResolvedValue(newPicks(9, 'fresh'));
    queue.currentIndex = 5;
    engine.trigger();
    await settle();
    const first = chatJson.mock.calls[0][0].user;
    expect(first.allowRepeats).toBe(false);
    expect(first.avoid).toContain('someone - played');
    expect(queue.tracks.filter((t) => t.title === 'played')).toHaveLength(0);
  });
});

describe('themeEngine: start failures (FR-029)', () => {
  it('zero playable tracks on start throws NO_TRACKS_FOR_THEME and no session exists', async () => {
    resolveSpotifyTrack.mockResolvedValue(null);
    const { engine, deps } = setup();
    await expect(engine.start({ theme: 'zzzzqqqq' })).rejects.toMatchObject({
      code: 'NO_TRACKS_FOR_THEME'
    });
    expect(engine.getSession()).toBeNull();
    expect(deps.onStatusChange).not.toHaveBeenCalled();
  });

  it('an LLM failure on start throws SERVICE_UNAVAILABLE and records a failure', async () => {
    chatJson.mockRejectedValue(new Error('down'));
    const { engine, deps } = setup();
    await expect(engine.start({ theme: 'rock' })).rejects.toMatchObject({
      code: 'SERVICE_UNAVAILABLE'
    });
    expect(engine.getSession()).toBeNull();
    expect(deps.recordFailure).toHaveBeenCalled();
  });

  it('starts without an LLM call when kept DJ picks already meet the lookahead (FR-021)', async () => {
    const { engine, queue, deps } = setup();
    queue.add({ title: 'now', url: 'https://yt/now' });
    for (let i = 0; i < 5; i++) {
      queue.add({ title: `kept${i}`, url: `https://yt/kept${i}`, addedByDj: true });
    }
    const session = await engine.start({ theme: 'rock' });
    expect(session).toMatchObject({ theme: 'rock', status: 'running' });
    expect(engine.getSession()).toBe(session);
    expect(chatJson).not.toHaveBeenCalled();
    expect(deps.addToQueue).not.toHaveBeenCalled();
  });

  it.each([
    ['NOT_IN_VOICE', (s) => (s.connected = false)],
    ['CAP_REACHED', (s) => (s.capReached = true)],
    ['SERVICE_UNAVAILABLE', (s) => (s.canAttempt = false)]
  ])('a start blocked by %s reports that reason, not NO_TRACKS_FOR_THEME', async (code, block) => {
    const { engine, state } = setup();
    block(state);
    await expect(engine.start({ theme: 'rock' })).rejects.toMatchObject({ code });
    expect(engine.getSession()).toBeNull();
    expect(chatJson).not.toHaveBeenCalled();
  });

  it('start resolves as soon as the first pick is in the queue (SC-005)', async () => {
    let release;
    const gate = new Promise((r) => {
      release = r;
    });
    resolveSpotifyTrack.mockImplementation(async ({ title }) => {
      if (title !== 'new0') await gate;
      return { url: `https://yt/${title}`, title };
    });
    const { engine, queue, djUpcoming, settle } = setup();
    await engine.start({ theme: 'rock' });
    expect(queue.length).toBe(1);

    release();
    await settle();
    expect(djUpcoming()).toBe(5);
  });
});

describe('themeEngine: stalls and debounce', () => {
  async function started(opts) {
    const ctx = setup(opts);
    await ctx.engine.start({ theme: 'rock' });
    await ctx.settle();
    ctx.deps.onStatusChange.mockClear();
    ctx.state.statusChanges.length = 0;
    chatJson.mockClear();
    return ctx;
  }

  async function advance(ctx) {
    ctx.queue.currentIndex++;
    ctx.engine.onTrackChange(ctx.queue.getCurrent());
    await ctx.settle();
  }

  it.each([
    ['NO_LISTENERS', (s) => (s.listeners = false), (s) => (s.listeners = true)],
    ['NOT_IN_VOICE', (s) => (s.connected = false), (s) => (s.connected = true)],
    ['CAP_REACHED', (s) => (s.capReached = true), (s) => (s.capReached = false)],
    ['SERVICE_UNAVAILABLE', (s) => (s.canAttempt = false), (s) => (s.canAttempt = true)]
  ])('stalls with %s and resumes when the condition clears', async (reason, block, clear) => {
    const ctx = await started();
    block(ctx.state);
    await advance(ctx);
    expect(ctx.engine.getSession()).toMatchObject({ status: 'stalled', reason });
    expect(chatJson).not.toHaveBeenCalled();

    clear(ctx.state);
    await vi.advanceTimersByTimeAsync(30 * 1000);
    await ctx.settle();
    expect(ctx.engine.getSession()).toMatchObject({ status: 'running', reason: null });
    expect(ctx.djUpcoming()).toBe(5);
    expect(ctx.state.statusChanges).toEqual([
      ['stalled', reason],
      ['running', null]
    ]);
  });

  it('stalls with SERVICE_UNAVAILABLE when the LLM fails during a top-up', async () => {
    const ctx = await started();
    chatJson.mockRejectedValueOnce(new Error('down'));
    await advance(ctx);
    expect(ctx.engine.getSession()).toMatchObject({
      status: 'stalled',
      reason: 'SERVICE_UNAVAILABLE'
    });
    expect(ctx.deps.recordFailure).toHaveBeenCalled();
  });

  it('stalls with THEME_EXHAUSTED when a top-up adds nothing, and resumes later', async () => {
    const ctx = await started();
    resolveSpotifyTrack.mockResolvedValue(null);
    await advance(ctx);
    expect(ctx.engine.getSession()).toMatchObject({ status: 'stalled', reason: 'THEME_EXHAUSTED' });

    resolveByTitle();
    chatJson.mockResolvedValue(newPicks(9, 'more'));
    await advance(ctx);
    expect(ctx.engine.getSession()).toMatchObject({ status: 'running' });
  });

  it('restarts playback when it refills a queue that ran dry during a stall (FR-022)', async () => {
    const ctx = await started();
    ctx.deps.ensurePlaying = vi.fn();
    ctx.state.listeners = false;
    await advance(ctx);
    expect(ctx.engine.getSession()).toMatchObject({ status: 'stalled', reason: 'NO_LISTENERS' });

    // The set plays out and Queue.next() empties the queue at its end.
    ctx.queue.clear();
    ctx.state.listeners = true;
    chatJson.mockResolvedValue(newPicks(9, 'again'));
    ctx.engine.recheck();
    await ctx.settle();
    expect(ctx.queue.length).toBeGreaterThan(0);
    expect(ctx.deps.ensurePlaying).toHaveBeenCalledTimes(1);
  });

  it('the first top-up leaves starting playback to the caller', async () => {
    const ctx = setup();
    ctx.deps.ensurePlaying = vi.fn();
    await ctx.engine.start({ theme: 'rock' });
    await ctx.settle();
    expect(ctx.deps.ensurePlaying).not.toHaveBeenCalled();
  });

  it('presence recheck stalls without waiting for a track', async () => {
    const ctx = await started();
    ctx.state.listeners = false;
    ctx.engine.recheck();
    expect(ctx.engine.getSession()).toMatchObject({ status: 'stalled', reason: 'NO_LISTENERS' });
  });

  it('debounces 1 s and keeps one top-up in flight', async () => {
    const ctx = await started();
    let release;
    chatJson.mockImplementation(
      () =>
        new Promise((r) => {
          release = () => r(newPicks(9, 'deb'));
        })
    );
    ctx.queue.currentIndex = 2;
    for (let i = 0; i < 5; i++) ctx.engine.trigger();
    await vi.advanceTimersByTimeAsync(999);
    expect(chatJson).toHaveBeenCalledTimes(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(chatJson).toHaveBeenCalledTimes(1);

    // More triggers while in flight do not start a second request.
    ctx.engine.trigger();
    await vi.advanceTimersByTimeAsync(2000);
    expect(chatJson).toHaveBeenCalledTimes(1);

    release();
    await vi.advanceTimersByTimeAsync(0);
    await ctx.engine.getInFlight();
    // The trigger that arrived in flight runs once afterwards.
    chatJson.mockResolvedValue(newPicks(9, 'after'));
    await ctx.settle();
    expect(chatJson.mock.calls.length).toBeGreaterThanOrEqual(1);
    expect(ctx.djUpcoming()).toBe(5);
  });
});

describe('themeEngine: session end races (FR-024b)', () => {
  it('picks that resolve after stop are not added and not counted', async () => {
    let release;
    const gate = new Promise((r) => {
      release = r;
    });
    resolveSpotifyTrack.mockImplementation(async ({ title }) => {
      if (title !== 'new0') await gate;
      return { url: `https://yt/${title}`, title };
    });
    const { engine, queue, state, settle } = setup();
    await engine.start({ theme: 'rock' });
    expect(queue.length).toBe(1);
    expect(state.usage).toBe(1);

    engine.stop();
    release();
    await settle();
    expect(queue.length).toBe(1);
    expect(state.usage).toBe(1);
  });

  it("a new session started straight after does not receive the old session's late picks", async () => {
    let release;
    const gate = new Promise((r) => {
      release = r;
    });
    resolveSpotifyTrack.mockImplementation(async ({ title }) => {
      if (title.startsWith('new') && title !== 'new0') await gate;
      return { url: `https://yt/${title}`, title };
    });
    const { engine, queue, settle } = setup();
    await engine.start({ theme: 'rock' });
    engine.stop();

    chatJson.mockResolvedValue(newPicks(9, 'second'));
    await engine.start({ theme: 'jazz' });
    release();
    await settle();
    const titles = queue.tracks.map((t) => t.title);
    expect(titles.filter((t) => /^new[1-9]/.test(t))).toEqual([]);
    expect(titles).toContain('second0');
  });

  it('after stop, a queue:update with an empty queue triggers no top-up', async () => {
    const { engine, queue, settle } = setup();
    await engine.start({ theme: 'rock' });
    await settle();
    chatJson.mockClear();

    engine.stop();
    queue.clear();
    engine.onQueueUpdate({ tracks: [], currentIndex: 0 });
    engine.onTrackChange(null);
    await settle();
    expect(chatJson).not.toHaveBeenCalled();
    expect(queue.length).toBe(0);
  });

  it('a theme change drops picks still resolving for the old theme (US4/AC7)', async () => {
    let release;
    const gate = new Promise((r) => {
      release = r;
    });
    resolveSpotifyTrack.mockImplementation(async ({ title }) => {
      if (title !== 'new0') await gate;
      return { url: `https://yt/${title}`, title };
    });
    const { engine, queue, settle } = setup();
    await engine.start({ theme: 'rock' });
    chatJson.mockResolvedValue(newPicks(9, 'lofi'));
    engine.changeTheme('lo-fi');
    expect(engine.getSession()).toMatchObject({ theme: 'lo-fi', introPending: true });
    release();
    await settle();
    const titles = queue.tracks.map((t) => t.title);
    expect(titles[0]).toBe('new0');
    expect(titles.filter((t) => /^new[1-9]/.test(t))).toEqual([]);
    expect(titles).toContain('lofi0');
  });
});
