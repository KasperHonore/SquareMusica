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

const MAX_NAME_CHARS = 20;
// FR-018: "plays a lot" needs at least this many counted plays (the DJ Stats floor).
const MIN_PLAYS = 3;
const GROUP_WINDOW_DAYS = 7;
// An anonymous group fact needs at least two people behind it, so it never
// singles anyone out (FR-020).
const MIN_GROUP = 2;

/**
 * The name the DJ may say out loud (R7): emoji and symbols stripped, whitespace
 * collapsed, cut to the first word when over 20 characters. Null when nothing
 * pronounceable is left; that member is treated as unnamed.
 * @param {string|null|undefined} displayName
 * @returns {string|null}
 */
export function speakableName(displayName) {
  if (typeof displayName !== 'string') return null;
  let name = displayName
    .replace(/[^\p{L}\p{M}\p{N}\s'’-]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^['’-]+|['’-]+$/g, '')
    .trim();
  if (name.length > MAX_NAME_CHARS) name = name.split(' ')[0];
  return /\p{L}/u.test(name) ? name : null;
}

function trackFact(track, id) {
  return { id, title: track.title, artist: artistOf(track) };
}

function describeTrack(label, track, queuedBy = null) {
  const artist = artistOf(track);
  const base = artist
    ? `${label} is "${track.title}" by ${artist}`
    : `${label} is "${track.title}"`;
  return queuedBy ? `${base}, queued by ${queuedBy}.` : `${base}.`;
}

/**
 * Who each connected human is, for the member rules (data-model.md
 * Listening Context `present`).
 * @param {Array} connectedUsers - getVoiceContext().connectedUsers
 * @param {Set<string>} optOuts
 * @returns {Array<{ userId: string, speakableName: string|null, optedOut: boolean,
 *   displayName: string|null, username: string|null }>}
 */
function presentMembers(connectedUsers, optOuts) {
  return (connectedUsers ?? [])
    .filter((u) => u && !u.bot && u.id)
    .map((u) => ({
      userId: u.id,
      speakableName: speakableName(u.displayName ?? u.username),
      optedOut: optOuts.has(u.id),
      displayName: u.displayName ?? null,
      username: u.username ?? null
    }));
}

/**
 * Who queued `track`, as the DJ may say it: the speakable name of a present,
 * opted-in member, 'the DJ' for DJ picks, otherwise null (and the queuer's names
 * are forbidden).
 */
function queuerName(track, presentById) {
  if (!track) return null;
  if (track.addedByDj) return 'the DJ';
  const member = track.requestedById ? presentById.get(track.requestedById) : null;
  if (member && !member.optedOut && member.speakableName) return member.speakableName;
  return null;
}

/**
 * Member and group facts (FR-016–FR-020, research R6). Only present, opted-in
 * members with a speakable name are ever named; their claims need ≥ 3 counted
 * plays. Group facts are anonymous totals and may include opted-out members.
 * Fills `allowedNames`/`allowedMembers` (who the line may name) and
 * `forbiddenNames` (names the validator rejects).
 * @param {Object} ctx
 * @param {{ previousTrack: Object|null, nextTrack: Object, store?: Object|null,
 *   addFact: Function }} input
 * @returns {Object}
 */
export function addMemberFacts(ctx, { previousTrack = null, nextTrack, store = null, addFact }) {
  const presentById = new Map(ctx.present.map((m) => [m.userId, m]));
  const named = new Map(); // userId -> speakable name actually referenced by a fact
  const forbidden = new Set();

  const refer = (member) => named.set(member.userId, member.speakableName);
  const forbid = (name) => {
    if (!name) return;
    forbidden.add(name);
    const spoken = speakableName(name);
    if (spoken) forbidden.add(spoken);
  };

  // Queuers of the previous and next track.
  for (const [label, track, fact] of [
    ['The previous track', previousTrack, ctx.previous],
    ['The next track', nextTrack, ctx.next]
  ]) {
    if (!track || !fact) continue;
    const queuedBy = queuerName(track, presentById);
    if (queuedBy) {
      fact.queuedBy = queuedBy;
      const factEntry = ctx.facts.find((f) => f.trackId === fact.id);
      if (factEntry) factEntry.text = describeTrack(label, track, queuedBy);
      if (!track.addedByDj) {
        const member = presentById.get(track.requestedById);
        refer(member);
        if (factEntry) factEntry.userId = member.userId;
      }
    } else if (!track.addedByDj) {
      const member = track.requestedById ? presentById.get(track.requestedById) : null;
      forbid(member?.displayName);
      forbid(member?.username);
      forbid(track.requestedBy);
    }
  }

  const eligible = ctx.present.filter((m) => !m.optedOut && m.speakableName);
  const everyoneIds = ctx.present.map((m) => m.userId);

  if (store) {
    // Personal facts for present, opted-in members (FR-017, FR-018, FR-020).
    const nextUrl = nextTrack?.url ?? null;
    if (nextUrl && eligible.length > 0) {
      const counts = store.getUserPlayCountsForUrl(
        nextUrl,
        eligible.map((m) => m.userId)
      );
      for (const { userId, count } of counts) {
        if (count < MIN_PLAYS) continue;
        const member = presentById.get(userId);
        addFact('member', `${member.speakableName} has played this track ${count} times.`, {
          userId,
          value: count
        });
        refer(member);
      }
    }
    for (const member of eligible) {
      const top = store.getUserTopTrack(member.userId);
      if (!top || top.count < MIN_PLAYS || top.url === nextUrl) continue;
      addFact(
        'member',
        `${member.speakableName}'s most-played track is "${top.title}", played ${top.count} times.`,
        { userId: member.userId, value: top.count }
      );
      refer(member);
    }

    // Anonymous group facts: never name anyone, may count opted-out members.
    if (everyoneIds.length > 0) {
      if (nextUrl) {
        const rows = store.getUserPlayCountsForUrl(nextUrl, everyoneIds);
        const total = rows.reduce((sum, row) => sum + row.count, 0);
        if (rows.length >= MIN_GROUP && total >= MIN_PLAYS) {
          addFact('group', `People here have played this track ${total} times.`, {
            value: total
          });
        }
      }
      const artist = ctx.next?.artist;
      if (artist) {
        const queuers = store.getArtistQueuersSince(artist, everyoneIds, GROUP_WINDOW_DAYS);
        if (queuers >= MIN_GROUP) {
          addFact('group', `${queuers} of the people here have queued ${artist} this week.`, {
            value: queuers
          });
        }
      }
    }

    // Known members by history username and by every display name seen in
    // voice: the DJ says display names, so an absent member's spoken name must
    // stay forbidden too (R6 step 3, US3/AC2).
    for (const name of store.getKnownMemberNames()) forbid(name);
    for (const name of store.getKnownDisplayNames?.() ?? []) forbid(name);
  }

  // Everyone present who is not named by a fact is off limits, opted out or not.
  for (const member of ctx.present) {
    if (named.has(member.userId)) continue;
    forbid(member.displayName);
    forbid(member.username);
  }

  const allowedMembers = [...named].map(([userId, name]) => ({ userId, name }));
  const allowedLower = new Set(allowedMembers.map((m) => m.name.toLowerCase()));
  ctx.allowedMembers = allowedMembers;
  ctx.allowedNames = allowedMembers.map((m) => m.name);
  ctx.forbiddenNames = [...forbidden].filter((n) => !allowedLower.has(n.toLowerCase()));
  return ctx;
}

/**
 * Build the Listening Context for the transition into `next`.
 * @param {{ previous: Object|null, next: Object, theme?: string|null,
 *   present?: Array, recentLines?: string[], store?: Object|null }} params
 *   `present` is getVoiceContext().connectedUsers; `store` is the db (opt-outs
 *   and history reads). Without a store no member or group facts are added and
 *   every present member is forbidden.
 * @returns {Object}
 */
export function buildContext({
  previous,
  next,
  theme = null,
  present = [],
  recentLines = [],
  store = null
}) {
  const facts = [];
  let factSeq = 0;
  const addFact = (kind, text, extra = {}) => {
    const fact = { id: `f${++factSeq}`, kind, text, ...extra };
    facts.push(fact);
    return fact;
  };

  if (previous) addFact('track', describeTrack('The previous track', previous), { trackId: 't1' });
  addFact('track', describeTrack('The next track', next), { trackId: 't2' });
  if (theme) addFact('theme', `Tonight's theme is "${theme}".`);

  const optOuts = store?.getShoutoutOptOuts?.() ?? new Set();
  const members = presentMembers(present, optOuts);
  // Only present members are ever named, so recording them here covers every
  // name the DJ can have said.
  store?.recordMemberNames?.(
    members.map((m) => ({ userId: m.userId, displayName: m.displayName ?? m.username }))
  );

  return addMemberFacts(
    {
      forKey: trackKey(next),
      previous: previous ? trackFact(previous, 't1') : null,
      next: trackFact(next, 't2'),
      theme,
      present: members,
      allowedNames: [],
      allowedMembers: [],
      forbiddenNames: [],
      facts,
      recentLines: recentLines.slice(-5)
    },
    { previousTrack: previous, nextTrack: next, store, addFact }
  );
}
