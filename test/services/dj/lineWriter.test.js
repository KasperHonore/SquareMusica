import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../../src/integrations/llm.js', () => ({ chatJson: vi.fn() }));
vi.mock('../../../src/integrations/elevenlabs.js', () => ({ synthesize: vi.fn() }));

import { chatJson } from '../../../src/integrations/llm.js';
import { synthesize } from '../../../src/integrations/elevenlabs.js';
import { writeLine, quantitiesIn } from '../../../src/services/dj/lineWriter.js';
import { buildContext } from '../../../src/services/dj/context.js';
import { BLOCKED_TERMS, isClean } from '../../../src/services/dj/contentFilter.js';

const PCM = Buffer.alloc(3840);

const previous = {
  title: 'Mr. Brightside',
  url: 'https://youtu.be/prev',
  channel: 'The Killers',
  addedAt: new Date('2026-10-08T18:00:00Z')
};
const next = {
  title: 'Dancing Queen',
  url: 'https://youtu.be/next',
  channel: 'ABBA',
  addedAt: new Date('2026-10-08T18:01:00Z')
};

function context(extraFacts = []) {
  const ctx = buildContext({ previous, next, present: [{ id: 'u1' }] });
  ctx.facts.push(...extraFacts);
  return ctx;
}

function modelSays(line, factIds = ['f-next']) {
  chatJson.mockResolvedValueOnce({ line, factIds });
}

beforeEach(() => {
  chatJson.mockReset();
  synthesize.mockReset();
  synthesize.mockResolvedValue(PCM);
});

describe('writeLine: accepted lines', () => {
  it('accepts a one-sentence line citing known facts and synthesizes it', async () => {
    modelSays('Up next, ABBA with Dancing Queen!', ['f-next', 'f-previous']);
    const line = await writeLine(context(), []);
    expect(line).toMatchObject({
      forKey: 'https://youtu.be/next',
      text: 'Up next, ABBA with Dancing Queen!',
      pcm: PCM,
      factIds: ['f-next', 'f-previous'],
      namedUserIds: []
    });
    expect(typeof line.preparedAt).toBe('number');
    expect(synthesize).toHaveBeenCalledWith('Up next, ABBA with Dancing Queen!');
  });

  it('accepts two sentences', async () => {
    modelSays('That was The Killers. Now here comes ABBA!');
    await expect(writeLine(context(), [])).resolves.toMatchObject({ factIds: ['f-next'] });
  });

  it('accepts exactly 240 characters', async () => {
    const text = `${'a'.repeat(239)}.`;
    modelSays(text);
    await expect(writeLine(context(), [])).resolves.toMatchObject({ text });
  });

  it.each(["Hey Kasper, this one's for you.", "Here's one more classic."])(
    'treats number words used as ordinary words as non-quantities: %s',
    async (text) => {
      modelSays(text);
      await expect(writeLine(context(), [])).resolves.toMatchObject({ text });
    }
  );

  it('accepts a quantity that equals a number in a cited fact', async () => {
    const fact = { id: 'f-count', kind: 'member', text: 'Kasper has played this track 7 times.' };
    modelSays('Kasper has spun this seven times now.', ['f-count']);
    // "spun ... seven times": "seven times" is a number word + count noun.
    await expect(writeLine(context([fact]), [])).resolves.toMatchObject({
      factIds: ['f-count']
    });
  });
});

