import { chatJson } from '../../integrations/llm.js';
import { synthesize } from '../../integrations/elevenlabs.js';
import { isClean } from './contentFilter.js';

// Writes one DJ line: asks the LLM for text grounded in the context's facts,
// validates it (research R6), and only then pays for TTS (contracts §5a).

const MAX_CHARS = 240;
const MAX_SENTENCES = 2;
const REPEAT_WINDOW = 20;
const PROMPT_RECENT = 5;

export const SYSTEM_PROMPT = [
  'You are the SquareMusica radio DJ, talking to friends in a Discord voice channel.',
  'Write ONE or TWO short, upbeat sentences to say over the start of the next song.',
  'Use ONLY the facts provided. Never invent play counts, dates, people or connections.',
  'Only name people listed under allowedNames; if it is empty, name nobody.',
  'Spell every number out as words. No emoji. No insults, slurs or harassment, and no',
  'personal information beyond the provided facts.',
  'Do not repeat or closely paraphrase anything in recentLines.',
  'Return JSON: {"line": string, "factIds": string[]} where factIds lists the ids of',
  'the facts the line uses.'
].join(' ');

/** Error thrown by writeLine(); `kind` feeds the DJ circuit breaker. */
export class LineError extends Error {
  /**
   * @param {'llm'|'tts'|'quota'|'validation'} kind
   * @param {string} message
   * @param {unknown} [cause]
   */
  constructor(kind, message, cause) {
    super(message);
    this.name = 'LineError';
    this.kind = kind;
    if (cause !== undefined) this.cause = cause;
  }
}

// --- Validation helpers -------------------------------------------------------

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

// Every English number word from zero to one hundred, longest first so the
// regex prefers "twenty-one" over "twenty".
const NUMBER_WORDS = new Map();
UNITS.forEach((w, i) => NUMBER_WORDS.set(w, i));
for (let t = 2; t <= 9; t++) {
  NUMBER_WORDS.set(TENS[t], t * 10);
  for (let u = 1; u <= 9; u++) {
    NUMBER_WORDS.set(`${TENS[t]}-${UNITS[u]}`, t * 10 + u);
    NUMBER_WORDS.set(`${TENS[t]} ${UNITS[u]}`, t * 10 + u);
  }
}
NUMBER_WORDS.set('one hundred', 100);
NUMBER_WORDS.set('a hundred', 100);
NUMBER_WORDS.set('hundred', 100);

const NUMBER_WORD_ALT = [...NUMBER_WORDS.keys()]
  .sort((a, b) => b.length - a.length)
  .map((w) => w.replace(/ /g, '\\s+'))
  .join('|');
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
const COUNT_NOUN_ALT = COUNT_NOUNS.map((n) => n.replace(/ /g, '\\s+')).join('|');

// A number word is a quantity only when a count noun follows it immediately, so
// "this one's for you" and "one more classic" are ordinary words.
const WORD_QUANTITY_RE = new RegExp(`\\b(${NUMBER_WORD_ALT})\\s+(?:${COUNT_NOUN_ALT})\\b`, 'gi');
const DIGITS_RE = /\d+(?:\.\d+)?/g;
const ANY_NUMBER_WORD_RE = new RegExp(`\\b(${NUMBER_WORD_ALT})\\b`, 'gi');

function wordValue(word) {
  return NUMBER_WORDS.get(word.toLowerCase().replace(/\s+/g, ' '));
}

/** The quantities a line claims: every digit run, and number word + count noun. */
export function quantitiesIn(text) {
  const out = [];
  for (const m of text.matchAll(DIGITS_RE)) out.push(Number(m[0]));
  for (const m of text.matchAll(WORD_QUANTITY_RE)) out.push(wordValue(m[1]));
  return out;
}

/** Every numeric value a fact carries, as digits, words or a `value` field. */
function factNumbers(fact) {
  const out = new Set();
  if (typeof fact.value === 'number') out.add(fact.value);
  const text = String(fact.text ?? '');
  for (const m of text.matchAll(DIGITS_RE)) out.add(Number(m[0]));
  for (const m of text.matchAll(ANY_NUMBER_WORD_RE)) out.add(wordValue(m[1]));
  return out;
}

const ABBREVIATIONS = /\b(?:mr|mrs|ms|dr|st|jr|sr|vs|feat|ft|vol|no|pt|mt)\./gi;

