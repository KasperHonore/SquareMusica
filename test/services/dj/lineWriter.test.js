import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../../src/integrations/llm.js', () => ({ chatJson: vi.fn() }));
vi.mock('../../../src/integrations/elevenlabs.js', () => ({ synthesize: vi.fn() }));

import { chatJson } from '../../../src/integrations/llm.js';
import { synthesize } from '../../../src/integrations/elevenlabs.js';
import { writeLine, SYSTEM_PROMPT } from '../../../src/services/dj/lineWriter.js';
import { buildContext } from '../../../src/services/dj/context.js';

const PCM = Buffer.alloc(3840);

const previous = { title: 'Mr. Brightside', url: 'https://y/prev', channel: 'The Killers' };
const next = { title: 'Dancing Queen', url: 'https://y/next', channel: 'ABBA' };

function ctxWith(extraFacts = []) {
  const ctx = buildContext({ previous, next });
  ctx.facts.push(...extraFacts);
  return ctx;
}

function reply(line, factIds = ['f1']) {
  chatJson.mockResolvedValueOnce({ line, factIds });
}

beforeEach(() => {
  vi.clearAllMocks();
  synthesize.mockResolvedValue(PCM);
});

describe('writeLine accepts', () => {
  it('a 1–2 sentence line ≤ 240 characters whose factIds all exist', async () => {
    reply('That was Mr. Brightside. Up next, ABBA with Dancing Queen!', ['f1', 'f2']);
    const line = await writeLine(ctxWith());
    expect(line).toMatchObject({
      forKey: 'https://y/next',
      text: 'That was Mr. Brightside. Up next, ABBA with Dancing Queen!',
      pcm: PCM,
      factIds: ['f1', 'f2'],
      namedUserIds: []
    });
    expect(typeof line.preparedAt).toBe('number');
    expect(synthesize).toHaveBeenCalledWith(
      'That was Mr. Brightside. Up next, ABBA with Dancing Queen!'
    );
  });

  it.each(["Hey Kasper, this one's for you.", "Here's one more classic."])(
    'number words used as ordinary words with no numeric facts: %s',
    async (text) => {
      reply(text, ['f2']);
      await expect(writeLine(ctxWith())).resolves.toMatchObject({ text });
    }
  );

  it('a quantity that equals a numeric value in a cited fact', async () => {
    const facts = [{ id: 'm1', kind: 'member', text: 'Kasper has played this track 7 times.' }];
    reply('Kasper has spun this one seven times already. Here it is again!', ['f2', 'm1']);
    await expect(writeLine(ctxWith(facts))).resolves.toBeTruthy();
  });
});

describe('writeLine rejects, and never calls synthesize', () => {
  const facts = [{ id: 'm1', kind: 'member', text: 'Kasper has played this track 7 times.' }];

  it.each([
    ['three sentences', 'One. Two. Three.', ['f1']],
    ['more than 240 characters', `${'a'.repeat(241)}.`, ['f1']],
    ['an unknown fact id', 'Here comes ABBA.', ['f9']],
    ['a quantity in digits not in a cited fact', 'Played 12 times this week!', ['f2', 'm1']],
    ['a number word + count noun not in a cited fact', 'Kasper played this twelve times.', ['m1']],
    ['a quantity whose fact is not cited', 'Kasper played this seven times.', ['f2']],
    ['a blocked content term', 'Up next, a song for every retard in here.', ['f2']]
  ])('%s', async (_name, text, factIds) => {
    reply(text, factIds);
    await expect(writeLine(ctxWith(facts))).rejects.toMatchObject({ kind: 'validation' });
    expect(synthesize).not.toHaveBeenCalled();
  });

  it('a line that cites no track fact (US1/AC1)', async () => {
    reply("Let's keep the party going!", []);
    await expect(writeLine(ctxWith())).rejects.toMatchObject({ kind: 'validation' });
    reply("Let's keep the party going!", ['m1']);
    await expect(writeLine(ctxWith(facts))).rejects.toMatchObject({ kind: 'validation' });
    expect(synthesize).not.toHaveBeenCalled();
  });

  it('an exact repeat of any of the last 20 spoken lines', async () => {
    const recent = Array.from({ length: 20 }, (_, i) => `Line number ${i}.`);
    recent[0] = 'Here comes ABBA.';
    reply('Here comes ABBA.', ['f2']);
    await expect(writeLine(ctxWith(), recent)).rejects.toMatchObject({ kind: 'validation' });
    expect(synthesize).not.toHaveBeenCalled();
  });

  it('malformed JSON from the model', async () => {
    const err = Object.assign(new Error('LLM content is not valid JSON'), { kind: 'malformed' });
    chatJson.mockRejectedValueOnce(err);
    await expect(writeLine(ctxWith())).rejects.toMatchObject({ kind: 'llm' });
    expect(synthesize).not.toHaveBeenCalled();
  });

  it('a response with the wrong shape', async () => {
    chatJson.mockResolvedValueOnce({ text: 'nope' });
    await expect(writeLine(ctxWith())).rejects.toMatchObject({ kind: 'validation' });
    expect(synthesize).not.toHaveBeenCalled();
  });
});

