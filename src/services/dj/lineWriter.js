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
  'The line must mention the next track or the previous track (its title or artist)',
  'and cite that track fact in factIds.',
  'Use ONLY the facts provided. Never invent play counts, dates, people or connections.',
  'Only name people listed under allowedNames; if it is empty, name nobody.',
  'Spell every number out as words. No emoji. No insults, slurs or harassment, and no',
  'personal information beyond the provided facts.',
  'Do not repeat or closely paraphrase anything in recentLines.',
  'Return JSON: {"line": string, "factIds": string[]} where factIds lists the ids of',
  'the facts the line uses.'
].join(' ');

// Themed intro (FR-028): same rules, but the line opens the set for the theme.
export const INTRO_SYSTEM_PROMPT = [
  'You are the SquareMusica radio DJ, talking to friends in a Discord voice channel.',
  'A themed set is starting (or its theme just changed). Write ONE or TWO short, upbeat',
  'sentences introducing the theme, said over the start of the next song; you may also',
  'introduce that song. Cite the theme fact in factIds.',
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

/** Replace each known title or artist in `text` with a placeholder. */
function maskPhrases(text, phrases, flags = 'gi') {
  let masked = text;
  for (const phrase of [...phrases].sort((a, b) => b.length - a.length)) {
    if (phrase) masked = masked.replace(new RegExp(escapeRe(phrase), flags), 'X');
  }
  return masked;
}

/**
 * Sentence count. Terminators inside quotes, common abbreviations ("Mr."), and
 * known titles or artists ("P.O.D.") don't end a sentence.
 * @param {string} text
 * @param {string[]} [phrases] - titles and artists to mask first
 */
export function countSentences(text, phrases = []) {
  const masked = maskPhrases(text, phrases)
    .replace(/"[^"]*"|“[^”]*”/g, 'X')
    .replace(ABBREVIATIONS, 'X');
  const terminators = masked.match(/[.!?…]+(?=\s|$)/g) ?? [];
  const trailing = /[.!?…]\s*$/.test(masked);
  return terminators.length + (trailing ? 0 : 1);
}

/** Whether `text` contains `name` as a whole word or phrase, case-insensitively. */
function mentions(text, name) {
  if (!name) return false;
  return new RegExp(`(?<![\\p{L}\\p{N}])${escapeRe(name)}(?![\\p{L}\\p{N}])`, 'iu').test(text);
}

/**
 * Whether `text` uses a forbidden `name` as a name. Most names match
 * case-insensitively. A `lenient` name (a history username with no link to anyone
 * seen in voice) that is a single all-lowercase word such as "music" or "party"
 * is also an ordinary word, so it only counts when written capitalised
 * mid-sentence, or in capitals. Display names and present members' usernames are
 * never lenient: Discord falls back to the lowercase username as the display
 * name, and "Kasper, this one's for you" must still be caught.
 */
function namesForbidden(text, name, lenient = false) {
  if (!name) return false;
  if (!lenient || !/^\p{Ll}+$/u.test(name)) return mentions(text, name);
  const re = new RegExp(`(?<![\\p{L}\\p{N}])${escapeRe(name)}(?![\\p{L}\\p{N}])`, 'giu');
  for (const m of text.matchAll(re)) {
    const word = m[0];
    if (word === word.toLowerCase()) continue;
    const sentenceStart = /(?:^|[.!?…]\s+)$/u.test(text.slice(0, m.index));
    if (sentenceStart && word.slice(1) === word.slice(1).toLowerCase()) continue;
    return true;
  }
  return false;
}

// Claims about a member's own history ("played it three times", "your
// favourite") and about who queued a track. A named member is only the subject
// of such a claim when a cited fact is about them (FR-005, FR-018).
const PLAY_CLAIM_RE =
  /\b(?:played|plays|spins|spun|favou?rites?|most[- ]played|on repeat|constantly|loves?)\b/i;
const QUEUE_CLAIM_RE =
  /\b(?:queued?|queues|queuing|queueing|picked|picks|requested|chose|choice)\b/i;

// A connection between the track and the people listening ("a room
// favourite", "you all love this one") needs a cited member or group fact
// (US3/AC4). Plain "played" is left out so "we just played X" stays a music line.
const CONNECTION_CLAIM_RE =
  /\b(?:favou?rites?|most[- ]played|on repeat|constantly|loves?|(?:played|plays|spun|spins|queued|requested)\s+(?:it|this)\b)/i;
// A pronoun or "you" in a sentence that names nobody refers back to the members
// named in the sentence before it.
const PRONOUN_RE = /\b(?:he|she|they|him|her|them|his|hers|their|theirs|you|your|yours)\b/i;

function splitSentences(text) {
  return text.split(/(?<=[.!?…])\s+/).filter((part) => part.trim());
}

/**
 * Reject a claim attributed to an allowed member that their own cited facts do
 * not back: a quantity, a play-history claim, or a queue claim in a sentence
 * that names them, or that refers back to them by pronoun (US3/AC1: every claim
 * is true).
 * @returns {string|null} why the line is rejected
 */
function misattributedClaim(text, ctx, citedFacts, phrases) {
  const members = ctx.allowedMembers ?? [];
  if (members.length === 0) return null;
  let previousNamed = [];
  for (const sentence of splitSentences(maskPhrases(text, phrases))) {
    let named = members.filter((m) => mentions(sentence, m.name));
    if (named.length === 0 && PRONOUN_RE.test(sentence)) named = previousNamed;
    previousNamed = named;
    if (named.length === 0) continue;
    const namedIds = new Set(named.map((m) => m.userId));
    const factsOf = (userId, kind) =>
      citedFacts.filter((f) => f.userId === userId && f.kind === kind);

    const backed = new Set();
    for (const fact of citedFacts) {
      if (fact.kind === 'member' && namedIds.has(fact.userId)) {
        for (const n of factNumbers(fact)) backed.add(n);
      }
    }
    const loose = quantitiesIn(sentence).filter((q) => !backed.has(q));
    if (loose.length > 0) return `quantity ${loose.join(', ')} not about the member named`;

    for (const member of named) {
      if (PLAY_CLAIM_RE.test(sentence) && factsOf(member.userId, 'member').length === 0) {
        return `play history claimed for ${member.name} without their fact`;
      }
      if (QUEUE_CLAIM_RE.test(sentence) && factsOf(member.userId, 'track').length === 0) {
        return `queue claimed for ${member.name} without their fact`;
      }
    }
  }
  return null;
}

/**
 * Discord ids of the allowed members a line names (data-model.md DJ Line
 * `namedUserIds`); the planner re-checks these right before speaking.
 * @param {string} text
 * @param {Object} ctx
 * @returns {string[]}
 */
export function namedUserIdsIn(text, ctx) {
  return (ctx.allowedMembers ?? [])
    .filter((member) => mentions(text, member.name))
    .map((member) => member.userId);
}

function normalise(text) {
  return text.trim().replace(/\s+/g, ' ').toLowerCase();
}

/**
 * Validate a model response against the context (R6 steps 1–4, plus the FR-005
 * quantity check and the content filter).
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
  const phrases = [ctx.previous, ctx.next]
    .flatMap((t) => (t ? [t.title, t.artist] : []))
    .concat(ctx.theme ? [ctx.theme] : [])
    .filter(Boolean);
  const sentences = countSentences(text, phrases);
  if (sentences < 1 || sentences > MAX_SENTENCES) reject(`${sentences} sentences`);

  const factsById = new Map((ctx.facts ?? []).map((f) => [f.id, f]));
  const unknown = factIds.filter((id) => !factsById.has(id));
  if (unknown.length > 0) reject(`unknown fact ids ${unknown.join(', ')}`);
  if (ctx.intro) {
    // FR-028: the themed intro is about the theme.
    if (!factIds.some((id) => factsById.get(id).kind === 'theme')) reject('cites no theme fact');
  } else if (!factIds.some((id) => factsById.get(id).kind === 'track')) {
    // US1/AC1: every line introduces the next track or looks back at the last one.
    reject('cites no track fact');
  }

  const allowed = new Set();
  for (const id of factIds) for (const n of factNumbers(factsById.get(id))) allowed.add(n);
  const unsupported = quantitiesIn(text).filter((q) => !allowed.has(q));
  if (unsupported.length > 0) reject(`unsupported quantity ${unsupported.join(', ')}`);

  // R6 step 3: no forbidden name (a known member or a present member who isn't
  // allowed). Titles and artists are masked first so a band that shares a
  // member's name can still be introduced.
  const unmasked = maskPhrases(text, phrases);
  const lenient = new Set(ctx.lenientNames ?? []);
  const forbidden = (ctx.forbiddenNames ?? []).find((name) =>
    namesForbidden(unmasked, name, lenient.has(name))
  );
  if (forbidden) reject('names a member who may not be named');
  const cited = factIds.map((id) => factsById.get(id));
  if (
    CONNECTION_CLAIM_RE.test(unmasked) &&
    !cited.some((f) => f.kind === 'member' || f.kind === 'group')
  ) {
    reject('claims a connection with the listeners without a member or group fact');
  }
  const misattributed = misattributedClaim(text, ctx, cited, phrases);
  if (misattributed) reject(misattributed);

  // Real titles and artists can contain a blocked word (e.g. "Gypsy"); the
  // filter judges what the model added around them. Masking is case-sensitive
  // so the same word used in passing, in lower case, is still caught.
  if (!isClean(maskPhrases(text, phrases, 'g'))) reject('content filter');

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
    ...(ctx.intro ? { intro: true } : {}),
    allowedNames: ctx.allowedNames ?? [],
    facts: (ctx.facts ?? []).map(({ id, text }) => ({ id, text })),
    recentLines: recentSpoken.slice(-PROMPT_RECENT)
  };

  let response;
  try {
    response = await chatJson({
      system: ctx.intro ? INTRO_SYSTEM_PROMPT : SYSTEM_PROMPT,
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

  return {
    forKey: ctx.forKey,
    text,
    pcm,
    factIds,
    namedUserIds: namedUserIdsIn(text, ctx),
    preparedAt: Date.now()
  };
}
