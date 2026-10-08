import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../../src/integrations/llm.js', () => ({ chatJson: vi.fn() }));
vi.mock('../../../src/services/resolver.js', () => ({ resolveSpotifyTrack: vi.fn() }));
vi.mock('../../../src/integrations/youtube.js', () => ({ search: vi.fn() }));

import { chatJson } from '../../../src/integrations/llm.js';
import { resolveSpotifyTrack } from '../../../src/services/resolver.js';
import {
  createThemeEngine,
  SYSTEM_PROMPT,
  DJ_REQUESTER,
  songKey
} from '../../../src/services/dj/themeEngine.js';
import { Queue } from '../../../src/core/queue.js';

const quietLogger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };

/** A resolvable new pick and what the resolver returns for it. */
const song = (n) => ({ artist: `Artist ${n}`, title: `Song ${n}` });
const urlOf = ({ artist, title }) => `https://yt/${artist}/${title}`.replace(/\s+/g, '_');

let h;

/**
 * An engine over a real Queue. `state` drives every condition; `chatJson` and
 * `resolveSpotifyTrack` are the module mocks, defaulting to a model that
 * answers with fresh new songs and a resolver that finds every one.
 */
function setup({ lookahead = 5, history = [], ...overrides } = {}) {
  const queue = new Queue();
  const state = {
    lookahead,
    users: [{ id: 'A' }, { id: 'B' }],
    connected: true,
    breakerOpen: false,
    capReached: false,
    optOuts: new Set()
  };
  const db = {
    getTopTracks: vi.fn(({ userIds, limit }) =>
      history
        .filter((row) => !userIds || userIds.includes(row.userId))
        .slice(0, limit)
        .map(({ userId: _u, ...row }) => row)
    ),
    getShoutoutOptOuts: vi.fn(() => state.optOuts)
  };
  const added = [];
  let engine = null;
  const deps = {
    getQueue: () => queue,
    // Like musicManager.addToQueue: every add emits queue:update.
    addToQueue: vi.fn((track) => {
      added.push(track);
      queue.add(track);
      engine?.onQueueUpdate({ tracks: queue.getAll(), currentIndex: queue.currentIndex });
    }),
    getLookahead: () => state.lookahead,
    getVoiceContext: () => ({ connectedUsers: state.users }),
    isConnected: () => state.connected,
    history: db,
    isBreakerOpen: () => state.breakerOpen,
    canAttempt: () => !state.breakerOpen,
    recordSuccess: vi.fn(),
    recordFailure: vi.fn(),
    isCapReached: () => state.capReached,
    recordUsage: vi.fn(),
    onChange: vi.fn(),
    onPicksAdded: vi.fn(),
    logger: quietLogger,
    ...overrides
  };
  engine = createThemeEngine(deps);
  return { queue, state, db, added, deps, engine };
}

let songCounter;

/** Default model: `count` never-seen songs. */
function freshPicks() {
  chatJson.mockImplementation(async ({ user }) => ({
    picks: Array.from({ length: user.count }, () => song(++songCounter))
  }));
}

function resolveAll() {
  resolveSpotifyTrack.mockImplementation(async ({ title, artists }) => {
    const url = urlOf({ artist: artists[0], title });
    return { url, title, channel: artists[0], duration: 180, thumbnail: null };
  });
}

const upcomingPicks = () => h.queue.countUpcoming((t) => t.addedByDj);

/** Let debounces, resolutions and their promises run. */
async function settle(ms = 1100) {
  await vi.advanceTimersByTimeAsync(ms);
}

function startTheme(theme = 'classic rock road trip') {
  return h.engine.start({
    theme,
    startedBy: { id: 'A', name: 'Alice' },
    origin: { transport: 'http' }
  });
}

/** Play the current track to its end, as the mediator would report it. */
function finishTrack() {
  const next = h.queue.next();
  h.engine.onTrackChange(next);
  h.engine.onQueueUpdate({ tracks: h.queue.getAll(), currentIndex: h.queue.currentIndex });
}

beforeEach(() => {
  vi.useFakeTimers();
  songCounter = 0;
  chatJson.mockReset();
  resolveSpotifyTrack.mockReset();
  freshPicks();
  resolveAll();
});