describe('content filter and track names', () => {
  it('accepts a real title containing a blocked word, but not the word outside it', async () => {
    const ctx = buildContext({ previous, next: { title: 'Gypsy', url: 'u', channel: 'Shakira' } });
    reply('Here is Gypsy by Shakira!', ['f2']);
    await expect(writeLine(ctx)).resolves.toMatchObject({ text: 'Here is Gypsy by Shakira!' });
    reply('Here is Gypsy by Shakira, for every gypsy out there!', ['f2']);
    await expect(writeLine(ctx)).rejects.toMatchObject({ kind: 'validation' });
  });

  it('the system prompt requires mentioning the next or previous track', () => {
    expect(SYSTEM_PROMPT).toMatch(/must mention the next track or the previous track/);
  });
});

describe('writeLine prompt and errors', () => {
  it('sends only the last 5 spoken lines as recentLines', async () => {
    const recent = Array.from({ length: 12 }, (_, i) => `Old line ${i}.`);
    reply('Here comes ABBA.', ['f2']);
    await writeLine(ctxWith(), recent);
    const { user, temperature, timeoutMs } = chatJson.mock.calls[0][0];
    const payload = JSON.parse(user);
    expect(payload.recentLines).toEqual(recent.slice(-5));
    expect(payload).toHaveProperty('next');
    expect(payload).toHaveProperty('previous');
    expect(payload.allowedNames).toEqual([]);
    expect(temperature).toBe(0.9);
    expect(timeoutMs).toBe(10000);
  });

  it('maps a TTS quota error to kind quota and other TTS errors to tts', async () => {
    reply('Here comes ABBA.', ['f2']);
    synthesize.mockRejectedValueOnce(Object.assign(new Error('quota'), { kind: 'quota' }));
    await expect(writeLine(ctxWith())).rejects.toMatchObject({ kind: 'quota' });

    reply('Here comes ABBA.', ['f2']);
    synthesize.mockRejectedValueOnce(Object.assign(new Error('slow'), { kind: 'network' }));
    await expect(writeLine(ctxWith())).rejects.toMatchObject({ kind: 'tts' });
  });
});

