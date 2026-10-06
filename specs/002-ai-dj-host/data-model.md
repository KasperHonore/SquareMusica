# Data Model: AI DJ Host

**Feature**: [spec.md](./spec.md) | **Research**: [research.md](./research.md)

Persisted entities live in SQLite through `src/persistence/db.js`. In-memory entities live
in `services/dj/djService.js` and are lost on restart by design (FR-014).

---

## Persisted

### `dj_settings` (new table, single row)

| Column | Type | Rule | Spec |
|---|---|---|---|
| `id` | INTEGER PK | always `1` (`CHECK (id = 1)`) | single-guild, one DJ |
| `enabled` | INTEGER NOT NULL DEFAULT 0 | 0/1; default off | FR-013 |
| `interval` | INTEGER NOT NULL DEFAULT 3 | `CHECK (interval BETWEEN 1 AND 10)` | FR-012 |
| `lookahead` | INTEGER NOT NULL DEFAULT 5 | `CHECK (lookahead IN (5, 10))` | FR-023 |
| `updated_at` | DATETIME DEFAULT CURRENT_TIMESTAMP | UTC | — |

- The row is created on first read with `INSERT OR IGNORE ... VALUES (1)`.
- The service validates before writing. The CHECKs are a last line of defence.

### `dj_shoutout_optouts` (new table)

| Column | Type | Rule | Spec |
|---|---|---|---|
| `user_id` | TEXT PK | Discord user id (never the internal `users.id`; see R12 *Member identity*) | FR-019 |
| `created_at` | DATETIME DEFAULT CURRENT_TIMESTAMP | — | — |

- A row present means opted out. No row means opted in, which is the default (Q2: A).
- Opting back in deletes the row.

### `dj_usage` (new table)

| Column | Type | Rule | Spec |
|---|---|---|---|
| `day` | TEXT PK | `date('now','localtime')`, e.g. `2026-10-06` in configured `TZ` | FR-033 |
| `lines` | INTEGER NOT NULL DEFAULT 0 | incremented on successful TTS | FR-033/034 |
| `themed_tracks` | INTEGER NOT NULL DEFAULT 0 | incremented per pick added to queue | FR-033/034 |

- Increments use an upsert: `INSERT ... ON CONFLICT(day) DO UPDATE SET lines = lines + 1`.
- Old rows are never read and are harmless. Pruning is optional: delete rows older than
  30 days on boot.

### `history` (changed)

| Change | Detail | Spec |
|---|---|---|
| `added_by_dj INTEGER NOT NULL DEFAULT 0` | Guarded `ALTER TABLE` in `migrate()` and in `schema.sql` for fresh installs. Written by `addToHistory` from `track.addedByDj`. | FR-027 |
| `CREATE INDEX IF NOT EXISTS idx_history_url ON history(url)` | Serves per-track play counts for grounding facts. | FR-018 |
| `artist TEXT` (nullable) | Guarded `ALTER TABLE` in `migrate()` and in `schema.sql`. Written by `addToHistory` as `track.spotifyData?.artists?.[0] ?? track.channel ?? null`. Old rows are `NULL` and never match artist reads. | FR-004, FR-021b, FR-025 |

- DJ picks are written with `requested_by = 'SquareMusica DJ'` and `requested_by_id = NULL`,
  so `COUNTED_PLAY` already excludes them from every stats figure.

### New db read/write methods (`DatabaseManager`)

| Method | Returns | Notes |
|---|---|---|
| `getDjSettings()` | `{ enabled, interval, lookahead }` | creates row if missing |
| `updateDjSettings(partial)` | updated settings | single UPDATE |
| `isShoutoutOptedOut(userId)` / `setShoutoutOptOut(userId, optedOut)` / `getShoutoutOptOuts()` | bool / void / `Set<string>` | — |
| `getDjUsage(day)` / `incrementDjUsage(day, field)` | `{ lines, themed_tracks }` | `field` whitelisted |
| `getUserPlayCountsForUrl(url, userIds)` | `[{ userId, count }]` | `COUNTED_PLAY`, `url = ?`, `requested_by_id IN (...)` |
| `getUserTopTrack(userId)` | `{ url, title, count } \| null` | `COUNTED_PLAY`, top 1 by count |
| `getTopTracks({ userIds?, limit })` | `[{ url, title, artist, count, duration, thumbnail }]` | history candidates for themed picks; `artist` may be `null` |
| `getArtistQueuersSince(artist, userIds, days)` | number | distinct present members with counted plays of `artist`; `NULL` artist never matches; anonymous `group` facts |
| `getKnownMemberNames()` | `string[]` | distinct latest `requested_by` per non-NULL `requested_by_id` (excludes DJ picks), for forbidden-name check |

