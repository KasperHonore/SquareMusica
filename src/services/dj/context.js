// The Listening Context for one DJ line (data-model.md). Built deterministically
// per preparation and never stored: the LLM may only use the facts listed here
// (research R6), which is what makes every claim checkable before TTS.

/**
 * Stable identity of a queue entry across the time between preparing a line and
 * speaking it (R5). Lazily resolved Spotify tracks have `url: null` until played.
 * @param {Object|null} track
 * @returns {string|null}
 */
export function trackKey(track) {
  if (!track) return null;
  if (track.url) return track.url;
  if (track.spotifyData?.spotifyId) return track.spotifyData.spotifyId;
  const addedAt = track.addedAt instanceof Date ? track.addedAt.toISOString() : track.addedAt;
  return `${track.title}|${addedAt}`;
}

/**
 * Whether `key` (a trackKey() taken earlier) still names `track`. A lazily
 * resolved Spotify entry is keyed by its spotifyId until resolution sets `url`,
 * so the key taken while preparing a line can differ from the key at speak time;
 * both identities are accepted.
 * @param {string|null} key
 * @param {Object|null} track
 * @returns {boolean}
 */
export function keyMatches(key, track) {
  if (!key || !track) return false;
  return key === trackKey(track) || key === track.spotifyData?.spotifyId;
}

function artistOf(track) {
  return track.spotifyData?.artists?.[0] ?? track.channel ?? null;
}

function trackFact(track, id) {
  return { id, title: track.title, artist: artistOf(track) };
}

function describeTrack(label, track) {
  const artist = artistOf(track);
  return artist ? `${label} is "${track.title}" by ${artist}.` : `${label} is "${track.title}".`;
}

/**
 * Member and group facts (FR-016–FR-020). Added in US3; until then the context
 * carries no member data at all.
 * @param {Object} ctx
 * @returns {Object}
 */
export function addMemberFacts(ctx) {
  return ctx;
}

/**
 * Build the Listening Context for the transition into `next`. The track's queuer
 * is not included here; that needs the member rules from US3.
 * @param {{ previous: Object|null, next: Object, theme?: string|null,
 *   present?: Array, recentLines?: string[] }} params
 * @returns {Object}
 */
export function buildContext({ previous, next, theme = null, present = [], recentLines = [] }) {
  const facts = [];
  let factSeq = 0;
  const addFact = (kind, text) => facts.push({ id: `f${++factSeq}`, kind, text });

  if (previous) addFact('track', describeTrack('The previous track', previous));
  addFact('track', describeTrack('The next track', next));
  if (theme) addFact('theme', `Tonight's theme is "${theme}".`);

  return addMemberFacts({
    forKey: trackKey(next),
    previous: previous ? trackFact(previous, 't1') : null,
    next: trackFact(next, 't2'),
    theme,
    present,
    allowedNames: [],
    facts,
    recentLines: recentLines.slice(-5)
  });
}