afterEach(() => {
  h?.engine.stop();
  vi.useRealTimers();
});

describe('themeEngine: starting and the lookahead (FR-021a, FR-022)', () => {
  it('start on an empty queue tops up to the lookahead with DJ-attributed picks', async () => {
    h = setup({ lookahead: 5 });
    await startTheme();
    await settle();

    // The first pick is the current track; 5 more are upcoming.
    expect(upcomingPicks()).toBe(5);
    expect(h.queue.length).toBe(6);
    for (const t of h.queue.getAll()) {
      expect(t).toMatchObject({ addedByDj: true, requestedBy: DJ_REQUESTER, requestedById: null });
    }
    expect(h.deps.recordUsage).toHaveBeenCalledTimes(6);
  });

  it('counts only upcoming addedByDj entries; existing member tracks are kept and not counted', async () => {
    h = setup({ lookahead: 5 });
    for (const id of ['m0', 'm1', 'm2', 'm3']) {
      h.queue.add({ title: id, url: `https://yt/${id}`, requestedById: 'A' });
    }
    await startTheme();
    await settle();

    const all = h.queue.getAll();
    expect(all.slice(0, 4).map((t) => t.title)).toEqual(['m0', 'm1', 'm2', 'm3']);
    expect(all.slice(4).every((t) => t.addedByDj)).toBe(true);
    expect(upcomingPicks()).toBe(5);
  });

  it('as tracks finish, upcoming picks return to the lookahead (US4/AC2)', async () => {
    h = setup({ lookahead: 5 });
    for (const id of ['m0']) h.queue.add({ title: id, url: `https://yt/${id}` });
    await startTheme();
    await settle();
    expect(upcomingPicks()).toBe(5);

    finishTrack();
    expect(upcomingPicks()).toBe(4);
    await settle();
    expect(upcomingPicks()).toBe(5);

    finishTrack();
    finishTrack();
    await settle();
    expect(upcomingPicks()).toBe(5);
  });

  it('a member song queued during themed mode goes ahead of the picks (US4/AC3)', async () => {
    h = setup({ lookahead: 5 });
    h.queue.add({ title: 'm0', url: 'https://yt/m0' });
    h.queue.prioritizeMemberTracks = true;
    await startTheme();
    await settle();

    h.queue.add({ title: 'member', url: 'https://yt/member' });
    h.engine.onQueueUpdate({ tracks: h.queue.getAll(), currentIndex: 0 });
    await settle();
    expect(h.queue.peekNext().title).toBe('member');
    expect(upcomingPicks()).toBe(5);
  });

  it('each request asks for needed + 4 picks with ≤ 60 history candidates', async () => {
    const history = Array.from({ length: 80 }, (_, i) => ({
      url: `https://yt/h${i}`,
      title: `History ${i}`,
      artist: i % 2 ? `Band ${i}` : null,
      userId: i < 10 ? 'A' : 'Z'
    }));
    h = setup({ lookahead: 5, history });
    h.queue.add({ title: 'm0', url: 'https://yt/m0' });
    for (let i = 0; i < 2; i++)
      h.queue.add({ title: `d${i}`, url: `https://yt/d${i}`, addedByDj: true });

    await startTheme();
    await settle();

    const { user, system, temperature, timeoutMs } = chatJson.mock.calls[0][0];
    expect(user.count).toBe(3 + 4);
    expect(user.theme).toBe('classic rock road trip');
    expect(user.allowRepeats).toBe(false);
    expect(user.candidates.length).toBeLessThanOrEqual(60);
    expect(user.candidates[0]).toEqual({ id: 'c1', title: 'History 0', artist: null });
    expect(Object.keys(user.candidates[1])).toEqual(['id', 'title', 'artist']);
    expect(Array.isArray(user.avoid)).toBe(true);
    expect(system).toBe(SYSTEM_PROMPT);
    expect(temperature).toBe(0.7);
    expect(timeoutMs).toBe(20000);
  });

  it('prefers present, opted-in members’ history: their tracks come first, opted-out members are skipped', async () => {
    const history = [
      { url: 'https://yt/z', title: 'Server', artist: 'S', userId: 'Z' },
      { url: 'https://yt/a', title: 'Alice', artist: 'Al', userId: 'A' },
      { url: 'https://yt/b', title: 'Bob', artist: 'Bo', userId: 'B' }
    ];
    h = setup({ history });
    h.state.optOuts = new Set(['B']);
    await startTheme();

    expect(h.db.getTopTracks).toHaveBeenCalledWith({ userIds: ['A'], limit: 60 });
    const { candidates } = chatJson.mock.calls[0][0].user;
    expect(candidates[0].title).toBe('Alice');
  });

  it('the system prompt asks for about half from candidates when enough fit, else all new (FR-021b)', () => {
    expect(SYSTEM_PROMPT).toMatch(/about half/i);
    expect(SYSTEM_PROMPT).toMatch(/candidates/);
    expect(SYSTEM_PROMPT).toMatch(/none fit.*new songs/i);
  });
});