function escapeRe(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Sentence count. Terminators inside quotes, common abbreviations ("Mr."), and
 * known titles or artists ("P.O.D.") don't end a sentence.
 * @param {string} text
 * @param {string[]} [phrases] - titles and artists to mask first
 */
export function countSentences(text, phrases = []) {
  let masked = text;
  for (const phrase of [...phrases].sort((a, b) => b.length - a.length)) {
    if (phrase) masked = masked.replace(new RegExp(escapeRe(phrase), 'gi'), 'X');
  }
  masked = masked.replace(/"[^"]*"|“[^”]*”/g, 'X').replace(ABBREVIATIONS, 'X');
  const terminators = masked.match(/[.!?…]+(?=\s|$)/g) ?? [];
  const trailing = /[.!?…]\s*$/.test(masked);
  return terminators.length + (trailing ? 0 : 1);
}

function normalise(text) {
  return text.trim().replace(/\s+/g, ' ').toLowerCase();
}

/**
 * Validate a model response against the context (R6 steps 1, 2 and 4, plus the
 * FR-005 quantity check and the content filter). Step 3 (forbidden names) is
 * added in US3.
 * @param {unknown} response
 * @param {Object} ctx
 * @param {string[]} recentSpoken
 * @returns {{ text: string, factIds: string[] }}
 * @throws {LineError}
 */
export function validateLine(response, ctx, recentSpoken = []) {
  const reject = (why) => {
    throw new LineError('validation', `Line rejected: ${why}`);
  };

  const text = typeof response?.line === 'string' ? response.line.trim() : '';
  const factIds = response?.factIds;
  if (!text) reject('no line');
  if (!Array.isArray(factIds) || factIds.some((id) => typeof id !== 'string')) {
    reject('factIds is not a string list');
  }

  if (text.length > MAX_CHARS) reject(`${text.length} characters`);
  const phrases = [ctx.previous, ctx.next].flatMap((t) => (t ? [t.title, t.artist] : []));
  const sentences = countSentences(text, phrases.filter(Boolean));
  if (sentences < 1 || sentences > MAX_SENTENCES) reject(`${sentences} sentences`);

  const factsById = new Map((ctx.facts ?? []).map((f) => [f.id, f]));
  const unknown = factIds.filter((id) => !factsById.has(id));
  if (unknown.length > 0) reject(`unknown fact ids ${unknown.join(', ')}`);

  const allowed = new Set();
  for (const id of factIds) for (const n of factNumbers(factsById.get(id))) allowed.add(n);
  const unsupported = quantitiesIn(text).filter((q) => !allowed.has(q));
  if (unsupported.length > 0) reject(`unsupported quantity ${unsupported.join(', ')}`);

  if (!isClean(text)) reject('content filter');

  const key = normalise(text);
  if (recentSpoken.slice(-REPEAT_WINDOW).some((line) => normalise(line) === key)) {
    reject('repeat of a recent line');
  }

  return { text, factIds };
}

/**
 * Write, validate and voice one DJ line for the transition into `ctx.next`.
 * @param {Object} ctx - Listening Context from buildContext()
 * @param {string[]} [recentSpoken] - texts spoken so far, oldest first
 * @returns {Promise<{ forKey: string, text: string, pcm: Buffer, factIds: string[],
 *   namedUserIds: string[], preparedAt: number }>}
 * @throws {LineError}
 */
export async function writeLine(ctx, recentSpoken = []) {
  const payload = {
    next: ctx.next,
    previous: ctx.previous,
    theme: ctx.theme ?? null,
    allowedNames: ctx.allowedNames ?? [],
    facts: (ctx.facts ?? []).map(({ id, text }) => ({ id, text })),
    recentLines: recentSpoken.slice(-PROMPT_RECENT)
  };

  let response;
  try {
    response = await chatJson({
      system: SYSTEM_PROMPT,
      user: JSON.stringify(payload),
      temperature: 0.9,
      timeoutMs: 10000
    });
  } catch (error) {
    throw new LineError('llm', error.message, error);
  }

  const { text, factIds } = validateLine(response, ctx, recentSpoken);

  let pcm;
  try {
    pcm = await synthesize(text);
  } catch (error) {
    throw new LineError(error?.kind === 'quota' ? 'quota' : 'tts', error.message, error);
  }

  return { forKey: ctx.forKey, text, pcm, factIds, namedUserIds: [], preparedAt: Date.now() };
}
