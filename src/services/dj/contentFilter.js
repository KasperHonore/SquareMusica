/**
 * Last-line content filter for anything the DJ says or is asked to theme
 * (spec edge case: no slurs or harassment). The LLM prompt already forbids
 * this; the filter catches what slips through. Terms are matched
 * case-insensitively on word boundaries, so "class" never matches "ass".
 */

// Lowercase. Slurs and direct harassment terms; extend as needed.
const BLOCKED_TERMS = [
  'chink',
  'coon',
  'dyke',
  'faggot',
  'fag',
  'gook',
  'kike',
  'kys',
  'kill yourself',
  'nigga',
  'nigger',
  'paki',
  'raghead',
  'retard',
  'retarded',
  'spic',
  'tranny',
  'wetback',
  'cunt',
  'whore',
  'slut',
  'go die',
  'nobody likes you',
  'you are worthless',
  "you're worthless",
  'loser'
];

const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const BLOCKED_RE = new RegExp(
  `(?<![\\p{L}\\p{N}])(?:${BLOCKED_TERMS.map(escape).join('|')})(?![\\p{L}\\p{N}])`,
  'iu'
);

/**
 * Whether text is free of every blocked term.
 * @param {string} text
 * @returns {boolean}
 */
export function isClean(text) {
  if (typeof text !== 'string') return false;
  // Normalise curly apostrophes so "you’re worthless" matches too.
  return !BLOCKED_RE.test(text.replace(/[‘’]/g, "'"));
}