describe('shout-outs: forbidden names and allowed members (R6 step 3, SC-003)', () => {
  let store;
  const A = { id: 'A', username: 'anna_u', displayName: 'Anna' };
  const B = { id: 'B', username: 'bob_u', displayName: 'Bob' };
  const C = { id: 'C', username: 'carl_u', displayName: 'Carl' };

  function plays(userId, name, url, n) {
    for (let i = 0; i < n; i++) {
      store.addToHistory({ title: 'Song', url, requestedBy: name, requestedById: userId });
    }
  }

  beforeEach(async () => {
    const { DatabaseManager } = await import('../../../src/persistence/db.js');
    store = new DatabaseManager(':memory:');
  });

  afterEach(() => store.close());

  it('accepts a line naming an allowed member and records namedUserIds', async () => {
    plays('A', 'Anna', next.url, 3);
    const ctx = buildContext({ previous, next, present: [A, B], store });
    const fact = ctx.facts.find((f) => f.kind === 'member');
    reply('Anna, you have played Dancing Queen three times, here it is!', ['f2', fact.id]);
    const line = await writeLine(ctx);
    expect(line.namedUserIds).toEqual(['A']);
    expect(JSON.parse(chatJson.mock.calls[0][0].user).allowedNames).toEqual(['Anna']);
  });

  it('rejects a known DJ name that is not in allowedNames', async () => {
    plays('Z', 'Zed', 'https://y/z', 1);
    const ctx = buildContext({ previous, next, present: [A], store });
    reply('Zed would love Dancing Queen!', ['f2']);
    await expect(writeLine(ctx)).rejects.toMatchObject({ kind: 'validation' });
    expect(synthesize).not.toHaveBeenCalled();
  });

  it('rejects a line naming an opted-out present member', async () => {
    plays('A', 'Anna', next.url, 5);
    store.setShoutoutOptOut('A', true);
    const ctx = buildContext({ previous, next, present: [A, B], store });
    reply('This one is for Anna: Dancing Queen!', ['f2']);
    await expect(writeLine(ctx)).rejects.toMatchObject({ kind: 'validation' });
    reply('This one is for ANNA_U: Dancing Queen!', ['f2']);
    await expect(writeLine(ctx)).rejects.toMatchObject({ kind: 'validation' });
    expect(synthesize).not.toHaveBeenCalled();
  });

  it('with no qualifying member facts a general music line is still accepted (US3/AC4)', async () => {
    plays('A', 'Anna', next.url, 2);
    const ctx = buildContext({ previous, next, present: [A, B], store });
    expect(ctx.facts.some((f) => f.kind === 'member')).toBe(false);
    expect(ctx.allowedNames).toEqual([]);
    reply('Up next, ABBA with Dancing Queen!', ['f2']);
    await expect(writeLine(ctx)).resolves.toMatchObject({ namedUserIds: [] });
  });

  describe('queuer C of the next track', () => {
    const queuedByC = { ...next, requestedBy: 'carl_u', requestedById: 'C' };

    it('has left and has no history: no queuedBy, and naming C is rejected', async () => {
      const ctx = buildContext({ previous, next: queuedByC, present: [A], store });
      expect(ctx.next.queuedBy).toBeUndefined();
      reply('Shout out to carl_u for Dancing Queen!', ['f2']);
      await expect(writeLine(ctx)).rejects.toMatchObject({ kind: 'validation' });
    });

    it('is present but opted out: no queuedBy, and naming C is rejected', async () => {
      store.setShoutoutOptOut('C', true);
      const ctx = buildContext({ previous, next: queuedByC, present: [A, C], store });
      expect(ctx.next.queuedBy).toBeUndefined();
      reply('Carl picked Dancing Queen!', ['f2']);
      await expect(writeLine(ctx)).rejects.toMatchObject({ kind: 'validation' });
    });

    it('is present and opted in: queuedBy is the speakable name and C is allowed', async () => {
      const ctx = buildContext({ previous, next: queuedByC, present: [A, C], store });
      expect(ctx.next.queuedBy).toBe('Carl');
      expect(ctx.allowedNames).toEqual(['Carl']);
      reply('Carl picked Dancing Queen, let us go!', ['f2']);
      await expect(writeLine(ctx)).resolves.toMatchObject({ namedUserIds: ['C'] });
      const payload = JSON.parse(chatJson.mock.calls.at(-1)[0].user);
      expect(payload.next.queuedBy).toBe('Carl');
      expect(payload.allowedNames).toEqual(['Carl']);
    });
  });

  describe('history stores usernames, the DJ says display names (US3/AC2)', () => {
    it('a member who was named and then left is forbidden by display name', async () => {
      plays('B', 'bob_u', next.url, 3); // requested_by is the Discord username
      const before = buildContext({ previous, next, present: [A, B], store });
      expect(before.allowedNames).toContain('Bob');

      const after = buildContext({ previous, next, present: [A], store });
      expect(after.allowedNames).not.toContain('Bob');
      reply("Bob, this one's for you: Dancing Queen!", ['f2']);
      await expect(writeLine(after, ['Bob, here is Dancing Queen again!'])).rejects.toMatchObject({
        kind: 'validation'
      });
      expect(synthesize).not.toHaveBeenCalled();
    });
  });

  describe('a claim must be about the member the cited fact is about (US3/AC1)', () => {
    const queuedByC = { ...next, requestedBy: 'carl_u', requestedById: 'C' };

    function ctxAnnaPlaysCarlQueued() {
      plays('A', 'anna_u', next.url, 3);
      const ctx = buildContext({ previous, next: queuedByC, present: [A, C], store });
      expect(ctx.allowedNames.sort()).toEqual(['Anna', 'Carl']);
      return { ctx, annaFact: ctx.facts.find((f) => f.kind === 'member' && f.userId === 'A') };
    }

    it("rejects Anna's play count attributed to Carl", async () => {
      const { ctx, annaFact } = ctxAnnaPlaysCarlQueued();
      reply('Carl has played Dancing Queen three times!', ['f2', annaFact.id]);
      await expect(writeLine(ctx)).rejects.toMatchObject({ kind: 'validation' });
    });

    it('rejects a play-history claim without a number about a queuer-only member', async () => {
      const { ctx } = ctxAnnaPlaysCarlQueued();
      reply('Carl plays Dancing Queen constantly!', ['f2']);
      await expect(writeLine(ctx)).rejects.toMatchObject({ kind: 'validation' });
      expect(synthesize).not.toHaveBeenCalled();
    });

    it('rejects a queue claim about a member who did not queue the track', async () => {
      const { ctx, annaFact } = ctxAnnaPlaysCarlQueued();
      reply('Anna queued Dancing Queen!', ['f2', annaFact.id]);
      await expect(writeLine(ctx)).rejects.toMatchObject({ kind: 'validation' });
    });

    it('accepts each claim attributed to the right member', async () => {
      const { ctx, annaFact } = ctxAnnaPlaysCarlQueued();
      reply('Carl queued Dancing Queen. Anna has played it three times!', ['f2', annaFact.id]);
      const line = await writeLine(ctx);
      expect(line.namedUserIds.sort()).toEqual(['A', 'C']);
    });
  });

  describe('a lowercase display name (Discord falls back to the username)', () => {
    const a = { id: 'A', username: 'anna', displayName: 'anna' };
    const k = { id: 'K', username: 'kasper', displayName: 'kasper' };

    it('rejects an opted-out present member named at the start of a sentence (US3/AC3)', async () => {
      plays('A', 'anna', next.url, 5);
      store.setShoutoutOptOut('A', true);
      const ctx = buildContext({ previous, next, present: [a, B], store });
      expect(ctx.lenientNames).not.toContain('anna');
      for (const line of [
        'Anna, this one is for you: Dancing Queen!',
        'Here we go. Anna, this is Dancing Queen!',
        'This one is for anna: Dancing Queen!'
      ]) {
        reply(line, ['f2']);
        await expect(writeLine(ctx)).rejects.toMatchObject({ kind: 'validation' });
      }
      expect(synthesize).not.toHaveBeenCalled();
    });

    it('rejects an absent member seen in voice named at the start of a sentence (US3/AC2)', async () => {
      buildContext({ previous, next, present: [k, B], store });
      const ctx = buildContext({ previous, next, present: [B], store });
      reply("Kasper, this one's for you: Dancing Queen!", ['f2']);
      await expect(writeLine(ctx)).rejects.toMatchObject({ kind: 'validation' });
    });

    it('rejects an absent queuer from history whose username is used as a name', async () => {
      plays('K', 'kasper', 'https://y/k', 1);
      const ctx = buildContext({ previous, next, present: [B], store });
      expect(ctx.lenientNames).toContain('kasper');
      reply('This one goes out to Kasper: Dancing Queen!', ['f2']);
      await expect(writeLine(ctx)).rejects.toMatchObject({ kind: 'validation' });
    });
  });

  describe('no invented connection with the listeners (US3/AC4)', () => {
    it.each([
      'Dancing Queen is a room favourite, here it is!',
      'You all love this one: Dancing Queen!',
      'Everyone here has played it, Dancing Queen!'
    ])('rejects %j without a member or group fact', async (line) => {
      const ctx = buildContext({ previous, next, present: [A, B], store });
      reply(line, ['f2']);
      await expect(writeLine(ctx)).rejects.toMatchObject({ kind: 'validation' });
      expect(synthesize).not.toHaveBeenCalled();
    });

    it('accepts a plain music line that mentions what just played', async () => {
      const ctx = buildContext({ previous, next, present: [A, B], store });
      reply('We just played Mr. Brightside, now ABBA with Dancing Queen!', ['f1', 'f2']);
      await expect(writeLine(ctx)).resolves.toBeTruthy();
    });

    it('accepts a room-level claim backed by a cited group fact', async () => {
      plays('A', 'anna_u', next.url, 2);
      plays('B', 'bob_u', next.url, 2);
      const ctx = buildContext({ previous, next, present: [A, B], store });
      const group = ctx.facts.find((f) => f.kind === 'group');
      reply('A room favourite, played four times by people here: Dancing Queen!', ['f2', group.id]);
      await expect(writeLine(ctx)).resolves.toBeTruthy();
    });
  });

  it("rejects another member's count carried to a named member by pronoun (US3/AC1)", async () => {
    plays('A', 'anna_u', next.url, 3);
    plays('B', 'bob_u', next.url, 5);
    const ctx = buildContext({ previous, next, present: [A, B], store });
    const bobFact = ctx.facts.find((f) => f.kind === 'member' && f.userId === 'B');
    reply('Anna is here for Dancing Queen. She has played it five times!', ['f2', bobFact.id]);
    await expect(writeLine(ctx)).rejects.toMatchObject({ kind: 'validation' });
    reply('Bob is here for Dancing Queen. He has played it five times!', ['f2', bobFact.id]);
    await expect(writeLine(ctx)).resolves.toMatchObject({ namedUserIds: ['B'] });
  });

  describe('a username that is also an ordinary word', () => {
    it('blocks it as a name but not as a word', async () => {
      plays('P', 'party', 'https://y/p', 1);
      const ctx = buildContext({ previous, next, present: [A], store });
      expect(ctx.forbiddenNames).toContain('party');

      reply("Let's party, here comes Dancing Queen!", ['f2']);
      await expect(writeLine(ctx)).resolves.toBeTruthy();
      reply('Party time, here comes Dancing Queen!', ['f2']);
      await expect(writeLine(ctx)).resolves.toBeTruthy();
      reply('This one goes out to Party: Dancing Queen!', ['f2']);
      await expect(writeLine(ctx)).rejects.toMatchObject({ kind: 'validation' });
    });
  });
});

