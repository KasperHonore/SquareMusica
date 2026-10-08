import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../../src/utils/logger.js', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() }
}));

import {
  createThemeEngine,
  normaliseTheme,
  PICKS_SYSTEM_PROMPT,
  songKey
} from '../../../src/services/dj/themeEngine.js';
import { Queue } from '../../../src/core/queue.js';

// llm.chatJson and resolveSpotifyTrack are injected, so they are plain mocks
// here; the queue is the real Queue so countUpcoming and ordering are real.

let queue;
let lookahead;
let users;
let connected;
let capReached;
let breakerOk;
let store;
let chatJson;
let resolveTrack;
let addToQueue;
let onPickAdded;
let onFailure;
let onChange;
let engine;

const member = (id) => ({ title: id, url: `https://y/${id}`, requestedById: 'U1' });
const ids = () => queue.tracks.map((t) => t.title);
const djIds = () => queue.tracks.filter((t) => t.addedByDj).map((t) => t.title);

/** chatJson answering `count` new songs named `${prefix}N`. */
function newSongs(prefix = 's') {
  let n = 0;
  return vi.fn(async ({ user }) => {
    const { count } = JSON.parse(user);
    return {
      picks: Array.from({ length: count }, () => {
        n++;
        return { artist: 'Band', title: `${prefix}${n}` };
      })
    };
  });
}

function makeEngine() {
  return createThemeEngine({
    getQueue: () => queue,
    getLookahead: () => lookahead,
    getConnectedUsers: () => users,
    getOptOuts: () => new Set(['U9']),
    isConnected: () => connected,
    store,
    chatJson: (...args) => chatJson(...args),
    resolveTrack: (...args) => resolveTrack(...args),
    addToQueue,
    canAttempt: () => breakerOk,
    isCapReached: () => capReached,
    onPickAdded,
    onFailure,
    onChange
  });
}

async function flush() {
  for (let i = 0; i < 20; i++) await vi.advanceTimersByTimeAsync(0);
}

beforeEach(() => {
  vi.useFakeTimers();
  queue = new Queue();
  lookahead = 5;
  users = [{ id: 'U1' }, { id: 'U9' }, { id: 'BOT', bot: true }];
  connected = true;
  capReached = false;
  breakerOk = true;
  store = { getTopTracks: vi.fn(() => []) };
  chatJson = newSongs();
  resolveTrack = vi.fn(async ({ title }) => ({
    url: `https://y/${title}`,
    duration: 180,
    thumbnail: null,
    channel: 'Band'
  }));
  addToQueue = vi.fn((track) => queue.add(track));
  onPickAdded = vi.fn();
  onFailure = vi.fn();
  onChange = vi.fn();
  engine = makeEngine();
});

afterEach(() => {
  engine.stop();
  vi.useRealTimers();
});

describe('normaliseTheme / songKey', () => {
  it('trims and enforces 1–200 characters', () => {
    expect(normaliseTheme('  rock  ')).toBe('rock');
    expect(normaliseTheme('   ')).toBeNull();
    expect(normaliseTheme('x'.repeat(201))).toBeNull();
    expect(normaliseTheme('x'.repeat(200))).toBe('x'.repeat(200));
    expect(normaliseTheme(5)).toBeNull();
  });

  it('songKey needs an artist', () => {
    expect(songKey('ABBA', 'Waterloo')).toBe('abba - waterloo');
    expect(songKey(null, 'Waterloo')).toBeNull();
  });
});

