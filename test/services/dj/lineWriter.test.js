import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../../src/integrations/llm.js', () => ({ chatJson: vi.fn() }));
vi.mock('../../../src/integrations/elevenlabs.js', () => ({ synthesize: vi.fn() }));

const { chatJson } = await import('../../../src/integrations/llm.js');
const { synthesize } = await import('../../../src/integrations/elevenlabs.js');
const { writeLine } = await import('../../../src/services/dj/lineWriter.js');
const { buildContext } = await import('../../../src/services/dj/context.js');
const { BLOCKED_TERMS } = await import('../../../src/services/dj/contentFilter.js');

const PCM = Buffer.alloc(3840);

const previous = { title: 'Song A', url: 'https://youtu.be/a', channel: 'Artist A', duration: 200 };
const next = { title: 'Song B', url: 'https://youtu.be/b', channel: 'Artist B', duration: 180 };

function ctx(extraFacts = []) {
  const c = buildContext({ previous, next });
  c.facts.push(...extraFacts);
  return c;
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
  it('accepts one or two sentences within 240 characters citing known facts', async () => {
    modelSays('Coming up, Song B by Artist B. Turn it up!', ['f-next', 'f-prev']);
    const line = await writeLine(ctx(), []);
    expect(line).toMatchObject({
      forKey: 'https://youtu.be/b',
      text: 'Coming up, Song B by Artist B. Turn it up!',
      pcm: PCM,
      factIds: ['f-next', 'f-prev'],
      namedUserIds: []
    });
    expect(typeof line.preparedAt).toBe('number');
    expect(synthesize).toHaveBeenCalledWith('Coming up, Song B by Artist B. Turn it up!');
  });

  it.each(["Hey Kasper, this one's for you.", "Here's one more classic."])(
    'does not treat ordinary number words as quantities: %s',
    async (text) => {
      modelSays(text, ['f-next']);
      await expect(writeLine(ctx(), [])).resolves.toMatchObject({ text });
    }
  );

  it.each([
    ['Up next, Mr. Brightside by The Killers. Enjoy!', {}],
    ['Here comes Song B feat. Someone. Turn it up!', {}],
    ['Hits Vol. 2 starts now. Enjoy!', { title: 'Hits Vol. 2' }],
    ['Up next, R.E.M. with a classic. Enjoy!', {}],
    [
      'Next up, Hello. Goodbye. by J. Cole. Enjoy!',
      { title: 'Hello. Goodbye.', channel: 'J. Cole' }
    ]
  ])('does not count abbreviations or name punctuation as sentence ends: %s', async (text, n) => {
    modelSays(text, ['f-next']);
    const c = buildContext({ previous, next: { ...next, ...n } });
    await expect(writeLine(c, [])).resolves.toMatchObject({ text });
  });

  it('accepts a quantity that matches a cited numeric fact', async () => {
    modelSays('Song B again, played seven times this week!', ['f-next', 'f-m1']);
    const c = ctx([{ id: 'f-m1', kind: 'member', text: 'Kasper has played this track 7 times.' }]);
    await expect(writeLine(c, [])).resolves.toMatchObject({ factIds: ['f-next', 'f-m1'] });
  });

  it('sends the contract payload with only the last 5 lines in recentLines', async () => {
    modelSays('Song B is next.');
    const recent = Array.from({ length: 12 }, (_, i) => `Line ${i}.`);
    await writeLine(ctx(), recent);

    const call = chatJson.mock.calls[0][0];
    expect(call.temperature).toBe(0.9);
    expect(call.timeoutMs).toBe(10000);
    expect(call.system).toMatch(/one or two/i);
    expect(call.system).toMatch(/allowedNames/);
    expect(call.system).toMatch(/spell numbers as words/i);
    expect(call.system).toMatch(/no emoji/i);
    expect(call.system).toMatch(/"line"/);
    expect(call.system).toMatch(/slurs/i);
    expect(Object.keys(call.user).sort()).toEqual(
      ['allowedNames', 'facts', 'next', 'previous', 'recentLines', 'theme'].sort()
    );
    expect(call.user.recentLines).toEqual([
      'Line 7.',
      'Line 8.',
      'Line 9.',
      'Line 10.',
      'Line 11.'
    ]);
    expect(call.user.next).toMatchObject({ title: 'Song B', artist: 'Artist B' });
    expect(call.user.previous).toMatchObject({ title: 'Song A', artist: 'Artist A' });
  });
});

