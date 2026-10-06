// Blocklist for anything the DJ says or is asked to theme around (spec edge
// case: same content limits as the rest of the server, no slurs or harassment).
// A last line of defence behind the prompt, not a moderation system.

/** Lowercase slurs and harassment terms, matched on word boundaries. */
export const BLOCKED_TERMS = [
  'chink',
  'coon',
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
  'spic',
  'tranny',
  'wetback'
];

function escape(term) {
  return term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/ /g, '\\s+');
}

const BLOCKED_RE = new RegExp(`\\b(?:${BLOCKED_TERMS.map(escape).join('|')})(?:s|es)?\\b`, 'i');

/**
 * @param {string} text
 * @returns {boolean} False when the text contains a blocked term
 */
export function isClean(text) {
  return !BLOCKED_RE.test(String(text ?? ''));
}
