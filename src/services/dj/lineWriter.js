/**
 * Writes and voices one DJ line (research R6, contracts §5a).
 *
 * The LLM gets only the Listening Context's facts. Its answer is validated
 * before any TTS money is spent; a line failing any check is dropped by
 * throwing a LineError whose `kind` the breaker (R9) and the planner's drop
 * log understand.
 */
import { chatJson } from '../../integrations/llm.js';
import { synthesize } from '../../integrations/elevenlabs.js';
import { isClean } from './contentFilter.js';

const MAX_CHARS = 240;
const MAX_SENTENCES = 2;
const REPEAT_WINDOW = 20;
const PROMPT_RECENT = 5;
const LLM_TIMEOUT_MS = 10000;
const LLM_TEMPERATURE = 0.9;

export const SYSTEM_PROMPT = [
  'You are the SquareMusica radio DJ.',
  'Write ONE or TWO short, upbeat sentences to say over the start of the next song.',
  'Use ONLY the facts provided. Only name people listed under allowedNames.',
  'Never invent play counts, dates or connections.',
  'Never insult anyone, never use slurs, and never mention personal information beyond the provided facts.',
  'Spell numbers as words. No emoji.',
  "Don't repeat any of recentLines.",
  'Return JSON {"line": string, "factIds": string[]} where factIds lists the ids of the facts you used.'
].join(' ');

/**
 * A dropped line. `kind` is 'validation' when the model's answer failed a
 * check, 'llm' when the model call itself failed, or the TtsError kind.
 */
export class LineError extends Error {
  constructor(kind, message, cause) {
    super(message);
    this.name = 'LineError';
    this.kind = kind;
    if (cause) this.cause = cause;
  }
}

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

