import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../../src/integrations/llm.js', () => ({ chatJson: vi.fn() }));
vi.mock('../../../src/integrations/elevenlabs.js', () => ({ synthesize: vi.fn() }));

import { chatJson } from '../../../src/integrations/llm.js';
import { synthesize } from '../../../src/integrations/elevenlabs.js';
import { writeLine, LineError, extractQuantities } from '../../../src/services/dj/lineWriter.js';
import { buildContext } from '../../../src/services/dj/context.js';

const PCM = Buffer.alloc(16);

const next = { title: 'Sandstorm', url: 'https://yt/next', channel: 'Darude' };
const previous = { title: 'Blue', url: 'https://yt/prev', channel: 'Eiffel 65' };

function ctxWith(extraFacts = []) {
  const ctx = buildContext({ previous, next });
  return { ...ctx, facts: [...ctx.facts, ...extraFacts] };
}

function answer(line, factIds = ['f1']) {
  chatJson.mockResolvedValueOnce({ line, factIds });
}

beforeEach(() => {
  chatJson.mockReset();
  synthesize.mockReset();
  synthesize.mockResolvedValue(PCM);
});

async function expectRejected(ctx, recent = []) {
  const err = await writeLine(ctx, recent).catch((e) => e);
  expect(err).toBeInstanceOf(LineError);
  expect(err.kind).toBe('validation');
  expect(synthesize).not.toHaveBeenCalled();
  return err;
}

describe('lineWriter: accepted lines', () => {
  it('accepts a 1–2 sentence line ≤ 240 chars citing existing facts and voices it', async () => {
    answer('That was Blue. Here comes Sandstorm by Darude!', ['f1', 'f2']);
    const line = await writeLine(ctxWith());
    expect(line).toMatchObject({
      forKey: 'https://yt/next',
      text: 'That was Blue. Here comes Sandstorm by Darude!',
      pcm: PCM,
      factIds: ['f1', 'f2'],
      namedUserIds: []
    });
    expect(typeof line.preparedAt).toBe('number');
    expect(synthesize).toHaveBeenCalledWith('That was Blue. Here comes Sandstorm by Darude!');
  });

  it('accepts number words used as ordinary words with no numeric facts', async () => {
    answer("Hey Kasper, this one's for you.");
    await expect(writeLine(ctxWith())).resolves.toBeTruthy();
    answer("Here's one more classic.");
    await expect(writeLine(ctxWith())).resolves.toBeTruthy();
  });

  it('accepts a quantity that equals a numeric value in a cited fact', async () => {
    const ctx = ctxWith([
      { id: 'f9', kind: 'member', text: 'Kasper has played this track 7 times.' }
    ]);
    answer('Kasper has spun this seven times already!', ['f1', 'f9']);
    // "seven times" is a quantity and 7 is in f9.
    await expect(writeLine(ctx)).resolves.toBeTruthy();
  });

  it('calls the LLM with temperature 0.9 and a 10 s timeout', async () => {
    answer('Here comes Sandstorm.');
    await writeLine(ctxWith());
    expect(chatJson).toHaveBeenCalledWith(
      expect.objectContaining({ temperature: 0.9, timeoutMs: 10000 })
    );
    const { system } = chatJson.mock.calls[0][0];
    expect(system).toMatch(/ONE or TWO/);
    expect(system).toMatch(/Spell numbers as words/);
    expect(system).toMatch(/slurs/);
  });
});

describe('lineWriter: rejected lines never reach TTS', () => {
  it('rejects three sentences', async () => {
    answer('One. Two. Three.');
    await expectRejected(ctxWith());
  });

  it('rejects more than 240 characters', async () => {
    answer(`${'a'.repeat(241)}.`);
    await expectRejected(ctxWith());
  });

  it('rejects an unknown fact id', async () => {
    answer('Here comes Sandstorm.', ['f1', 'f42']);
    await expectRejected(ctxWith());
  });

  it('rejects an exact repeat of any of the last 20 spoken lines', async () => {
    const recent = Array.from({ length: 20 }, (_, i) => `Line number ${i}.`);
    recent[0] = 'Here comes Sandstorm.';
    answer('Here comes Sandstorm.');
    await expectRejected(ctxWith(), recent);
  });

  it('rejects malformed JSON from the model', async () => {
    chatJson.mockRejectedValueOnce(new SyntaxError('Unexpected token'));
    await expectRejected(ctxWith());
  });

  it('rejects an answer with no line', async () => {
    chatJson.mockResolvedValueOnce({ text: 'nope' });
    await expectRejected(ctxWith());
  });

  it('rejects digits not in a cited fact (FR-005)', async () => {
    answer('Kasper has played this 12 times.');
    await expectRejected(ctxWith());
  });

  it('rejects a number word + count noun not in a cited fact (FR-005)', async () => {
    const ctx = ctxWith([
      { id: 'f9', kind: 'member', text: 'Kasper has played this track 7 times.' }
    ]);
    answer('Kasper has played this twelve times!', ['f9']);
    await expectRejected(ctx);
  });

  it('rejects a quantity backed only by an uncited fact', async () => {
    const ctx = ctxWith([
      { id: 'f9', kind: 'member', text: 'Kasper has played this track 7 times.' }
    ]);
    answer('Seven plays and counting!', ['f1']);
    await expectRejected(ctx);
  });

  it('rejects a line containing a content-filter term', async () => {
    answer("Turn it up, you retard, it's Sandstorm.");
    await expectRejected(ctxWith());
  });
});

describe('lineWriter: prompt', () => {
  it('passes only the last 5 lines as recentLines', async () => {
    const recent = Array.from({ length: 12 }, (_, i) => `Old line ${i}.`);
    answer('Here comes Sandstorm.');
    await writeLine(ctxWith(), recent);
    const { user } = chatJson.mock.calls[0][0];
    expect(user.recentLines).toEqual(recent.slice(-5));
    expect(user).toEqual(
      expect.objectContaining({
        next: expect.objectContaining({ title: 'Sandstorm', artist: 'Darude' }),
        previous: expect.objectContaining({ title: 'Blue', artist: 'Eiffel 65' }),
        theme: null,
        allowedNames: [],
        facts: expect.any(Array)
      })
    );
  });

  it('surfaces a TTS failure with the TTS error kind', async () => {
    answer('Here comes Sandstorm.');
    synthesize.mockRejectedValueOnce(Object.assign(new Error('quota'), { kind: 'quota' }));
    const err = await writeLine(ctxWith()).catch((e) => e);
    expect(err.kind).toBe('quota');
  });

  it('surfaces an LLM outage as kind llm', async () => {
    chatJson.mockRejectedValueOnce(new Error('LLM request failed with status 502'));
    const err = await writeLine(ctxWith()).catch((e) => e);
    expect(err.kind).toBe('llm');
    expect(synthesize).not.toHaveBeenCalled();
  });
});

describe('extractQuantities', () => {
  it('finds digits and number-word quantities but not ordinary number words', () => {
    expect(extractQuantities('twenty-one spins and 3 plays')).toEqual([3, 21]);
    expect(extractQuantities("one more, this one's for you")).toEqual([]);
    expect(extractQuantities('three of you are here')).toEqual([3]);
  });
});