describe('start and top-up (FR-021a, FR-022, SC-005)', () => {
  it('fills an empty queue to the lookahead with DJ-attributed picks', async () => {
    const { ready } = engine.start({ theme: 'rock', startedBy: { id: 'U1', name: 'K' } });
    await expect(ready).resolves.toEqual({ added: true, failure: null });
    await engine.idle();
    expect(queue.countUpcoming((t) => t.addedByDj) + 1).toBe(5); // first pick is current
    expect(queue.tracks).toHaveLength(5);
    for (const t of queue.tracks) {
      expect(t).toMatchObject({
        addedByDj: true,
        requestedBy: 'SquareMusica DJ',
        requestedById: null
      });
    }
    expect(onPickAdded).toHaveBeenCalledTimes(5);
  });

  it('keeps existing upcoming member tracks in place and does not count them', async () => {
    queue.add(member('now'));
    queue.add(member('m1'));
    queue.add(member('m2'));
    queue.add(member('m3'));
    engine.start({ theme: 'rock' });
    await engine.idle();
    expect(ids().slice(0, 4)).toEqual(['now', 'm1', 'm2', 'm3']);
    expect(djIds()).toHaveLength(5);
    expect(queue.countUpcoming((t) => t.addedByDj)).toBe(5);
  });

  it('asks for needed + 4 picks with ≤ 60 history candidates and the half-history prompt', async () => {
    store.getTopTracks = vi.fn(({ userIds }) =>
      Array.from({ length: 50 }, (_, i) => ({
        url: `https://h/${userIds ? 'm' : 's'}${i}`,
        title: `h${i}`,
        artist: i % 2 ? 'Artist' : null,
        count: 3,
        duration: 200,
        thumbnail: null
      }))
    );
    queue.add(member('now'));
    queue.add({ ...member('p0'), addedByDj: true });
    engine.start({ theme: 'rock' });
    await engine.idle();

    const payload = JSON.parse(chatJson.mock.calls[0][0].user);
    expect(payload.count).toBe(4 + 4);
    expect(payload.theme).toBe('rock');
    expect(payload.allowRepeats).toBe(false);
    expect(payload.candidates.length).toBeLessThanOrEqual(60);
    expect(payload.candidates[0]).toEqual({ id: 'c1', title: 'h0', artist: null });
    expect(payload.candidates[1].artist).toBe('Artist');
    // Present, opted-in humans only: U9 opted out, the bot is skipped.
    expect(store.getTopTracks).toHaveBeenCalledWith({ userIds: ['U1'], limit: 20 });
    expect(chatJson.mock.calls[0][0]).toMatchObject({ temperature: 0.7, timeoutMs: 20000 });
    expect(PICKS_SYSTEM_PROMPT).toMatch(/about half of the picks from the\s+candidates/);
    expect(PICKS_SYSTEM_PROMPT).toMatch(/when none fit, pick only new songs/);
  });

  it('adds history picks directly, ignores unknown candidateIds', async () => {
    store.getTopTracks = vi.fn(() => [
      { url: 'https://h/1', title: 'Hist', artist: 'A', count: 4, duration: 99, thumbnail: 't' }
    ]);
    lookahead = 2;
    chatJson = vi.fn(async () => ({
      picks: [{ candidateId: 'c1' }, { candidateId: 'c99' }, { artist: 'B', title: 'New' }]
    }));
    engine.start({ theme: 'rock' });
    await engine.idle();
    expect(ids()).toEqual(['Hist', 'New']);
    expect(queue.tracks[0]).toMatchObject({ url: 'https://h/1', duration: 99, artist: 'A' });
    expect(resolveTrack).toHaveBeenCalledTimes(1);
    expect(resolveTrack).toHaveBeenCalledWith({ title: 'New', artists: ['B'] });
  });

  it('ignores picks already used this session (avoid/usedKeys)', async () => {
    queue.add({ title: 'Old', url: 'https://y/old', spotifyData: { artists: ['Band'] } });
    lookahead = 1;
    chatJson = vi.fn(async ({ user }) => {
      const { avoid } = JSON.parse(user);
      expect(avoid).toContain('band - old');
      return {
        picks: [
          { artist: 'Band', title: 'Old' },
          { artist: 'Band', title: 'Fresh' }
        ]
      };
    });
    engine.start({ theme: 'rock' });
    await engine.idle();
    expect(djIds()).toEqual(['Fresh']);
  });

  it('drops unresolvable new picks and fills the gap from the rest (FR-026)', async () => {
    lookahead = 3;
    resolveTrack = vi.fn(async ({ title }) =>
      title === 's2' ? null : { url: `https://y/${title}`, duration: 100 }
    );
    engine.start({ theme: 'rock' });
    await engine.idle();
    expect(djIds()).toHaveLength(3);
    expect(djIds()).not.toContain('s2');
  });

  it('retries once with allowRepeats when dedupe empties a batch (FR-025)', async () => {
    queue.add({ title: 'Only', url: 'https://y/Only', spotifyData: { artists: ['Band'] } });
    lookahead = 1;
    chatJson = vi.fn(async () => ({ picks: [{ artist: 'Band', title: 'Only' }] }));
    engine.start({ theme: 'rock' });
    await engine.idle();
    expect(chatJson).toHaveBeenCalledTimes(2);
    expect(JSON.parse(chatJson.mock.calls[1][0].user).allowRepeats).toBe(true);
    expect(djIds()).toEqual(['Only']);
  });

  it('zero playable tracks on start settles with nothing added', async () => {
    resolveTrack = vi.fn(async () => null);
    const { ready } = engine.start({ theme: 'nothing fits' });
    await expect(ready).resolves.toMatchObject({ added: false });
    expect(queue.tracks).toHaveLength(0);
  });

  it('ready settles as soon as the first pick is queued; the rest resolve in background', async () => {
    const resolvers = [];
    resolveTrack = vi.fn(
      ({ title }) =>
        new Promise((resolve) => resolvers.push(() => resolve({ url: `https://y/${title}` })))
    );
    let settled = null;
    const { ready } = engine.start({ theme: 'rock' });
    ready.then((v) => (settled = v));
    await flush();
    expect(settled).toBeNull();
    resolvers.shift()();
    await flush();
    expect(settled).toEqual({ added: true, failure: null });
    expect(queue.tracks).toHaveLength(1);
    while (resolvers.length) {
      resolvers.shift()();
      await flush();
    }
    await engine.idle();
    expect(queue.tracks).toHaveLength(5);
  });

  it('every track that starts playing and every member track is never picked again', async () => {
    lookahead = 1;
    engine.start({ theme: 'rock' });
    await engine.idle();
    engine.onTrackChange({ title: 'Played', url: 'https://y/played', artist: 'Band' });
    engine.onQueueUpdate({
      tracks: [{ title: 'Req', url: 'https://y/req', spotifyData: { artists: ['Band'] } }]
    });
    const session = engine.getSession();
    expect(session.usedKeys.has('https://y/played')).toBe(true);
    expect(session.usedKeys.has('band - played')).toBe(true);
    expect(session.usedKeys.has('band - req')).toBe(true);
  });
});