describe('themed intro (FR-028)', () => {
  const introCtx = () => buildContext({ previous: null, next, theme: 'classic rock', intro: true });

  it('uses the intro prompt and accepts a line citing the theme fact', async () => {
    const ctx = introCtx();
    const themeFact = ctx.facts.find((f) => f.kind === 'theme');
    reply('Buckle up for a classic rock road trip! First up, Dancing Queen.', [themeFact.id]);
    await expect(writeLine(ctx)).resolves.toMatchObject({ forKey: 'https://y/next' });
    const call = chatJson.mock.calls[0][0];
    expect(call.system).not.toBe(SYSTEM_PROMPT);
    expect(call.system).toMatch(/theme/i);
    expect(JSON.parse(call.user)).toMatchObject({ theme: 'classic rock', intro: true });
  });

  it('rejects an intro that does not cite the theme fact', async () => {
    reply('Up next, Dancing Queen!', ['f1']);
    await expect(writeLine(introCtx())).rejects.toMatchObject({ kind: 'validation' });
  });

  it('an ordinary line still needs a track fact', async () => {
    const ctx = buildContext({ previous, next, theme: 'classic rock' });
    const themeFact = ctx.facts.find((f) => f.kind === 'theme');
    reply('What a theme tonight!', [themeFact.id]);
    await expect(writeLine(ctx)).rejects.toMatchObject({ kind: 'validation' });
  });
});