/** Count sentences: runs of text ended by . ! ? (or the end of the text). */
export function countSentences(text) {
  return text
    .split(/[.!?]+(?:["')\]]*)(?:\s+|$)/)
    .map((s) => s.trim())
    .filter((s) => /[\p{L}\p{N}]/u.test(s)).length;
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

// Every English number word from zero to one hundred, mapped to its value.
const NUMBER_WORDS = new Map();
UNITS.forEach((w, i) => NUMBER_WORDS.set(w, i));
for (let t = 2; t < 10; t++) {
  NUMBER_WORDS.set(TENS[t], t * 10);
  for (let u = 1; u < 10; u++) {
    NUMBER_WORDS.set(`${TENS[t]}-${UNITS[u]}`, t * 10 + u);
    NUMBER_WORDS.set(`${TENS[t]} ${UNITS[u]}`, t * 10 + u);
  }
}
NUMBER_WORDS.set('one hundred', 100);
NUMBER_WORDS.set('a hundred', 100);
NUMBER_WORDS.set('hundred', 100);

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
const NUMBER_WORD_ALT = [...NUMBER_WORDS.keys()]
  .sort((a, b) => b.length - a.length)
  .map((w) => w.replace(/[-\s]/g, '[-\\s]'))
  .join('|');
const NUMBER_WORD_QUANTITY_RE = new RegExp(
  `\\b(${NUMBER_WORD_ALT})\\s+(?:${COUNT_NOUNS.join('|').replace(/ /g, '\\s+')})\\b`,
  'gi'
);
const DIGITS_RE = /\d+(?:[.,]\d+)*/g;

function parseDigits(s) {
  return Number(s.replace(/,/g, ''));
}

function wordValue(word) {
  return NUMBER_WORDS.get(
    word.toLowerCase().replace(/[-\s]+/g, (m) => (m.includes('-') ? '-' : ' '))
  );
}

/**
 * Quantities a line states: every digit run, plus number words immediately
 * followed by a count noun ("twelve times"). Ordinary uses ("one more") are
 * not quantities.
 * @param {string} text
 * @returns {number[]}
 */
export function extractQuantities(text) {
  const out = [];
  for (const m of text.matchAll(DIGITS_RE)) out.push(parseDigits(m[0]));
  for (const m of text.matchAll(NUMBER_WORD_QUANTITY_RE)) {
    const value = wordValue(m[1]);
    if (value !== undefined) out.push(value);
  }
  return out;
}

/** Numeric values a fact states, as digits or number words. */
function factValues(fact) {
  const values = new Set();
  if (typeof fact.value === 'number') values.add(fact.value);
  const text = String(fact.text ?? '');
  for (const m of text.matchAll(DIGITS_RE)) values.add(parseDigits(m[0]));
  const anyWord = new RegExp(`\\b(${NUMBER_WORD_ALT})\\b`, 'gi');
  for (const m of text.matchAll(anyWord)) {
    const value = wordValue(m[1]);
    if (value !== undefined) values.add(value);
  }
  return values;
}

/**
 * Validate a model answer against the context (R6 steps 1, 2 and 4, plus the
 * quantity and content checks). Throws LineError('validation') on failure.
 * @returns {{ text: string, factIds: string[] }}
 */
export function validateLine(answer, ctx, recentSpoken = []) {
  const fail = (msg) => {
    throw new LineError('validation', msg);
  };
  if (!answer || typeof answer.line !== 'string') fail('missing "line"');
  const text = answer.line.trim();
  if (!text) fail('empty line');
  const factIds = answer.factIds ?? [];
  if (!Array.isArray(factIds) || factIds.some((id) => typeof id !== 'string')) {
    fail('"factIds" is not a string array');
  }

  if (text.length > MAX_CHARS) fail(`line is ${text.length} characters (max ${MAX_CHARS})`);
  const sentences = countSentences(text);
  if (sentences < 1 || sentences > MAX_SENTENCES) fail(`line has ${sentences} sentences`);

  const byId = new Map(ctx.facts.map((f) => [f.id, f]));
  const unknown = factIds.filter((id) => !byId.has(id));
  if (unknown.length) fail(`unknown fact ids: ${unknown.join(', ')}`);

  if (recentSpoken.slice(-REPEAT_WINDOW).includes(text)) fail('exact repeat of a recent line');

  const cited = new Set();
  for (const id of factIds) for (const v of factValues(byId.get(id))) cited.add(v);
  const unsupported = extractQuantities(text).filter((q) => !cited.has(q));
  if (unsupported.length) fail(`quantity not in cited facts: ${unsupported.join(', ')}`);

  if (!isClean(text)) fail('line failed the content filter');

  return { text, factIds };
}

// ---------------------------------------------------------------------------
// Writer
// ---------------------------------------------------------------------------

/** The user payload for the line prompt (contracts §5a). */
export function buildPayload(ctx) {
  return {
    next: ctx.next,
    previous: ctx.previous,
    theme: ctx.theme,
    allowedNames: ctx.allowedNames ?? [],
    facts: ctx.facts.map(({ id, text }) => ({ id, text })),
    recentLines: (ctx.recentLines ?? []).slice(-PROMPT_RECENT)
  };
}

/**
 * Generate, validate and voice one line for the context's target track.
 * @param {Object} ctx - Listening Context from buildContext()
 * @param {string[]} [recentSpoken] - Last spoken texts, oldest first
 * @returns {Promise<{forKey: string, text: string, pcm: Buffer, factIds: string[], namedUserIds: string[], preparedAt: number}>}
 * @throws {LineError}
 */
export async function writeLine(ctx, recentSpoken = []) {
  const prompted = { ...ctx, recentLines: recentSpoken.slice(-PROMPT_RECENT) };

  let answer;
  try {
    answer = await chatJson({
      system: SYSTEM_PROMPT,
      user: buildPayload(prompted),
      temperature: LLM_TEMPERATURE,
      timeoutMs: LLM_TIMEOUT_MS
    });
  } catch (error) {
    const kind = error?.name === 'SyntaxError' ? 'validation' : 'llm';
    throw new LineError(kind, `LLM call failed: ${error?.message ?? error}`, error);
  }

  const { text, factIds } = validateLine(answer, ctx, recentSpoken);

  let pcm;
  try {
    pcm = await synthesize(text);
  } catch (error) {
    throw new LineError(error?.kind ?? 'tts', `TTS failed: ${error?.message ?? error}`, error);
  }

  return { forKey: ctx.forKey, text, pcm, factIds, namedUserIds: [], preparedAt: Date.now() };
}