describe('themeEngine: picks (contracts §5b, FR-025, FR-026)', () => {
  it('history picks are added directly; unknown candidateId is ignored', async () => {
    const history = [{ url: 'https://yt/h1', title: 'H1', artist: 'Band', userId: 'A' }];
    h = setup({ lookahead: 5, history });
    h.queue.add({ title: 'm0', url: 'https://yt/m0' });
    chatJson.mockResolvedValueOnce({
      picks: [{ candidateId: 'c1' }, { candidateId: 'c99' }, song(1), song(2), song(3), song(4)]
    });
    await startTheme();
    await settle();

    const urls = h.added.map((t) => t.url);
    expect(urls).toContain('https://yt/h1');
    expect(h.added).toHaveLength(5);
    expect(resolveSpotifyTrack).not.toHaveBeenCalledWith(expect.objectContaining({ title: 'H1' }));
    const pick = h.added.find((t) => t.url === 'https://yt/h1');
    expect(pick).toMatchObject({ title: 'H1', addedByDj: true, requestedById: null });
  });

  it('new picks are resolved through resolveSpotifyTrack({ title, artists: [artist] })', async () => {
    h = setup({ lookahead: 5 });
    await startTheme();
    expect(resolveSpotifyTrack).toHaveBeenCalledWith({ title: 'Song 1', artists: ['Artist 1'] });
  });

  it('unresolvable new picks are dropped and replaced (FR-026)', async () => {
    h = setup({ lookahead: 5 });
    resolveSpotifyTrack.mockImplementation(async ({ title, artists }) =>
      /[13579]$/.test(title)
        ? null
        : { url: urlOf({ artist: artists[0], title }), title, duration: 100 }
    );
    await startTheme();
    await settle(3000);

    expect(upcomingPicks()).toBe(5);
    for (const t of h.queue.getAll()) expect(t.title).toMatch(/[02468]$/);
  });

  it('picks in avoid / usedKeys are ignored', async () => {
    h = setup({ lookahead: 5 });
    h.queue.add({ title: 'Song 1', channel: 'Artist 1', url: 'https://yt/x' });
    chatJson.mockResolvedValueOnce({
      picks: [song(1), song(2), song(3), song(4), song(5), song(6)]
    });
    await startTheme();
    await settle();

    expect(chatJson.mock.calls[0][0].user.avoid).toContain('Artist 1 - Song 1');
    expect(h.added.map((t) => t.title)).not.toContain('Song 1');
    expect(h.added).toHaveLength(5);
  });

  it('a batch emptied by dedupe triggers exactly one allowRepeats retry (FR-025)', async () => {
    h = setup({ lookahead: 5 });
    h.queue.add({ title: 'Song 1', channel: 'Artist 1', url: 'https://yt/x' });
    chatJson
      .mockResolvedValueOnce({ picks: [song(1)] })
      .mockResolvedValueOnce({ picks: [song(1)] });
    await startTheme();
    await settle(0);

    expect(chatJson).toHaveBeenCalledTimes(2);
    expect(chatJson.mock.calls[1][0].user.allowRepeats).toBe(true);
    expect(h.added.map((t) => t.title)).toEqual(['Song 1']);
  });

  it('a batch that is merely empty (nothing deduped) does not retry', async () => {
    h = setup({ lookahead: 5 });
    chatJson.mockResolvedValueOnce({ picks: [] });
    await expect(startTheme()).rejects.toMatchObject({ code: 'NO_TRACKS_FOR_THEME' });
    expect(chatJson).toHaveBeenCalledTimes(1);
  });

  it('member-queued tracks and every started track are never picked again (FR-025)', async () => {
    h = setup({ lookahead: 5 });
    h.queue.add({ title: 'Opener', url: 'https://yt/opener' });
    await startTheme();
    await settle();

    // A member queues Artist 50 - Song 50; a track starts that the DJ didn't pick.
    h.queue.add({ title: 'Song 50', channel: 'Artist 50', url: 'https://yt/m50' });
    h.engine.onQueueUpdate({ tracks: h.queue.getAll(), currentIndex: h.queue.currentIndex });
    h.engine.onTrackChange({ title: 'Song 51', channel: 'Artist 51', url: 'https://yt/m51' });
    await settle();

    const used = h.engine.session.usedKeys;
    expect(used.has('https://yt/m50')).toBe(true);
    expect(used.has(songKey('Artist 50', 'Song 50'))).toBe(true);
    expect(used.has('https://yt/m51')).toBe(true);

    chatJson.mockResolvedValueOnce({
      picks: [song(50), song(51), { artist: 'artist 50!', title: 'SONG 50' }, song(60)]
    });
    finishTrack();
    await settle();
    const titles = h.added.map((t) => t.title);
    expect(titles).not.toContain('Song 50');
    expect(titles).not.toContain('Song 51');
    expect(titles).toContain('Song 60');
  });

  it('two picks resolving to the same video add it once', async () => {
    h = setup({ lookahead: 5 });
    resolveSpotifyTrack.mockResolvedValue({ url: 'https://yt/same', title: 'Same', duration: 1 });
    await startTheme();
    await settle(0);
    expect(h.added.map((t) => t.url)).toEqual(['https://yt/same']);
  });
});