`getDjSkipAward` also gains `e.target_user_id IS NOT NULL` (R8).

---

## Queue track (changed shape, in memory)

New optional fields on the track object in `core/queue.js`:

| Field | Type | Meaning |
|---|---|---|
| `addedByDj` | boolean | Set on themed picks. Drives the lookahead count (FR-022), ordering (FR-024) and attribution (FR-027). |
| `requestedBy` | string | `'SquareMusica DJ'` for picks. |
| `requestedById` | null | For picks; keeps them out of `COUNTED_PLAY`. |

### `Queue` additions

- `insertAt(index, track)`: clamps to `[currentIndex + 1, length]` and sets `addedAt`.
- `prioritizeMemberTracks: boolean`, default `false`. When `true`, `add(track)` with
  `!track.addedByDj` inserts before the first upcoming `addedByDj` entry. Otherwise it
  appends, as today.
- `countUpcoming(predicate)`: the number of entries after `currentIndex` matching the
  predicate.
- `peekNext()`: the track `next()` would return, without side effects. It honours
  `loopMode` (`track` → current entry; `queue` at the last index → `tracks[0]`).

---

## In memory (djService)

### Themed Session

| Field | Type | Rule |
|---|---|---|
| `theme` | string | trimmed, 1–200 characters (FR-021) |
| `startedBy` | `{ id, name }` | actor |
| `startedAt` | ISO string | — |
| `origin` | `{ transport: 'discord' \| 'http' \| 'socket', channelId? }` | where to post stall notices (FR-029) |
| `usedKeys` | `Set<string>` | track keys (URL) plus normalised `artist - title` when the artist is known (FR-025) |
| `status` | `'running' \| 'stalled'` | — |
| `reason` | `null \| 'NO_LISTENERS' \| 'NOT_IN_VOICE' \| 'CAP_REACHED' \| 'SERVICE_UNAVAILABLE' \| 'THEME_EXHAUSTED'` | — |
| `introPending` | boolean | next transition speaks the theme intro (FR-028) |

**State transitions**

```
            start(theme) ok                         stop()
  (none) ───────────────────► running ◄──────┐ ───────────► (none)
     ▲  start fails: NO_TRACKS_FOR_THEME      │ top-up ok / condition clears
     └── (stays none)          │ top-up blocked (no listeners, cap, outage, exhausted)
                               ▼             │
                            stalled ─────────┘
  changeTheme(theme): running|stalled → running, introPending = true, usedKeys kept
  restart / bot leaves voice: themed session discarded (bot leave → stalled NOT_IN_VOICE until stop or rejoin)
```

### DJ Line

| Field | Type | Notes |
|---|---|---|
| `forKey` | string | track key of the transition target (R5) |
| `text` | string | validated 1–2 sentences, ≤ 240 characters |
| `pcm` | Buffer | 48 kHz s16le stereo, ≤ 15 s (≤ 2 880 000 B) |
| `factIds` | string[] | facts used |
| `namedUserIds` | string[] | members named in the line |
| `preparedAt` / `spokenAt` | timestamps | — |

- The last 20 spoken texts are kept in a ring buffer for FR-007.
- At most one line is prepared at a time.

### Listening Context (derived per preparation, never stored)

```
{ previous: TrackFact|null, next: TrackFact, theme: string|null,
  present: [{ userId, speakableName|null, optedOut }],
  facts: [{ id, kind: 'track'|'member'|'group'|'theme', text, userId? }],
  recentLines: string[5] }
```

No session or recent-history facts (FR-004 narrowed; session recaps are out of scope).
`recentLines` is the DJ's own last five lines, passed only to discourage near-repeats
(FR-007), never as content to talk about.

### Breaker and caps (in memory, caps backed by `dj_usage`)

```
{ consecutiveFailures, openUntil: ms|null, health: 'ok'|'degraded',
  caps: { lines: { used, limit, reached }, themedTracks: { used, limit, reached }, resetsAt } }
```

---

## Broadcast shape: `dj:state`

Defined in [contracts/dj-api.md](./contracts/dj-api.md) §1. It's included as `dj` in
`getFullState()`, so it arrives in `initial:state`.