describe('writeLine: rejected lines never reach TTS', () => {
  const recent20 = Array.from({ length: 20 }, (_, i) => `Old line ${String.fromCharCode(65 + i)}.`);

  it.each([
    ['three sentences', () => modelSays('One. Two. Three.')],
    ['three sentences despite an abbreviation', () => modelSays('Mr. Song is next. Two. Three.')],
    [
      'three sentences ending in an ordinary "no."',
      () => modelSays('The answer is no. Two. Three.')
    ],
    ['more than 240 characters', () => modelSays(`${'la '.repeat(90)}.`)],
    ['an unknown fact id', () => modelSays('Song B is next.', ['f-next', 'f-nope'])],
    ['malformed JSON', () => chatJson.mockRejectedValueOnce(new SyntaxError('Unexpected token'))],
    ['a non-object response', () => chatJson.mockResolvedValueOnce('just text')],
    ['a missing line', () => chatJson.mockResolvedValueOnce({ factIds: [] })],
    ['an unsupported digit quantity', () => modelSays('Kasper played this 12 times.')],
    ['an unsupported worded quantity', () => modelSays('Kasper played this twelve times.')],
    [
      'a quantity not matching the cited fact',
      () => modelSays('Played eight times by Kasper!', ['f-next', 'f-m1'])
    ],
    ['a quantity with "of you"', () => modelSays('Three of you love this one.')],
    ['a blocked term', () => modelSays(`This one goes out to every ${BLOCKED_TERMS[0]} here.`)]
  ])('rejects %s', async (_name, arrange) => {
    arrange();
    const c = ctx([{ id: 'f-m1', kind: 'member', text: 'Kasper has played this track 7 times.' }]);
    await expect(writeLine(c, [])).rejects.toMatchObject({
      kind: expect.stringMatching(/^(validation|llm)$/)
    });
    expect(synthesize).not.toHaveBeenCalled();
  });

  it('rejects an exact repeat of any of the last 20 spoken lines', async () => {
    modelSays('Old line A.');
    await expect(writeLine(ctx(), recent20)).rejects.toMatchObject({ kind: 'validation' });
    expect(synthesize).not.toHaveBeenCalled();
  });

  it('allows a line last spoken more than 20 lines ago', async () => {
    modelSays('Old line A.');
    const recent = ['Old line A.', ...recent20.slice(1), 'Newer.'];
    await expect(writeLine(ctx(), recent)).resolves.toMatchObject({ text: 'Old line A.' });
  });

  it('labels an LLM failure kind llm', async () => {
    chatJson.mockRejectedValueOnce(new Error('LLM request failed with HTTP 500'));
    await expect(writeLine(ctx(), [])).rejects.toMatchObject({ kind: 'llm' });
  });

  it('labels a TTS quota failure kind quota and other TTS failures tts', async () => {
    modelSays('Song B is next.');
    synthesize.mockRejectedValueOnce(Object.assign(new Error('quota'), { kind: 'quota' }));
    await expect(writeLine(ctx(), [])).rejects.toMatchObject({ kind: 'quota' });

    modelSays('Song B is next.');
    synthesize.mockRejectedValueOnce(Object.assign(new Error('boom'), { kind: 'network' }));
    await expect(writeLine(ctx(), [])).rejects.toMatchObject({ kind: 'tts' });
  });
});