describe('themeEngine: start failures (US4/AC5, FR-029)', () => {
  it('zero playable tracks throws NO_TRACKS_FOR_THEME and no session exists', async () => {
    h = setup();
    resolveSpotifyTrack.mockResolvedValue(null);
    await expect(startTheme('zzzzqqqq')).rejects.toMatchObject({ code: 'NO_TRACKS_FOR_THEME' });
    expect(h.engine.session).toBeNull();
    expect(h.engine.getState()).toBeNull();
    expect(h.queue.length).toBe(0);
  });

  it('an LLM failure at start throws SERVICE_UNAVAILABLE and records a breaker failure', async () => {
    h = setup();
    chatJson.mockRejectedValue(new Error('down'));
    await expect(startTheme()).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE' });
    expect(h.deps.recordFailure).toHaveBeenCalledWith('llm', expect.any(Error));
    expect(h.engine.session).toBeNull();
  });
});

describe('themeEngine: stalls (FR-029)', () => {
  async function running() {
    h = setup({ lookahead: 5 });
    h.queue.add({ title: 'm0', url: 'https://yt/m0' });
    await startTheme();
    await settle();
    expect(h.engine.getState().status).toBe('running');
    h.deps.onChange.mockClear();
  }

  const CASES = [
    ['NO_LISTENERS', (s) => (s.users = []), (s) => (s.users = [{ id: 'A' }])],
    ['NOT_IN_VOICE', (s) => (s.connected = false), (s) => (s.connected = true)],
    ['CAP_REACHED', (s) => (s.capReached = true), (s) => (s.capReached = false)],
    ['SERVICE_UNAVAILABLE', (s) => (s.breakerOpen = true), (s) => (s.breakerOpen = false)]
  ];

  for (const [reason, block, unblock] of CASES) {
    it(`stalls with ${reason} and resumes when it clears`, async () => {
      await running();
      block(h.state);
      finishTrack();
      await settle();
      expect(h.engine.getState()).toMatchObject({ status: 'stalled', reason });
      expect(h.deps.onChange).toHaveBeenCalledTimes(1);
      expect(upcomingPicks()).toBe(4);

      unblock(h.state);
      h.engine.poke();
      await settle();
      expect(h.engine.getState()).toMatchObject({ status: 'running', reason: null });
      expect(upcomingPicks()).toBe(5);
    });
  }

  it('stalls with THEME_EXHAUSTED when no pick can be added, and resumes later', async () => {
    await running();
    resolveSpotifyTrack.mockResolvedValue(null);
    finishTrack();
    await settle();
    expect(h.engine.getState()).toMatchObject({ status: 'stalled', reason: 'THEME_EXHAUSTED' });

    resolveAll();
    finishTrack();
    await settle();
    expect(h.engine.getState()).toMatchObject({ status: 'running', reason: null });
  });

  it('an LLM outage mid-session stalls with SERVICE_UNAVAILABLE', async () => {
    await running();
    chatJson.mockRejectedValueOnce(new Error('timeout'));
    finishTrack();
    await settle();
    expect(h.engine.getState()).toMatchObject({ status: 'stalled', reason: 'SERVICE_UNAVAILABLE' });
  });

  it('retries a stall on its own after a minute, even with no events', async () => {
    await running();
    h.state.users = [];
    finishTrack();
    await settle();
    expect(h.engine.getState().reason).toBe('NO_LISTENERS');
    h.state.users = [{ id: 'A' }];
    await settle(61_000);
    expect(h.engine.getState().status).toBe('running');
  });
});