describe('stalls (FR-029)', () => {
  async function startRunning() {
    lookahead = 1;
    engine.start({ theme: 'rock' });
    await engine.idle();
    engine.getSession().announced = true;
    lookahead = 3;
  }

  it.each([
    ['NO_LISTENERS', () => (users = [{ id: 'BOT', bot: true }]), () => (users = [{ id: 'U1' }])],
    ['NOT_IN_VOICE', () => (connected = false), () => (connected = true)],
    ['CAP_REACHED', () => (capReached = true), () => (capReached = false)],
    ['SERVICE_UNAVAILABLE', () => (breakerOk = false), () => (breakerOk = true)]
  ])('stalls with %s and resumes when the condition clears', async (reason, block, unblock) => {
    await startRunning();
    block();
    engine.trigger();
    await engine.idle();
    expect(engine.getThemeState()).toMatchObject({ status: 'stalled', reason });
    expect(onChange).toHaveBeenCalled();

    unblock();
    engine.trigger();
    await engine.idle();
    expect(engine.getThemeState()).toMatchObject({ status: 'running', reason: null });
    expect(queue.countUpcoming((t) => t.addedByDj)).toBe(3);
  });

  it('stalls with SERVICE_UNAVAILABLE and reports the failure when the LLM fails', async () => {
    await startRunning();
    chatJson = vi.fn(async () => {
      throw Object.assign(new Error('down'), { kind: 'network' });
    });
    engine.trigger();
    await engine.idle();
    expect(engine.getThemeState()).toMatchObject({
      status: 'stalled',
      reason: 'SERVICE_UNAVAILABLE'
    });
    expect(onFailure).toHaveBeenCalledWith('llm', expect.any(Error));
  });

  it('stalls with THEME_EXHAUSTED when nothing new fits, even allowing repeats', async () => {
    await startRunning();
    chatJson = vi.fn(async () => ({ picks: [] }));
    engine.trigger();
    await engine.idle();
    expect(engine.getThemeState()).toMatchObject({ status: 'stalled', reason: 'THEME_EXHAUSTED' });
    expect(chatJson).toHaveBeenCalledTimes(2);
  });

  it('a stall before the start is announced does not broadcast', async () => {
    connected = false;
    const { ready } = engine.start({ theme: 'rock' });
    await expect(ready).resolves.toEqual({ added: false, failure: 'NOT_IN_VOICE' });
    expect(onChange).not.toHaveBeenCalled();
  });

  it('a pick that lands when the cap is reached is not added', async () => {
    let added = 0;
    onPickAdded = vi.fn(() => {
      added++;
      if (added === 2) capReached = true;
    });
    engine = makeEngine();
    engine.start({ theme: 'rock' });
    await engine.idle();
    expect(queue.tracks).toHaveLength(2);
    expect(engine.getThemeState().reason).toBe('CAP_REACHED');
  });
});

