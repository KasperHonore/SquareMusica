/**
 * Listening Context for a DJ line (data-model.md, research R6).
 *
 * Built deterministically per preparation and never stored. The LLM only ever
 * sees these facts, so every claim a line can make is traceable to one.
 * US1 provides `track` facts (previous and next) and a `theme` fact; member and
 * group facts arrive with US3 through addMemberFacts().
 */

/**
 * Stable identity of a queue entry across resolution (R5): the URL once
 * resolved, else the Spotify id, else title plus the time it was queued.
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

/** Artist for a track: Spotify's first artist, else the YouTube channel. */
function trackArtist(track) {
  return track.spotifyData?.artists?.[0] ?? track.channel ?? null;
}

function toTrackFact(id, track) {
  if (!track) return null;
  return { id, title: track.title, artist: trackArtist(track) };
}

function describe(track) {
  return track.artist ? `"${track.title}" by ${track.artist}` : `"${track.title}"`;
}

/**
 * Extension point for US3: member and group facts, allowed and forbidden
 * names. Returns the context unchanged until then.
 * @param {Object} ctx
 * @returns {Object}
 */
export function addMemberFacts(ctx) {
  return ctx;
}

/**
 * Build the Listening Context for the transition into `next`.
 *
 * @param {Object} params
 * @param {Object|null} params.previous - The track playing now (spoken about as "previous")
 * @param {Object} params.next - The track the line will be spoken over
 * @param {string|null} [params.theme]
 * @param {Array<{userId: string, speakableName: string|null, optedOut: boolean}>} [params.present]
 * @param {string[]} [params.recentLines] - The DJ's own recent lines (only the last 5 are kept)
 * @returns {Object} Listening Context
 */
export function buildContext({ previous, next, theme = null, present = [], recentLines = [] }) {
  const nextFact = toTrackFact('t2', next);
  const previousFact = toTrackFact('t1', previous);

  const facts = [];
  let n = 0;
  const addFact = (kind, text, extra = {}) => facts.push({ id: `f${++n}`, kind, text, ...extra });

  addFact('track', `Up next: ${describe(nextFact)}.`);
  if (previousFact) addFact('track', `Just played: ${describe(previousFact)}.`);
  if (theme) addFact('theme', `Tonight's theme: ${theme}.`);

  return addMemberFacts({
    forKey: trackKey(next),
    previous: previousFact,
    next: nextFact,
    theme: theme ?? null,
    present,
    allowedNames: [],
    facts,
    recentLines: recentLines.slice(-5)
  });
}