describe('themeEngine: debounce and one top-up in flight', () => {
  it('a burst of events within 1 s triggers one top-up', async () => {
    h = setup({ lookahead: 5 });
    h.queue.add({ title: 'm0', url: 'https://yt/m0' });
    await startTheme();
    await settle();
    chatJson.mockClear();

    finishTrack();
    for (let i = 0; i < 5; i++) {
      h.engine.onQueueUpdate({ tracks: h.queue.getAll() });
      await vi.advanceTimersByTimeAsync(200);
    }
    expect(chatJson).not.toHaveBeenCalled();
    await settle();
    expect(chatJson).toHaveBeenCalledTimes(1);
  });

  it('keeps one top-up in flight; a trigger meanwhile runs once more after it', async () => {
    h = setup({ lookahead: 5 });
    h.queue.add({ title: 'm0', url: 'https://yt/m0' });
    await startTheme();
    await settle();

    let release;
    chatJson.mockClear();
    chatJson.mockImplementationOnce(
      ({ user }) =>
        new Promise((r) => {
          release = () =>
            r({ picks: Array.from({ length: user.count }, () => song(++songCounter)) });
        })
    );
    finishTrack();
    await settle();
    expect(chatJson).toHaveBeenCalledTimes(1);

    finishTrack();
    await settle();
    expect(chatJson).toHaveBeenCalledTimes(1); // still in flight

    release();
    await settle(2500);
    expect(chatJson).toHaveBeenCalledTimes(2);
    expect(upcomingPicks()).toBe(5);
  });
});

describe('themeEngine: first pick early (SC-005)', () => {
  it('start() resolves when the first pick is queued; the rest keep resolving', async () => {
    h = setup({ lookahead: 5 });
    const resolvers = [];
    resolveSpotifyTrack.mockImplementation(
      ({ title, artists }) =>
        new Promise((r) =>
          resolvers.push(() => r({ url: urlOf({ artist: artists[0], title }), title }))
        )
    );

    let started = false;
    const p = startTheme().then(() => (started = true));
    await settle(0);
    expect(resolvers.length).toBe(9);

    resolvers[3]();
    await settle(0);
    expect(started).toBe(true);
    expect(h.queue.length).toBe(1);
    expect(h.deps.onPicksAdded).toHaveBeenCalledTimes(1);

    resolvers.forEach((r) => r());
    await settle(0);
    await p;
    expect(h.queue.length).toBe(5);
  });
});

