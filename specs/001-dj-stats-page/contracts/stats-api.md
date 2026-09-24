# Contract: Stats HTTP API

**Date**: 2026-09-12 | **Spec**: [spec.md](../spec.md)

Mounted in `src/transports/http/index.js` as:

```js
app.use('/api/stats', statsRoutes);   // authMiddleware, no mutationLimiter (R7)
```

Read-only. No endpoint here mutates playback, queue, or member data (spec Assumptions).

---

## `GET /api/stats`

Returns the leaderboard and every award for one period in a single round trip (R6).

### Query parameters

| Name | Required | Values | Default |
|---|---|---|---|
| `period` | no | `all` \| `week` \| `month` | `all` (FR-018) |

An unrecognised `period` returns **400**, never a silent fallback to `all` (FR-020).

The accepted set is `SUPPORTED_PERIODS`, exported from `services/statsQueries.js`. It holds
only `all` until T028 lands, and the route validates against it rather than against a
literal list — so in the first release `week` and `month` are rejected with a 400 that names
what is actually supported, instead of being accepted and quietly resolved as all-time.

### 200 response

```json
{
  "period": "all",
  "generatedAt": "2026-09-12T14:05:00.000Z",
  "leaderboard": [
    {
      "rank": 1,
      "userId": "182736451827364518",
      "displayName": "kasper",
      "avatar": "a1b2c3d4e5f6",
      "trackCount": 120,
      "totalDurationSeconds": 30600,
      "uniqueTrackCount": 88,
      "isSelf": false
    }
  ],
  "leaderboardTruncated": true,
  "selfEntry": {
    "rank": 14,
    "userId": "999888777666555444",
    "displayName": "someone",
    "avatar": null,
    "trackCount": 3,
    "totalDurationSeconds": 540,
    "uniqueTrackCount": 3,
    "isSelf": true
  },
  "awards": [
    {
      "key": "night_owl",
      "name": "Night Owl",
      "description": "Queued the most tracks between 22:00 and 04:00",
      "winner": { "userId": "182736451827364518", "displayName": "kasper", "avatar": "a1b2c3d4e5f6" },
      "value": 42,
      "valueLabel": "tracks"
    },
    {
      "key": "shuffle_addict",
      "name": "Shuffle Addict",
      "description": "Hit shuffle more than anyone else",
      "winner": null,
      "value": null,
      "valueLabel": "shuffles"
    }
  ]
}
```

### Field contract

| Field | Guarantee |
|---|---|
| `generatedAt` | ISO-8601 timestamp of when the payload was computed. Always present. Nothing is cached, so this is always "now" — it exists so a client can show data age and tell two responses apart. |
| `period` | Echoes the resolved period. The client MUST use this, not its own state, to label results — it is what prevents a stale response mislabelling the section (R6). |
| `leaderboard` | At most **10** entries (FR-009), ordered by `rank` ascending. Empty array when the period has no qualifying activity — never absent. |
| `leaderboardTruncated` | `true` when more than 10 DJs qualified, so the UI can say the list is cut (FR-009). |
| `selfEntry` | The requesting member's own row with its true rank, present **only** when they qualify but fall outside the top 10 (FR-009). `null` otherwise — including when they already appear in `leaderboard`. The route requires authentication, so there is no anonymous case to handle. |
| `isSelf` | `true` on the one leaderboard row belonging to the requester (FR-008), or all `false` when the requester has no qualifying plays or ranks outside the top 10. |
| `awards` | **Always** contains every defined award, in a fixed order, regardless of period or data (FR-014, SC-010). Never filtered. |
| `winner` | `null` when no candidate reached the 3-item minimum (FR-013) — members and tracks alike, so a song played twice does not win Most Played Song. When non-null, `avatar` may still be `null`. |
| `value` | `null` exactly when `winner` is `null`. |
| `valueLabel` | The unit `value` is counted in (`"tracks"`, `"plays"`, `"shuffles"`, `"removals"`). Static per award and **always present, including when `winner` is `null`** — the card renders its unit in the "no winner yet" state too. |
| `totalDurationSeconds` | Sums only known durations; unknown durations contribute 0. |
| *(all history-derived figures)* | `trackCount`, `totalDurationSeconds`, `uniqueTrackCount` and the four history-sourced award values count **only** plays that are attributed and not loop replays (FR-005a). A track looped 20 times contributes 1 to each figure. The History endpoint is unaffected and still returns every row. |
| *(all time-derived figures)* | Period boundaries, Night Owl and Early Bird hours, and The Hog's "day" are evaluated in the server's configured `TZ` (FR-030), never in the client's timezone. The response carries no timezone field, so clients MUST NOT recompute them locally. |

### Award ordering and identity

`awards` is returned in a stable, code-defined order so cards do not reshuffle between
loads. `key` is the stable identifier — clients MUST key off `key`, not array position
or `name`.

**`most_played_song` is the one award whose winner is a track, not a member.** Its
`winner.displayName` holds the track title, `winner.userId` is `null`, and
`winner.avatar` is the track thumbnail or `null`. Clients MUST NOT render it as a
member avatar.

### Other responses

