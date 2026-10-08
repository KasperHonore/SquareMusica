/**
 * Builds the Listening Context the line writer is allowed to talk about
 * (data-model.md, research R6). Deterministic: the LLM only ever sees the facts
 * produced here, never raw history. MUST NOT import src/transports/.
 */

/**
 * Stable identity of a queue entry across a transition (research R5).
 * Lazily resolved Spotify tracks have `url: null` until played, so fall back
 * to the Spotify id, then to title plus the time it was queued.
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

function trackArtist(track) {
  return track.spotifyData?.artists?.[0] ?? track.channel ?? null;
}

function toTrackFact(track, id) {
  return { id, key: trackKey(track), title: track.title, artist: trackArtist(track) };
}

function describeTrack(label, fact) {
  return fact.artist
    ? `${label}: "${fact.title}" by ${fact.artist}.`
    : `${label}: "${fact.title}".`;
}

/**
 * Extension point for member and group facts (US3). Returns ctx unchanged.
 * @param {Object} ctx
 * @returns {Object}
 */
export function addMemberFacts(ctx) {
  return ctx;
}

/**
 * @param {Object} params
 * @param {Object|null} params.previous - The track that just played, if any
 * @param {Object} params.next - The track the line will be spoken over
 * @param {string|null} [params.theme]
 * @param {Array<{ userId: string, speakableName: string|null, optedOut: boolean }>} [params.present]
 * @param {string[]} [params.recentLines]
 * @returns {Object} Listening Context
 */
export function buildContext({ previous, next, theme = null, present = [], recentLines = [] }) {
  const nextFact = toTrackFact(next, 't2');
  const previousFact = previous ? toTrackFact(previous, 't1') : null;

  const facts = [{ id: 'f1', kind: 'track', text: describeTrack('Up next', nextFact) }];
  if (previousFact) {
    facts.push({ id: 'f2', kind: 'track', text: describeTrack('Just played', previousFact) });
  }
  if (theme) {
    facts.push({ id: `f${facts.length + 1}`, kind: 'theme', text: `Tonight's theme: ${theme}.` });
  }

  return addMemberFacts({
    previous: previousFact,
    next: nextFact,
    theme,
    present,
    allowedNames: [],
    facts,
    recentLines: recentLines.slice(-5)
  });
}
