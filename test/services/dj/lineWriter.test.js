import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../../src/integrations/llm.js', () => ({ chatJson: vi.fn() }));
vi.mock('../../../src/integrations/elevenlabs.js', () => ({ synthesize: vi.fn() }));

import { chatJson } from '../../../src/integrations/llm.js';
import { synthesize } from '../../../src/integrations/elevenlabs.js';
import { writeLine, LineError } from '../../../src/services/dj/lineWriter.js';
import { buildContext } from '../../../src/services/dj/context.js';
import { BLOCKED_TERMS } from '../../../src/services/dj/contentFilter.js';

const PCM = Buffer.alloc(3840);

function baseCtx() {
  const ctx = buildContext({
    previous: { title: 'Old Song', url: 'https://yt/old', channel: 'Old Band' },
    next: { title: 'New Song', url: 'https://yt/new', channel: 'New Band' }
  });
  return ctx;
}

// A context with a numeric fact, the shape US3 member facts take.
function ctxWithCount() {
  const ctx = baseCtx();
  ctx.facts.push({ id: 'f9', kind: 'member', text: 'Kasper has played this track 7 times.' });
  return ctx;
}

function modelSays(line, factIds = ['f1']) {
  chatJson.mockResolvedValueOnce({ line, factIds });
}

async function expectRejected(ctx, recent = []) {
  const error = await writeLine(ctx, recent).catch((e) => e);
  expect(error).toBeInstanceOf(LineError);
  expect(error.kind).toBe('validation');
  expect(synthesize).not.toHaveBeenCalled();
}

beforeEach(() => {
  chatJson.mockReset();
  synthesize.mockReset();
  synthesize.mockResolvedValue(PCM);
});

describe('writeLine: accepted lines', () => {
  it('accepts a one-sentence line citing existing facts and voices it', async () => {
    modelSays('Coming up, New Song by New Band!', ['f1']);
    const line = await writeLine(baseCtx(), []);

    expect(line).toMatchObject({
      forKey: 'https://yt/new',
      text: 'Coming up, New Song by New Band!',
      pcm: PCM,
      factIds: ['f1'],
      namedUserIds: []
    });
    expect(typeof line.preparedAt).toBe('number');
    expect(synthesize).toHaveBeenCalledWith('Coming up, New Song by New Band!');
  });

  it('accepts two sentences', async () => {
    modelSays('That was Old Song. Now here is New Song!', ['f1', 'f2']);
    await expect(writeLine(baseCtx(), [])).resolves.toMatchObject({ factIds: ['f1', 'f2'] });
  });

  it('accepts exactly 240 characters', async () => {
    const text = `${'a'.repeat(239)}.`;
    modelSays(text);
    await expect(writeLine(baseCtx(), [])).resolves.toMatchObject({ text });
  });

  it.each(["Hey Kasper, this one's for you.", "Here's one more classic."])(
    'treats ordinary number words as words, not quantities: %s',
    async (text) => {
      modelSays(text);
      await expect(writeLine(baseCtx(), [])).resolves.toMatchObject({ text });
    }
  );

  it('accepts a quantity that matches a cited fact, as words or digits', async () => {
    modelSays('Kasper has spun this seven times already.', ['f9']);
    await expect(writeLine(ctxWithCount(), [])).resolves.toBeDefined();
    modelSays('Kasper has spun this 7 times already.', ['f9']);
    await expect(writeLine(ctxWithCount(), [])).resolves.toBeDefined();
  });
});

