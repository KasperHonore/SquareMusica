import { chatJson } from '../../integrations/llm.js';
import { synthesize } from '../../integrations/elevenlabs.js';
import { isClean } from './contentFilter.js';

// Writes and voices one DJ line (research R6, contracts §5a). Every check runs
// before TTS, so a rejected line costs no speech quota.

const MAX_CHARS = 240;
const MAX_SENTENCES = 2;
const REPEAT_WINDOW = 20;
const PROMPT_RECENT = 5;

const SYSTEM_PROMPT = [
  'You are the SquareMusica radio DJ.',
  'Write ONE or TWO short, upbeat sentences to say over the start of the next song.',
  'Use ONLY the facts provided. Only name people listed under allowedNames.',
  'Never invent play counts, dates or connections.',
  'Spell numbers as words. No emoji.',
  'Never use insults or slurs, and never mention personal information beyond the provided facts.',
  'Do not repeat any of recentLines.',
  'Return JSON {"line": string, "factIds": string[]} where factIds lists the ids of every fact the line uses.'
].join(' ');

/**
 * Error thrown when a line cannot be produced. `kind` feeds the breaker (R9):
 * `llm`, `validation`, `tts` or `quota`.
 */
export class LineError extends Error {
  constructor(kind, message, cause) {
    super(message);
    this.name = 'LineError';
    this.kind = kind;
    if (cause) this.cause = cause;
  }
}