| Status | When | Body |
|---|---|---|
| 400 | `period` not in `SUPPORTED_PERIODS` | `{ "error": "Invalid period. Use <supported>." }` — `<supported>` enumerates the currently supported set: `Use all.` before T028, `Use all, week, or month.` after |
| 401 | Session token missing or invalid — `authMiddleware` rejects before the handler runs | Existing auth-middleware body (FR-002) |
| 500 | Query failure | `{ "error": "Failed to load stats." }` |

A 500 is what the page's error state with retry renders against (FR-029).

---

## Internal contract: the stats event bus

Not HTTP, but the contract that makes FR-024 ("recorded identically regardless of
surface") hold. Every transport emits through one shared factory; the recorder is the
only subscriber that writes.

**Channel**: `botEvents` from `src/events/bus.js` (Principle II).

**Event name**: `stats:event`

**Payload**:

```js
{
  type: 'skip' | 'pause' | 'resume' | 'remove' | 'shuffle' | 'clear_queue' | 'track_complete',
  actor: { id, name, avatar } | null,   // null only for track_complete
  track: { title, url, requestedById, requestedBy } | null,  // see nullability table below
  metadata: object | null
}
```

**`track` nullability is per action type, and is not optional detail** — it is what the
parity test asserts against (T046):

| Type | `track` | Why |
|---|---|---|
| `skip`, `remove` | **non-null** | Targets one specific track; must be captured *before* the mutation |
| `pause`, `resume` | **non-null** | Targets whatever is currently playing — read `musicManager.getCurrentTrack()` (FR-022) |
| `track_complete` | **non-null** | The track that just ended |
| `shuffle`, `clear_queue` | `null` | Acts on the queue as a whole, not on one track |

Three surfaces that all uniformly omit `track` on `pause` are identically shaped and
identically wrong, so T046 asserts this table rather than only asserting the surfaces agree
with each other.

**Emit sites** — all must be covered for SC-006 (18 of 18 combinations):

| Action | HTTP | Realtime | Discord |
|---|---|---|---|
| skip | `routes/playback.js` | `handlers.js` `handlePlayerControl` | `commands/playback.js` `handleSkip` |
| pause | `routes/playback.js` | `handlePlayerControl` | `handlePause` |
| resume | `routes/playback.js` | `handlePlayerControl` | `handleResume` |
| remove | `routes/queue.js` `DELETE /:position` | `handleQueueRemove` | `commands/queue.js` |
| shuffle | `routes/queue.js` `POST /shuffle` | `handlePlayerControl` | `commands/queue.js` |
| clear_queue | `routes/queue.js` `DELETE /` | `handlePlayerControl` `'clear'` | `commands/queue.js` `handleClear` |
| track_complete | — | — | emitted once from `services/playback.js` `trackEnd` (R2) |

**`stop` is deliberately not recorded — on any surface.** FR-021 enumerates exactly six
tracked actions: skip, pause, resume, remove, shuffle, clear_queue. `stop` is not among
them, so no emit site exists for it and none should be added. This is worth stating
plainly because stopping *does* empty the queue as a side effect — `musicManager.stop()`
calls `queue.clear()` (`core/musicManager.js:207`), and HTTP `POST /api/player/stop`
(`routes/playback.js:53`), realtime `'stop'` (`handlers.js:214`) and Discord `handleStop`
(`commands/playback.js:163-164`, which does `p.stop(); q.clear()` directly) all reach the
same outcome. The tempting "fix" is to emit `clear_queue` from a stop handler. Do not:
instrumenting one surface's stop and not the others is precisely the Principle III
divergence this matrix exists to prevent, and instrumenting all three would record an
action FR-021 does not define. If stop should be tracked, that is a change to FR-021
first, and to all three surfaces together.

**`clear_queue` MUST record its variant in `metadata`.** The three surfaces do not clear
the same thing, and never have:

| Surface | Call | Clears | `metadata.variant` |
|---|---|---|---|
| HTTP `DELETE /api/queue` | `queue.clear()` | everything, current track included | `"all"` |
| Realtime `'clear'` | `musicManager.clearUpcomingQueue()` | upcoming only; current keeps playing | `"upcoming"` |
| Discord `handleClear` | rewrites `q.tracks` to `[current]` | everything except the current track | `"all_but_current"` |

So `metadata: { "variant": "all" | "upcoming" | "all_but_current" }` is required on every
`clear_queue` emit. Without it the three collapse into one indistinguishable event type,
and any award or count derived from `clear_queue` silently equates three different
user-visible outcomes — while the `metadata` column, which exists for exactly this, stays
empty. Recording the variant also keeps the divergence *visible* in the data rather than
hidden behind a shared label; it does **not** resolve it. Making the three behave
identically is a playback change, out of scope here and recorded in the plan's Principle
III note.

**Capture-before-mutate**: for `skip` and `remove`, the affected track MUST be read
*before* the mutation, or the payload records the wrong track (or none). For `skip`,
read `musicManager.getCurrentTrack()`; for `remove`, read
`musicManager.getQueue()[position]`.

**Listener safety**: the recorder MUST NOT throw. `EventEmitter` invokes listeners
synchronously, so an uncaught error would surface inside the emitting transport and
break the very action being recorded (R8, FR-025).
