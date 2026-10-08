// Last-line content check for DJ text (spec edge case: no slurs or harassment).
// The system prompt already forbids these; this list catches what slips through
// before anything is spoken. Terms are lowercase and matched case-insensitively
// on word boundaries, with an optional plural suffix.

export const BLOCKED_TERMS = [
  // Harassment
  'kill yourself',
  'kys',
  'go die',
  'neck yourself',
  'retard',
  'retarded',
  // Slurs
  'nigger',
  'nigga',
  'faggot',
  'fag',
  'dyke',
  'tranny',
  'chink',
  'gook',
  'spic',
  'wetback',
  'kike',
  'raghead',
  'towelhead',
  'paki',
  'coon',
  'beaner',
  'gypsy',
  'spastic',
  'whore',
  'slut',
  'cunt'
];

function escape(term) {
  return term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+');
}

const BLOCKED_RE = new RegExp(`\\b(?:${BLOCKED_TERMS.map(escape).join('|')})(?:s|es)?\\b`, 'i');

/**
 * @param {string} text
 * @returns {boolean} True when the text contains no blocked term
 */
export function isClean(text) {
  return !BLOCKED_RE.test(String(text ?? ''));
}
