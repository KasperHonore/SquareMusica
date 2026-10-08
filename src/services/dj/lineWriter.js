import { chatJson } from '../../integrations/llm.js';
import { synthesize } from '../../integrations/elevenlabs.js';
import { isClean } from './contentFilter.js';

/**
 * Turns a Listening Context into one validated, synthesized DJ line
 * (contracts §5a, research R6). Every check runs before TTS, so a rejected line
 * costs no speech credits and never reaches the player.
 */

export const MAX_LINE_CHARS = 240;
export const MAX_SENTENCES = 2;
export const REPEAT_WINDOW = 20;
export const PROMPT_RECENT_LINES = 5;
const LLM_TIMEOUT_MS = 10000;
const LLM_TEMPERATURE = 0.9;

export const SYSTEM_PROMPT = [
  'You are the SquareMusica radio DJ.',
  'Write ONE or TWO short, upbeat sentences to say over the start of the next song.',
  'Use ONLY the facts provided. Only name people listed under allowedNames.',
  'Never invent play counts, dates or connections.',
  'Never insult anyone, never use slurs, and never mention personal information beyond the provided facts.',
  'Spell numbers as words. No emoji.',
  'Do not repeat any of recentLines.',
  'Return JSON {"line": string, "factIds": string[]} where factIds lists the ids of the facts you used.'
].join(' ');

/**
 * A line that could not be produced. `kind` is reported to the breaker:
 * 'llm' (request or JSON failed), 'validation' (the model's line was rejected),
 * or the TtsError kind from integrations/elevenlabs.js.
 */
export class LineError extends Error {
  constructor(kind, message, cause) {
    super(message);
    this.name = 'LineError';
    this.kind = kind;
    if (cause) this.cause = cause;
  }
}

const UNITS = [
  'zero',
  'one',
  'two',
  'three',
  'four',
  'five',
  'six',
  'seven',
  'eight',
  'nine',
  'ten',
  'eleven',
  'twelve',
  'thirteen',
  'fourteen',
  'fifteen',
  'sixteen',
  'seventeen',
  'eighteen',
  'nineteen'
];
const TENS = ['twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety'];
const COUNT_NOUNS = ['plays', 'times', 'tracks', 'songs', 'spins', 'days', 'weeks', 'people'];

const NUMBER_WORD =
  `(?:(?:${TENS.join('|')})(?:[-\\s](?:${UNITS.slice(1, 10).join('|')}))?` +
  `|(?:one\\s+)?hundred|${UNITS.join('|')})`;
const WORD_QUANTITY = new RegExp(
  `\\b(${NUMBER_WORD})\\s+(?:${COUNT_NOUNS.join('|')}|of\\s+you)\\b`,
  'gi'
);
const DIGITS = /\d+/g;

/** "twenty-one" → 21, "one hundred" → 100. */
function wordToNumber(phrase) {
  const words = phrase.toLowerCase().split(/[-\s]+/);
  if (words.includes('hundred')) return 100;
  let total = 0;
  for (const word of words) {
    const tens = TENS.indexOf(word);
    if (tens >= 0) total += (tens + 2) * 10;
    else total += UNITS.indexOf(word);
  }
  return total;
}

/**
 * Every quantity the line states: digit runs anywhere, and number words
 * directly followed by a count noun. "one more" or "this one's for you" are
 * not quantities.
 * @param {string} text
 * @returns {number[]}
 */
export function quantitiesIn(text) {
  const found = [];
  for (const match of text.matchAll(DIGITS)) found.push(Number(match[0]));
  for (const match of text.matchAll(WORD_QUANTITY)) found.push(wordToNumber(match[1]));
  return found;
}

function countSentences(text) {
  return text
    .split(/[.!?]+(?:\s+|$)/)
    .map((part) => part.trim())
    .filter(Boolean).length;
}

function normalise(text) {
  return text.trim().replace(/\s+/g, ' ').toLowerCase();
}

/**
 * R6 steps 1, 2 and 4 plus the quantity (FR-005) and content checks. Step 3
 * (forbidden names) arrives with US3.
 * @param {unknown} output - Parsed model JSON
 * @param {Object} ctx - Listening Context
 * @param {string[]} recentSpoken - Last spoken texts, oldest first
 * @returns {{ text: string, factIds: string[] }}
 * @throws {LineError} kind 'validation'
 */
export function validateLine(output, ctx, recentSpoken = []) {
  const reject = (reason) => {
    throw new LineError('validation', `DJ line rejected: ${reason}`);
  };

  if (!output || typeof output !== 'object') reject('response is not an object');
  const { line, factIds } = output;
  if (typeof line !== 'string' || line.trim() === '') reject('missing line');
  if (!Array.isArray(factIds) || !factIds.every((id) => typeof id === 'string')) {
    reject('factIds is not a list of ids');
  }

  const text = line.trim();
  if (text.length > MAX_LINE_CHARS) reject(`${text.length} characters`);
  const sentences = countSentences(text);
  if (sentences < 1 || sentences > MAX_SENTENCES) reject(`${sentences} sentences`);

  const factsById = new Map(ctx.facts.map((fact) => [fact.id, fact]));
  const unknown = factIds.filter((id) => !factsById.has(id));
  if (unknown.length > 0) reject(`unknown fact ids ${unknown.join(', ')}`);

  const allowed = new Set();
  for (const id of factIds) {
    const fact = factsById.get(id);
    for (const match of String(fact.text).matchAll(DIGITS)) allowed.add(Number(match[0]));
    if (typeof fact.value === 'number') allowed.add(fact.value);
  }
  const unsupported = quantitiesIn(text).filter((n) => !allowed.has(n));
  if (unsupported.length > 0) reject(`unsupported quantity ${unsupported.join(', ')}`);

  if (!isClean(text)) reject('blocked term');

  const key = normalise(text);
  if (recentSpoken.slice(-REPEAT_WINDOW).some((spoken) => normalise(spoken) === key)) {
    reject('repeat of a recent line');
  }

  return { text, factIds: [...factIds] };
}

/** The user payload of contracts §5a. */
export function buildPayload(ctx, recentSpoken = []) {
  return {
    next: ctx.next,
    previous: ctx.previous,
    theme: ctx.theme,
    allowedNames: ctx.allowedNames ?? [],
    facts: ctx.facts.map(({ id, text }) => ({ id, text })),
    recentLines: recentSpoken.slice(-PROMPT_RECENT_LINES)
  };
}

/**
 * Generate, validate and synthesize one line.
 * @param {Object} ctx - Listening Context from buildContext()
 * @param {string[]} [recentSpoken] - Last spoken texts, oldest first
 * @returns {Promise<{ forKey: string, text: string, pcm: Buffer, factIds: string[],
 *   namedUserIds: string[], preparedAt: number }>}
 * @throws {LineError|Error} Always with a `kind`
 */
export async function writeLine(ctx, recentSpoken = []) {
  let output;
  try {
    output = await chatJson({
      system: SYSTEM_PROMPT,
      user: JSON.stringify(buildPayload(ctx, recentSpoken)),
      temperature: LLM_TEMPERATURE,
      timeoutMs: LLM_TIMEOUT_MS
    });
  } catch (error) {
    throw new LineError('llm', error.message, error);
  }

  const { text, factIds } = validateLine(output, ctx, recentSpoken);

  let pcm;
  try {
    pcm = await synthesize(text);
  } catch (error) {
    throw new LineError(error.kind ?? 'tts', error.message, error);
  }

  return { forKey: ctx.forKey, text, pcm, factIds, namedUserIds: [], preparedAt: Date.now() };
}
