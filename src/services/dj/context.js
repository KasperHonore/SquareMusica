/**
 * Listening Context for one DJ line (data-model.md). Built deterministically
 * from the queue so the model only ever sees facts we know are true (R6).
 * Never stored.
 */

/**
 * Stable identity of a queue entry across resolution (R5): the YouTube URL once
 * resolved, else the Spotify id, else title plus enqueue time.
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
 * Whether `key` (from trackKey at preparation time) names `track`. Lookahead
 * resolution sets `url` on a Spotify entry after its key was taken, so every
 * identity the entry has ever had is accepted.
 * @param {string|null} key
 * @param {Object|null} track
 * @returns {boolean}
 */
export function matchesKey(key, track) {
  if (!key || !track) return false;
  if (key === trackKey(track)) return true;
  if (track.url && key === track.url) return true;
  if (track.spotifyData?.spotifyId && key === track.spotifyData.spotifyId) return true;
  const addedAt = track.addedAt instanceof Date ? track.addedAt.toISOString() : track.addedAt;
  return key === `${track.title}|${addedAt}`;
}

/** Artist for a fact: Spotify artists when known, else the YouTube channel. */
function artistOf(track) {
  const artists = track.spotifyData?.artists;
  if (Array.isArray(artists) && artists.length > 0) return artists.join(', ');
  return track.channel || null;
}

function trackFact(track, id) {
  return { id, title: track.title, artist: artistOf(track) };
}

function describe(fact) {
  return fact.artist ? `"${fact.title}" by ${fact.artist}` : `"${fact.title}"`;
}

/**
 * Member and group facts (FR-016–FR-020) arrive with US3. Until then the
 * context carries track and theme facts only.
 * @param {Object} ctx
 * @returns {Object}
 */
export function addMemberFacts(ctx) {
  return ctx;
}

/**
 * @param {Object} params
 * @param {Object|null} params.previous - The track playing now (it will have
 *   just ended when the line is spoken)
 * @param {Object} params.next - The track the line will be spoken over
 * @param {string|null} [params.theme]
 * @param {Array<{ id: string }>} [params.present] - Humans in the voice channel
 * @param {string[]} [params.recentLines] - The DJ's own last lines
 * @returns {Object} Listening Context
 */
export function buildContext({ previous, next, theme = null, present = [], recentLines = [] }) {
  const facts = [];
  const nextFact = trackFact(next, 't-next');
  facts.push({ id: 'f-next', kind: 'track', text: `Up next: ${describe(nextFact)}.` });

  const previousFact = previous ? trackFact(previous, 't-previous') : null;
  if (previousFact) {
    facts.push({
      id: 'f-previous',
      kind: 'track',
      text: `Just played: ${describe(previousFact)}.`
    });
  }

  if (theme) {
    facts.push({ id: 'f-theme', kind: 'theme', text: `Tonight's theme: ${theme}.` });
  }

  const ctx = {
    forKey: trackKey(next),
    previous: previousFact,
    next: nextFact,
    theme: theme || null,
    present: present.map((user) => ({ userId: user.id, speakableName: null, optedOut: false })),
    allowedNames: [],
    facts,
    recentLines: recentLines.slice(-5)
  };
  return addMemberFacts(ctx);
}