describe('triggers', () => {
  it('debounces queue and track events by 1 s with one top-up in flight', async () => {
    lookahead = 1;
    engine.start({ theme: 'rock' });
    await engine.idle();
    chatJson.mockClear();
    lookahead = 2;

    engine.onQueueUpdate({ tracks: [] });
    engine.onTrackChange(null);
    engine.onQueueUpdate({ tracks: [] });
    await vi.advanceTimersByTimeAsync(999);
    expect(chatJson).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await engine.idle();
    expect(chatJson).toHaveBeenCalledTimes(1);
  });

  it('triggers during a top-up collapse into one follow-up, never concurrent', async () => {
    let active = 0;
    let maxActive = 0;
    const releases = [];
    chatJson = vi.fn(() => {
      active++;
      maxActive = Math.max(maxActive, active);
      return new Promise((resolve) =>
        releases.push(() => {
          active--;
          resolve({ picks: [{ artist: 'B', title: `x${chatJson.mock.calls.length}` }] });
        })
      );
    });
    lookahead = 1;
    engine.start({ theme: 'rock' });
    await flush();
    engine.trigger();
    engine.trigger();
    engine.trigger();
    expect(chatJson).toHaveBeenCalledTimes(1);
    releases.shift()();
    await flush();
    // The first pick is now playing, so none is upcoming: one follow-up runs.
    expect(chatJson).toHaveBeenCalledTimes(2);
    releases.shift()();
    await flush();
    await engine.idle();
    expect(chatJson).toHaveBeenCalledTimes(2);
    expect(maxActive).toBe(1);
    expect(queue.countUpcoming((t) => t.addedByDj)).toBe(1);
  });

  it('as tracks finish, upcoming picks return to the lookahead (US4/AC2)', async () => {
    engine.start({ theme: 'rock' });
    await engine.idle();
    // The first pick is playing; four are upcoming. Fill to five upcoming.
    engine.trigger();
    await engine.idle();
    expect(queue.countUpcoming((t) => t.addedByDj)).toBe(5);
    const next = queue.next();
    engine.onTrackChange(next);
    expect(queue.countUpcoming((t) => t.addedByDj)).toBe(4);
    await vi.advanceTimersByTimeAsync(1000);
    await engine.idle();
    expect(queue.countUpcoming((t) => t.addedByDj)).toBe(5);
  });
});

describe('session end while a top-up is resolving (FR-024b)', () => {
  function deferredResolver() {
    const pending = [];
    resolveTrack = vi.fn(
      ({ title }) =>
        new Promise((resolve) => pending.push(() => resolve({ url: `https://y/${title}` })))
    );
    return pending;
  }

  it('picks that resolve after stop are not added nor counted', async () => {
    const pending = deferredResolver();
    engine.start({ theme: 'rock' });
    await flush();
    pending.shift()();
    await flush();
    expect(queue.tracks).toHaveLength(1);
    engine.stop();
    while (pending.length) pending.shift()();
    await flush();
    expect(queue.tracks).toHaveLength(1);
    expect(onPickAdded).toHaveBeenCalledTimes(1);
  });

  it('a new session does not receive the old session’s late picks', async () => {
    const pending = deferredResolver();
    engine.start({ theme: 'old' });
    await flush();
    const oldResolvers = pending.splice(0);
    engine.stop();
    chatJson = newSongs('n');
    engine.start({ theme: 'new' });
    await flush();
    for (const resolve of oldResolvers) resolve();
    await flush();
    expect(queue.tracks).toHaveLength(0);
    while (pending.length) {
      pending.shift()();
      await flush();
    }
    await engine.idle();
    expect(queue.tracks.every((t) => t.title.startsWith('n'))).toBe(true);
    expect(queue.tracks.length).toBeGreaterThan(0);
  });

  it('after stop, an emptied queue:update triggers no top-up', async () => {
    lookahead = 1;
    engine.start({ theme: 'rock' });
    await engine.idle();
    chatJson.mockClear();
    engine.stop();
    queue.clear();
    engine.onQueueUpdate({ tracks: [], currentIndex: 0 });
    engine.onTrackChange(null);
    await vi.advanceTimersByTimeAsync(5000);
    expect(chatJson).not.toHaveBeenCalled();
    expect(queue.tracks).toHaveLength(0);
  });

  it('a theme change drops picks still resolving for the old theme', async () => {
    const pending = deferredResolver();
    engine.start({ theme: 'old' });
    await flush();
    pending.shift()();
    await flush();
    const stale = pending.splice(0);
    engine.changeTheme('new');
    for (const resolve of stale) resolve();
    await flush();
    expect(queue.tracks).toHaveLength(1);
    expect(engine.getSession().theme).toBe('new');
  });
});
