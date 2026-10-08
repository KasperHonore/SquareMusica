/**
 * Last-line check that a DJ line contains no slurs or harassment (spec edge
 * case). The system prompt already forbids them; this catches what slips
 * through. Terms are lowercase and matched case-insensitively on word
 * boundaries, so "class" never matches "ass".
 */
export const BLOCKED_TERMS = [
  'chink',
  'cunt',
  'dyke',
  'fag',
  'faggot',
  'gook',
  'kike',
  'kill yourself',
  'kys',
  'nigga',
  'nigger',
  'paki',
  'raghead',
  'retard',
  'retarded',
  'slut',
  'spic',
  'tranny',
  'wetback',
  'whore'
];

function escape(term) {
  return term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/ /g, '\\s+');
}

const BLOCKED_PATTERN = new RegExp(`\\b(?:${BLOCKED_TERMS.map(escape).join('|')})\\b`, 'i');

/**
 * @param {string} text
 * @returns {boolean} True when no blocked term appears
 */
export function isClean(text) {
  return !BLOCKED_PATTERN.test(text);
}