describe('themeEngine: session end while picks resolve (FR-024b, T061b)', () => {
  function slowResolver() {
    const resolvers = [];
    resolveSpotifyTrack.mockImplementation(
      ({ title, artists }) =>
        new Promise((r) =>
          resolvers.push(() => r({ url: urlOf({ artist: artists[0], title }), title }))
        )
    );
    return resolvers;
  }

  it('picks resolving after stop are not added and not counted', async () => {
    h = setup({ lookahead: 5 });
    const resolvers = slowResolver();
    const p = startTheme();
    await settle(0);
    resolvers[0]();
    await p;
    expect(h.queue.length).toBe(1);
    h.deps.recordUsage.mockClear();

    h.engine.stop();
    resolvers.forEach((r) => r());
    await settle();

    expect(h.queue.length).toBe(1);
    expect(h.deps.recordUsage).not.toHaveBeenCalled();
  });

  it('a new session started straight after does not receive the old session’s late picks', async () => {
    h = setup({ lookahead: 5 });
    const oldResolvers = slowResolver();
    const first = startTheme('old theme');
    await settle(0);
    oldResolvers[0]();
    await first;

    h.engine.stop();
    h.queue.clear();
    resolveAll();
    await startTheme('new theme');
    await settle();
    const before = h.queue.getAll().map((t) => t.title);

    oldResolvers.forEach((r) => r());
    await settle();
    expect(h.queue.getAll().map((t) => t.title)).toEqual(before);
    expect(upcomingPicks()).toBe(5);
  });

  it('stop before the first pick lands resolves start() instead of NO_TRACKS_FOR_THEME', async () => {
    h = setup({ lookahead: 5 });
    const resolvers = slowResolver();
    const p = startTheme();
    await settle(0);

    h.engine.stop();
    resolvers.forEach((r) => r());
    await expect(p).resolves.toBeUndefined();
    expect(h.engine.session).toBeNull();
    expect(h.queue.length).toBe(0);
  });

  it('after stop, a queue:update with an empty queue triggers no top-up', async () => {
    h = setup({ lookahead: 5 });
    await startTheme();
    await settle();
    chatJson.mockClear();

    h.engine.stop();
    h.queue.clear();
    h.engine.onQueueUpdate({ tracks: [], currentIndex: 0 });
    h.engine.onTrackChange(null);
    await settle(70_000);
    expect(chatJson).not.toHaveBeenCalled();
    expect(h.queue.length).toBe(0);
  });
});

describe('themeEngine: theme change (US4/AC7)', () => {
  it('new picks use the new theme, old picks stay, usedKeys are kept, intro is pending', async () => {
    h = setup({ lookahead: 5 });
    h.queue.add({ title: 'm0', url: 'https://yt/m0' });
    await startTheme('old theme');
    await settle();
    const oldPicks = h.queue.getAll().slice(1);
    const usedBefore = new Set(h.engine.session.usedKeys);
    h.engine.session.introPending = false;

    h.engine.changeTheme('rainy day lo-fi');
    expect(h.engine.session.introPending).toBe(true);
    expect(h.engine.getState().theme).toBe('rainy day lo-fi');
    for (const k of usedBefore) expect(h.engine.session.usedKeys.has(k)).toBe(true);

    chatJson.mockClear();
    finishTrack();
    await settle();
    expect(chatJson.mock.calls[0][0].user.theme).toBe('rainy day lo-fi');
    const urls = (tracks) => tracks.map((t) => t.url);
    // m0 played; the old picks are all still queued, in order, ahead of the new ones.
    expect(urls(h.queue.getAll().slice(1, 6))).toEqual(urls(oldPicks));
  });

  it('picks from the old theme still resolving when the theme changes are dropped', async () => {
    h = setup({ lookahead: 5 });
    h.queue.add({ title: 'm0', url: 'https://yt/m0' });
    await startTheme('old');
    await settle();
    const resolvers = [];
    resolveSpotifyTrack.mockImplementation(
      ({ title, artists }) =>
        new Promise((r) =>
          resolvers.push(() => r({ url: urlOf({ artist: artists[0], title }), title }))
        )
    );
    finishTrack();
    await settle();
    expect(resolvers.length).toBeGreaterThan(0);

    h.engine.changeTheme('new');
    const length = h.queue.length;
    resolvers.forEach((r) => r());
    await settle(0);
    expect(h.queue.length).toBe(length);
  });
});

describe('themeEngine: ThemeState (contracts §1)', () => {
  it('reports theme, startedBy, startedAt, status and reason', async () => {
    h = setup();
    await startTheme('90s eurodance');
    expect(h.engine.getState()).toEqual({
      theme: '90s eurodance',
      startedBy: { id: 'A', name: 'Alice' },
      startedAt: expect.any(String),
      status: 'running',
      reason: null
    });
  });
});