describe('writeLine: rejected lines never reach TTS', () => {
  const rejects = async (ctx = context(), recent = []) => {
    await expect(writeLine(ctx, recent)).rejects.toMatchObject({ kind: 'validation' });
    expect(synthesize).not.toHaveBeenCalled();
  };

  it('rejects three sentences', async () => {
    modelSays('One song ends. Another begins. Here is ABBA.');
    await rejects();
  });

  it('rejects more than 240 characters', async () => {
    modelSays(`${'a'.repeat(240)}.`);
    await rejects();
  });

  it('rejects an unknown fact id', async () => {
    modelSays('Here is ABBA!', ['f-next', 'f-made-up']);
    await rejects();
  });

  it('rejects an exact repeat of any of the last 20 spoken lines', async () => {
    const recent = Array.from({ length: 20 }, (_, i) => `Line number ${i}.`);
    recent[0] = 'Here is ABBA!';
    modelSays('Here is ABBA!');
    await rejects(context(), recent);
  });

  it('allows a line last spoken more than 20 lines ago', async () => {
    const recent = ['Here is ABBA!', ...Array.from({ length: 20 }, (_, i) => `Line ${i}.`)];
    modelSays('Here is ABBA!');
    await expect(writeLine(context(), recent)).resolves.toMatchObject({ text: 'Here is ABBA!' });
  });

  it('rejects malformed JSON from the model as an llm failure', async () => {
    chatJson.mockRejectedValueOnce(new Error('LLM returned malformed JSON'));
    await expect(writeLine(context(), [])).rejects.toMatchObject({ kind: 'llm' });
    expect(synthesize).not.toHaveBeenCalled();
  });

  it('rejects a response missing the line field', async () => {
    chatJson.mockResolvedValueOnce({ text: 'Here is ABBA!', factIds: ['f-next'] });
    await rejects();
  });

  it('rejects a word quantity with no matching numeric fact (FR-005)', async () => {
    modelSays('You have played this twelve times!');
    await rejects();
  });

  it('rejects a digit quantity with no matching numeric fact (FR-005)', async () => {
    modelSays('Your 12 favourite songs start now.');
    await rejects();
  });

  it('rejects a quantity that differs from the cited fact', async () => {
    const fact = { id: 'f-count', kind: 'member', text: 'Kasper has played this track 7 times.' };
    modelSays('Kasper has played this twelve times!', ['f-count']);
    await rejects(context([fact]));
  });

  it('rejects a quantity backed only by a fact the line does not cite', async () => {
    const fact = { id: 'f-count', kind: 'member', text: 'Kasper has played this track 7 times.' };
    modelSays('Kasper has played this seven times!', ['f-next']);
    await rejects(context([fact]));
  });

  it('rejects a line containing a blocked term', async () => {
    modelSays(`Here is ABBA, you ${BLOCKED_TERMS[0]}.`);
    await rejects();
  });
});

describe('writeLine: prompt', () => {
  it('passes only the last 5 spoken lines as recentLines', async () => {
    const recent = Array.from({ length: 8 }, (_, i) => `Line ${i}.`);
    modelSays('Here is ABBA!');
    await writeLine(context(), recent);
    const { user, system, temperature, timeoutMs } = chatJson.mock.calls[0][0];
    const payload = JSON.parse(user);
    expect(payload.recentLines).toEqual(['Line 3.', 'Line 4.', 'Line 5.', 'Line 6.', 'Line 7.']);
    expect(payload).toMatchObject({
      next: { title: 'Dancing Queen', artist: 'ABBA' },
      previous: { title: 'Mr. Brightside', artist: 'The Killers' },
      theme: null,
      allowedNames: []
    });
    expect(payload.facts.map((f) => f.id)).toEqual(['f-next', 'f-previous']);
    expect(system).toMatch(/ONE or TWO/);
    expect(system).toMatch(/Spell numbers as words/);
    expect(temperature).toBe(0.9);
    expect(timeoutMs).toBe(10000);
  });

  it('surfaces the TTS error kind for the breaker', async () => {
    modelSays('Here is ABBA!');
    synthesize.mockRejectedValueOnce(Object.assign(new Error('quota'), { kind: 'quota' }));
    await expect(writeLine(context(), [])).rejects.toMatchObject({ kind: 'quota' });
  });
});

describe('helpers', () => {
  it('quantitiesIn finds digits and number words before count nouns only', () => {
    expect(quantitiesIn('twenty-one plays and 3 songs, one more for you')).toEqual([3, 21]);
    expect(quantitiesIn('five of you are here')).toEqual([5]);
    expect(quantitiesIn("this one's for you")).toEqual([]);
  });

  it('isClean matches on word boundaries, case-insensitively', () => {
    expect(isClean('What a skillful mix.')).toBe(true);
    expect(isClean(`Total ${BLOCKED_TERMS[0].toUpperCase()} move.`)).toBe(false);
  });
});
