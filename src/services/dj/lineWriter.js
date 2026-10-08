/**
 * Turns a Listening Context into one spoken DJ line: LLM text, validation
 * (research R6), then TTS. Every rejection throws a LineError whose `kind` the
 * breaker understands, and a rejected line never reaches TTS.
 * MUST NOT import src/transports/.
 */
import { chatJson } from '../../integrations/llm.js';
import { synthesize } from '../../integrations/elevenlabs.js';
import { isClean } from './contentFilter.js';

const MAX_CHARS = 240;
const MAX_SENTENCES = 2;
const REPEAT_WINDOW = 20;
const PROMPT_RECENT_LINES = 5;
const LLM_TEMPERATURE = 0.9;
const LLM_TIMEOUT_MS = 10000;

export const SYSTEM_PROMPT = [
  'You are the SquareMusica radio DJ.',
  'Write ONE or TWO short, upbeat sentences to say over the start of the next song.',
  'Use ONLY the facts provided. Only name people listed under allowedNames.',
  'Never invent play counts, dates or connections. Spell numbers as words. No emoji.',
  'Never use insults, slurs or harassment, and never mention personal information beyond the provided facts.',
  'Do not repeat or closely paraphrase any of recentLines.',
  'Return JSON {"line": string, "factIds": string[]}.'
].join(' ');

// Themed-mode intro (FR-028): introduces the set, not a song.
export const INTRO_SYSTEM_PROMPT = [
  'You are the SquareMusica radio DJ, opening a themed set.',
  'Write ONE or TWO short, upbeat sentences introducing the theme of the set that is about to play.',
  'Use ONLY the facts provided. Do not name any person or any song.',
  'Never invent play counts, dates or connections. Spell numbers as words. No emoji.',
  'Never use insults, slurs or harassment.',
  'Do not repeat or closely paraphrase any of recentLines.',
  'Return JSON {"line": string, "factIds": string[]}.'
].join(' ');

