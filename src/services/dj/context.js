// Builds the Listening Context a DJ line is written from (data-model.md, research
// R6). The LLM never sees raw history: only the facts assembled here, so every
// claim a line makes can be checked against them before it is spoken (FR-005).

/**
 * Stable identity for a queue entry, used to match a prepared line to the track
 * that actually starts (R5). Lazily resolved Spotify tracks have `url: null`
 * until they are played.
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
 * Whether `track` is the track a line was prepared for. A lazily resolved
 * Spotify track is keyed by its Spotify id while queued and by its URL once it
 * resolves, which happens as it starts, so either identity matches.
 * @param {string|null} key - A key from trackKey()
 * @param {Object|null} track
 * @returns {boolean}
 */
export function isSameTrack(key, track) {
  if (!key || !track) return false;
  return key === trackKey(track) || key === track.spotifyData?.spotifyId;
}

function artistOf(track) {
  return track.spotifyData?.artists?.[0] ?? track.channel ?? null;
}

function trackFact(track, id) {
  return { id, title: track.title, artist: artistOf(track) };
}

function describe(track) {
  const artist = artistOf(track);
  return artist ? `"${track.title}" by ${artist}` : `"${track.title}"`;
}

/**
 * Member and group facts (FR-016–FR-020) are added in US3. Until then this
 * returns the context unchanged.
 * @param {Object} ctx
 * @returns {Object}
 */
export function addMemberFacts(ctx) {
  return ctx;
}

/**
 * @param {Object} params
 * @param {Object|null} params.previous - The track playing now, which will have
 *   just ended when the line is spoken
 * @param {Object} params.next - The predicted next track
 * @param {string|null} [params.theme]
 * @param {Array<{ userId: string, speakableName: string|null, optedOut: boolean }>} [params.present]
 * @param {string[]} [params.recentLines] - The DJ's own recent lines; only the
 *   last five are kept
 * @returns {Object} Listening Context plus `forKey` (the next track's key) and
 *   `allowedNames`
 */
export function buildContext({ previous, next, theme = null, present = [], recentLines = [] }) {
  const facts = [{ id: 'f-next', kind: 'track', text: `The next track is ${describe(next)}.` }];
  if (previous) {
    facts.push({
      id: 'f-prev',
      kind: 'track',
      text: `The track that just played is ${describe(previous)}.`
    });
  }
  if (theme) {
    facts.push({ id: 'f-theme', kind: 'theme', text: `The theme of this set is "${theme}".` });
  }

  return addMemberFacts({
    forKey: trackKey(next),
    previous: previous ? trackFact(previous, 't-prev') : null,
    next: trackFact(next, 't-next'),
    theme,
    present,
    // Names are only allowed once a member fact references them (US3).
    allowedNames: [],
    facts,
    recentLines: recentLines.slice(-5)
  });
}