describe('writeLine: rejected lines never reach TTS', () => {
  it('rejects three sentences', async () => {
    modelSays('One. Two. Three.');
    await expectRejected(baseCtx());
  });

  it('rejects more than 240 characters', async () => {
    modelSays(`${'a'.repeat(240)}.`);
    await expectRejected(baseCtx());
  });

  it('rejects an unknown fact id', async () => {
    modelSays('Here is New Song.', ['f1', 'f42']);
    await expectRejected(baseCtx());
  });

  it('rejects an exact repeat of any of the last 20 spoken lines', async () => {
    const recent = Array.from({ length: 20 }, (_, i) => `Line ${String.fromCharCode(97 + i)}.`);
    recent[0] = 'Here is New Song.';
    modelSays('Here is New Song.');
    await expectRejected(baseCtx(), recent);
  });

  it('allows a line last spoken more than 20 lines ago', async () => {
    const recent = [
      'Here is New Song.',
      ...Array.from({ length: 20 }, (_, i) => `Line ${String.fromCharCode(97 + i)}.`)
    ];
    modelSays('Here is New Song.');
    await expect(writeLine(baseCtx(), recent)).resolves.toBeDefined();
  });

  it.each([
    ['a non-object', 'not json'],
    ['a missing line', { factIds: ['f1'] }],
    ['non-array factIds', { line: 'Hi there.', factIds: 'f1' }]
  ])('rejects malformed model output: %s', async (_label, response) => {
    chatJson.mockResolvedValueOnce(response);
    await expectRejected(baseCtx());
  });

  it('reports invalid JSON from the model as an llm failure, without TTS', async () => {
    chatJson.mockRejectedValueOnce(new SyntaxError('Unexpected token'));
    const error = await writeLine(baseCtx(), []).catch((e) => e);
    expect(error).toBeInstanceOf(LineError);
    expect(error.kind).toBe('llm');
    expect(synthesize).not.toHaveBeenCalled();
  });

  it('rejects a number word with a count noun that no cited fact states', async () => {
    modelSays('Kasper has played this twelve times!', ['f9']);
    await expectRejected(ctxWithCount());
  });

  it('rejects digits that no cited fact states', async () => {
    modelSays('This one has 12 plays.', ['f9']);
    await expectRejected(ctxWithCount());
  });

  it('rejects a correct number when the fact stating it is not cited', async () => {
    modelSays('Kasper has played this seven times!', ['f1']);
    await expectRejected(ctxWithCount());
  });

  it('rejects a quantity when the context has no numeric facts at all', async () => {
    modelSays('Three of you are here tonight.', ['f1']);
    await expectRejected(baseCtx());
  });

  it('rejects a line containing a content-filter term, case-insensitively', async () => {
    modelSays(`What a ${BLOCKED_TERMS[0].toUpperCase()} of a song.`);
    await expectRejected(baseCtx());
  });

  it('does not flag a blocked term inside an ordinary word', async () => {
    modelSays('Classic tune coming up from New Band.');
    await expect(writeLine(baseCtx(), [])).resolves.toBeDefined();
  });
});

describe('writeLine: prompt', () => {
  it('sends only the last 5 spoken lines as recentLines, with the contract parameters', async () => {
    const recent = Array.from({ length: 8 }, (_, i) => `Line number ${i}.`);
    modelSays('Here is New Song.');
    await writeLine(baseCtx(), recent);

    const call = chatJson.mock.calls[0][0];
    expect(call.temperature).toBe(0.9);
    expect(call.timeoutMs).toBe(10000);
    expect(call.system).toMatch(/ONE or TWO/);
    expect(call.system).toMatch(/Spell numbers as words/);
    expect(call.system).toMatch(/allowedNames/);
    expect(call.user.recentLines).toEqual(recent.slice(-5));
    expect(call.user.facts.map((f) => f.id)).toEqual(['f1', 'f2']);
    expect(call.user).toHaveProperty('next');
    expect(call.user).toHaveProperty('previous');
    expect(call.user).toHaveProperty('allowedNames');
    expect(call.user.theme).toBeNull();
  });

  it('surfaces a TTS failure with the TTS error kind', async () => {
    modelSays('Here is New Song.');
    synthesize.mockRejectedValueOnce(Object.assign(new Error('out of credits'), { kind: 'quota' }));
    const error = await writeLine(baseCtx(), []).catch((e) => e);
    expect(error.kind).toBe('quota');
  });
});