const NUMBER_WORDS = [
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
const TENS = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety'];

/** English number word (zero to one hundred) → value. */
const WORD_VALUES = new Map();
NUMBER_WORDS.forEach((word, i) => WORD_VALUES.set(word, i));
for (let t = 2; t < 10; t++) {
  WORD_VALUES.set(TENS[t], t * 10);
  for (let u = 1; u < 10; u++) {
    WORD_VALUES.set(`${TENS[t]}-${NUMBER_WORDS[u]}`, t * 10 + u);
    WORD_VALUES.set(`${TENS[t]} ${NUMBER_WORDS[u]}`, t * 10 + u);
  }
}
WORD_VALUES.set('a hundred', 100);
WORD_VALUES.set('one hundred', 100);
WORD_VALUES.set('hundred', 100);

const COUNT_NOUNS = [
  'plays',
  'times',
  'tracks',
  'songs',
  'spins',
  'days',
  'weeks',
  'people',
  'of you'
];

// Longest first so "twenty-one" wins over "twenty" and "one hundred" over "one".
const WORD_ALTERNATION = [...WORD_VALUES.keys()]
  .sort((a, b) => b.length - a.length)
  .map((w) => w.replace(/[ -]/g, '[\\s-]'))
  .join('|');
const NOUN_ALTERNATION = COUNT_NOUNS.map((n) => n.replace(/ /g, '\\s+')).join('|');
const WORD_QUANTITY_RE = new RegExp(`\\b(${WORD_ALTERNATION})\\s+(?:${NOUN_ALTERNATION})\\b`, 'gi');
const DIGITS_RE = /\d+(?:[.,]\d+)*/g;
const ANY_WORD_NUMBER_RE = new RegExp(`\\b(${WORD_ALTERNATION})\\b`, 'gi');

function wordValue(word) {
  return WORD_VALUES.get(
    word.toLowerCase().replace(/[\s-]+/g, (m) => (m.includes('-') ? '-' : ' '))
  );
}

function digitValue(raw) {
  return Number(raw.replace(/,/g, ''));
}

/**
 * Every quantity the line states: any run of digits, or a number word directly
 * followed by a count noun. Number words used as ordinary words ("this one's for
 * you", "one more") are not quantities.
 * @param {string} text
 * @returns {number[]}
 */
export function quantitiesIn(text) {
  const out = [];
  for (const m of text.matchAll(DIGITS_RE)) out.push(digitValue(m[0]));
  for (const m of text.matchAll(WORD_QUANTITY_RE)) out.push(wordValue(m[1]));
  return out;
}

/** Every numeric value a fact carries, as digits or number words. */
function factValues(fact) {
  const values = new Set();
  if (typeof fact.value === 'number') values.add(fact.value);
  const text = String(fact.text ?? '');
  for (const m of text.matchAll(DIGITS_RE)) values.add(digitValue(m[0]));
  for (const m of text.matchAll(ANY_WORD_NUMBER_RE)) values.add(wordValue(m[1]));
  return values;
}

/**
 * @param {string} text
 * @returns {number}
 */
export function countSentences(text) {
  return text
    .split(/[.!?…]+(?=\s|$)/)
    .map((s) => s.trim())
    .filter((s) => /[\p{L}\p{N}]/u.test(s)).length;
}

/**
 * Check a model response against R6 steps 1, 2 and 4, the quantity rule (FR-005)
 * and the content filter. Step 3 (forbidden names) arrives with US3.
 * @param {unknown} response - Parsed model JSON
 * @param {Object} ctx - Listening Context
 * @param {string[]} recentSpoken - Spoken texts, oldest first
 * @returns {{ text: string, factIds: string[] }}
 * @throws {LineError} kind `validation`
 */
export function validateLine(response, ctx, recentSpoken = []) {
  const reject = (why) => {
    throw new LineError('validation', `Line rejected: ${why}`);
  };

  if (!response || typeof response !== 'object') reject('response is not an object');
  const { line, factIds } = response;
  if (typeof line !== 'string' || line.trim() === '') reject('missing line');
  if (!Array.isArray(factIds) || !factIds.every((id) => typeof id === 'string')) {
    reject('factIds is not a string array');
  }

  const text = line.trim().replace(/\s+/g, ' ');
  if (text.length > MAX_CHARS) reject(`${text.length} characters`);
  const sentences = countSentences(text);
  if (sentences < 1 || sentences > MAX_SENTENCES) reject(`${sentences} sentences`);

  const factsById = new Map(ctx.facts.map((f) => [f.id, f]));
  const unknown = factIds.filter((id) => !factsById.has(id));
  if (unknown.length > 0) reject(`unknown fact ids ${unknown.join(', ')}`);

  if (recentSpoken.slice(-REPEAT_WINDOW).includes(text)) reject('repeat of a recent line');

  const cited = new Set();
  for (const id of factIds) for (const v of factValues(factsById.get(id))) cited.add(v);
  const unsupported = quantitiesIn(text).filter((q) => !cited.has(q));
  if (unsupported.length > 0) reject(`unsupported quantity ${unsupported.join(', ')}`);

  if (!isClean(text)) reject('blocked term');

  return { text, factIds: [...factIds] };
}

/**
 * Ask the model for a line about `ctx`, validate it and voice it.
 * @param {Object} ctx - From buildContext()
 * @param {string[]} [recentSpoken] - The DJ's spoken texts, oldest first (up to 20)
 * @returns {Promise<{ forKey: string, text: string, pcm: Buffer, factIds: string[],
 *   namedUserIds: string[], preparedAt: number }>}
 * @throws {LineError}
 */
export async function writeLine(ctx, recentSpoken = []) {
  const user = {
    next: ctx.next,
    previous: ctx.previous,
    theme: ctx.theme ?? null,
    allowedNames: ctx.allowedNames ?? [],
    facts: ctx.facts.map(({ id, text }) => ({ id, text })),
    recentLines: recentSpoken.slice(-PROMPT_RECENT)
  };

  let response;
  try {
    response = await chatJson({ system: SYSTEM_PROMPT, user, temperature: 0.9, timeoutMs: 10000 });
  } catch (error) {
    throw new LineError('llm', `LLM failed: ${error.message}`, error);
  }

  const { text, factIds } = validateLine(response, ctx, recentSpoken);

  let pcm;
  try {
    pcm = await synthesize(text);
  } catch (error) {
    throw new LineError(
      error?.kind === 'quota' ? 'quota' : 'tts',
      `TTS failed: ${error.message}`,
      error
    );
  }

  return { forKey: ctx.forKey, text, pcm, factIds, namedUserIds: [], preparedAt: Date.now() };
}
