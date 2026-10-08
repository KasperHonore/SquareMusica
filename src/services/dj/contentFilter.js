/**
 * Last-line check that no DJ line contains a slur or harassment (spec edge
 * case). The system prompt already forbids these; this catches the model
 * ignoring it. Terms are lowercase and matched case-insensitively on word
 * boundaries, so "skill" never matches "kill yourself".
 */
export const BLOCKED_TERMS = [
  'chink',
  'cunt',
  'dyke',
  'fag',
  'faggot',
  'gook',
  'idiot',
  'kike',
  'kill yourself',
  'kys',
  'moron',
  'nigga',
  'nigger',
  'retard',
  'retarded',
  'slut',
  'spic',
  'tranny',
  'wetback',
  'whore'
];

function escape(term) {
  return term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+');
}

const PATTERN = new RegExp(`\\b(?:${BLOCKED_TERMS.map(escape).join('|')})\\b`, 'i');

/**
 * @param {string} text
 * @returns {boolean} True when no blocked term appears
 */
export function isClean(text) {
  return !PATTERN.test(text);
}