/** A dropped line, with a `kind` for the breaker ('llm', 'validation', or a TTS kind). */
export class LineError extends Error {
  constructor(kind, message) {
    super(message);
    this.name = 'LineError';
    this.kind = kind;
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
const TENS = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety'];

// English number words zero..one hundred → value. Compounds accept a hyphen
// or a space ("twenty-one", "twenty one").
const NUMBER_WORDS = new Map();
UNITS.forEach((word, n) => NUMBER_WORDS.set(word, n));
TENS.forEach((tens, t) => {
  if (!tens) return;
  NUMBER_WORDS.set(tens, t * 10);
  for (let u = 1; u <= 9; u++) {
    NUMBER_WORDS.set(`${tens}-${UNITS[u]}`, t * 10 + u);
    NUMBER_WORDS.set(`${tens} ${UNITS[u]}`, t * 10 + u);
  }
});
NUMBER_WORDS.set('a hundred', 100);
NUMBER_WORDS.set('one hundred', 100);

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

// Longest alternatives first so "twenty-one" wins over "twenty".
const numberWordAlternation = [...NUMBER_WORDS.keys()]
  .sort((a, b) => b.length - a.length)
  .map((w) => w.replace(/ /g, '\\s+'))
  .join('|');
const countNounAlternation = COUNT_NOUNS.map((n) => n.replace(/ /g, '\\s+')).join('|');
const WORD_QUANTITY = new RegExp(
  `\\b(${numberWordAlternation})\\s+(?:${countNounAlternation})\\b`,
  'gi'
);
const DIGITS = /\d+(?:[.,]\d+)*/g;

function parseNumberWord(word) {
  return NUMBER_WORDS.get(word.toLowerCase().replace(/\s+/g, ' '));
}

/**
 * Every quantity the line states: any run of digits, and any number word
 * immediately followed by a count noun. "One more" or "this one's for you" are
 * not quantities.
 * @param {string} text
 * @returns {number[]}
 */
export function extractQuantities(text) {
  const values = [];
  for (const match of text.matchAll(DIGITS)) {
    values.push(Number(match[0].replace(/,/g, '')));
  }
  for (const match of text.matchAll(WORD_QUANTITY)) {
    values.push(parseNumberWord(match[1]));
  }
  return values;
}

// Numeric values a fact states, written as digits or as number words.
function factNumbers(text) {
  const values = new Set();
  for (const match of text.matchAll(DIGITS)) {
    values.add(Number(match[0].replace(/,/g, '')));
  }
  const wordPattern = new RegExp(`\\b(${numberWordAlternation})\\b`, 'gi');
  for (const match of text.matchAll(wordPattern)) {
    values.add(parseNumberWord(match[1]));
  }
  return values;
}

/**
 * Split into sentences on terminal punctuation. A trailing fragment without
 * punctuation still counts as a sentence.
 * @param {string} text
 * @returns {string[]}
 */
export function splitSentences(text) {
  return text
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter((s) => /[\p{L}\p{N}]/u.test(s));
}

/**
 * Check a model response against R6 (steps 1, 2 and 4) plus the quantity
 * and content checks. Step 3 (forbidden names) arrives with US3.
 * @param {unknown} response - Parsed model JSON
 * @param {Object} ctx - Listening Context
 * @param {string[]} recentSpoken - Spoken texts, oldest first
 * @returns {{ text: string, factIds: string[] }}
 * @throws {LineError} kind 'validation'
 */
export function validateLine(response, ctx, recentSpoken = []) {
  const reject = (why) => {
    throw new LineError('validation', why);
  };

  const line = response?.line;
  const factIds = response?.factIds;
  if (typeof line !== 'string' || !Array.isArray(factIds)) reject('malformed model response');

  const text = line.trim().replace(/\s+/g, ' ');
  if (!text) reject('empty line');
  if (text.length > MAX_CHARS) reject(`line is ${text.length} characters`);

  const sentences = splitSentences(text);
  if (sentences.length < 1 || sentences.length > MAX_SENTENCES) {
    reject(`line has ${sentences.length} sentences`);
  }

  const factsById = new Map(ctx.facts.map((f) => [f.id, f]));
  const cited = [];
  for (const id of factIds) {
    const fact = factsById.get(id);
    if (!fact) reject(`unknown fact id ${JSON.stringify(id)}`);
    cited.push(fact);
  }

  if (recentSpoken.slice(-REPEAT_WINDOW).includes(text)) reject('repeat of a recent line');

  const allowed = new Set();
  for (const fact of cited) {
    for (const n of factNumbers(fact.text)) allowed.add(n);
  }
  for (const quantity of extractQuantities(text)) {
    if (!allowed.has(quantity)) reject(`quantity ${quantity} is not in a cited fact`);
  }

  if (!isClean(text)) reject('line failed the content filter');

  return { text, factIds };
}

/**
 * Write, validate and voice one line for ctx.next.
 * @param {Object} ctx - Listening Context from buildContext()
 * @param {string[]} recentSpoken - Spoken texts, oldest first
 * @returns {Promise<{ forKey: string, text: string, pcm: Buffer, factIds: string[], namedUserIds: string[], preparedAt: number }>}
 * @throws {LineError|Error} with a `kind`
 */
export async function writeLine(ctx, recentSpoken = []) {
  const user = ctx.intro
    ? {
        theme: ctx.theme,
        allowedNames: [],
        facts: ctx.facts.map(({ id, text }) => ({ id, text })),
        recentLines: recentSpoken.slice(-PROMPT_RECENT_LINES)
      }
    : {
        next: ctx.next,
        previous: ctx.previous,
        theme: ctx.theme,
        allowedNames: ctx.allowedNames ?? [],
        facts: ctx.facts.map(({ id, text }) => ({ id, text })),
        recentLines: recentSpoken.slice(-PROMPT_RECENT_LINES)
      };

  let response;
  try {
    response = await chatJson({
      system: ctx.intro ? INTRO_SYSTEM_PROMPT : SYSTEM_PROMPT,
      user,
      temperature: LLM_TEMPERATURE,
      timeoutMs: LLM_TIMEOUT_MS
    });
  } catch (error) {
    throw new LineError('llm', error.message);
  }

  const { text, factIds } = validateLine(response, ctx, recentSpoken);

  let pcm;
  try {
    pcm = await synthesize(text);
  } catch (error) {
    throw new LineError(error.kind ?? 'network', error.message);
  }

  return {
    forKey: ctx.next?.key ?? null,
    text,
    pcm,
    factIds,
    namedUserIds: [],
    preparedAt: Date.now()
  };
}
