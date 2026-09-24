# Phase 1 Data Model: DJ Stats Page

**Date**: 2026-09-12 | **Spec**: [spec.md](./spec.md) | **Research**: [research.md](./research.md)

Storage is the existing SQLite database reached through `src/persistence/db.js`
(Principle II). **All SQL in this document lives in `db.js`** — the queries below specify
behavior, not file location. `src/services/statsQueries.js` owns period boundaries, the
award registry and response shaping, and calls `db.js` methods; it never issues SQL itself. Schema lives in `src/persistence/schema.sql`; additive column changes
go in `DatabaseManager.migrate()`, which runs **before** `schema.sql` is executed
(`db.js:24-29`).

---

## 1. `history` — extended (existing table)

Three additive columns. No existing column changes type or meaning, so the History page
is unaffected: it still lists every row, loop replays included.

| Column | Type | Notes |
|---|---|---|
| `requested_by_id` | TEXT | **New.** Stable Discord user id of the queuer. NULL for every pre-launch row — this NULL-ness *is* the launch boundary (FR-005, R3). |
| `requested_by_avatar` | TEXT | **New.** Avatar hash/URL snapshot as at play time (FR-004, FR-006). |
| `is_loop_replay` | INTEGER NOT NULL DEFAULT 0 | **New (2026-09-24).** `1` when loop mode started this play automatically (FR-005a, R11). Such rows are kept for the History page but excluded from every stats figure. |

Existing `requested_by TEXT NOT NULL` continues to hold the **display-name snapshot**
at play time; no change needed for FR-004 beyond now treating it as a snapshot.

**Migration** (in `migrate()`, guarded by `pragma('table_info(history)')` exactly as
the existing `guild_id` migration is):

```sql
ALTER TABLE history ADD COLUMN requested_by_id TEXT;
ALTER TABLE history ADD COLUMN requested_by_avatar TEXT;
ALTER TABLE history ADD COLUMN is_loop_replay INTEGER NOT NULL DEFAULT 0;
CREATE INDEX IF NOT EXISTS idx_history_requested_by_id ON history(requested_by_id);
```

Each `ALTER` is guarded on its own column. The `is_loop_replay` guard MUST NOT be nested
inside the `requested_by_id` guard: a database that already has the first two columns
(every development database on this branch) would otherwise never get the third.
`ADD COLUMN ... NOT NULL DEFAULT 0` is valid in SQLite, and existing rows read as `0`.

`schema.sql` gains the same two columns in its `CREATE TABLE`, **and the same index in its
index block**, so fresh installs match:

```sql
-- src/persistence/schema.sql, alongside the five existing indexes
CREATE INDEX IF NOT EXISTS idx_history_requested_by_id ON history(requested_by_id);
```

The index is deliberately declared in **both** places. `migrate()` returns early when the
`history` table does not yet exist (`db.js:37-39`) — precisely the fresh-install case — so
an index created only inside `migrate()` would never exist on a new deployment, leaving
every stats query to scan unindexed against SC-002's 100k-play target. `IF NOT EXISTS`
makes the duplication harmless on both paths.

**Write path**: `addToHistory()` (`db.js:140`) gains the two values from
`track.requestedById` / `track.requestedByAvatar`, which are already populated on every
track by `trackResolver.js:92-94` and `resolutionManager.js:291-293`. The single caller
is `musicManager.onTrackChange()` (`musicManager.js:255`) — one integration point for
all of FR-004.

`addToHistory(track, guildId, { loopReplay = false } = {})` also writes
`is_loop_replay`. The flag is decided in `core/queue.js` and passed through by
`musicManager.onTrackChange()`. See §5 for the state rules.

**Validation**: a row whose `requested_by_id` is NULL, or whose `is_loop_replay` is 1, is
never counted by any stats query. Both conditions live in **one** SQL fragment in `db.js`,
the *counted-play predicate* `requested_by_id IS NOT NULL AND is_loop_replay = 0`. The
leaderboard and all four history-derived awards interpolate that fragment. None of them
spells the conditions out itself, so no query can drift away from the others. The
`requested_by_id` part is deliberate and self-healing (R3). It covers both pre-launch rows and
any future play that somehow arrives without an id.

---

## 2. `events` — new table

One row per recorded control action or natural track completion.

```sql
CREATE TABLE IF NOT EXISTS events (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  guild_id         TEXT,
  event_type       TEXT NOT NULL,
  actor_id         TEXT,
  actor_name       TEXT,
  actor_avatar     TEXT,
  target_user_id   TEXT,
  target_user_name TEXT,
  track_title      TEXT,
  track_url        TEXT,
  metadata         TEXT,
  created_at       DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_events_type_created ON events(event_type, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_events_actor ON events(actor_id);
CREATE INDEX IF NOT EXISTS idx_events_target ON events(target_user_id);
```

| Field | Meaning |
|---|---|
| `guild_id` | Configured guild, matching `history.guild_id`. Single-guild per Principle I — present for consistency, never used to partition state. |
| `event_type` | One of the eight values below. |
| `actor_id` / `actor_name` / `actor_avatar` | Who performed it, snapshotted (FR-022). NULL only for `track_complete`, which has no actor. |
| `target_user_id` / `target_user_name` | Who queued the affected track (FR-022). NULL when the action targets no track (`shuffle`, `clear_queue`). |
| `track_title` / `track_url` | Affected track. NULL **only** for `shuffle` / `clear_queue`, which act on the queue as a whole. `pause` and `resume` record the track that was playing when they fired, and `skip` / `remove` the track captured before the mutation — see the nullability table in `contracts/stats-api.md`. |
| `metadata` | JSON string for per-type extras (e.g. `{"queueLength":12}` on `clear_queue`). Kept deliberately loose so new award ideas do not need a migration. **Required on `clear_queue`**: `{"variant":"all"\|"upcoming"\|"all_but_current"}`. The three surfaces clear different things — HTTP `DELETE /api/queue` calls `queue.clear()` (everything), realtime `'clear'` calls `clearUpcomingQueue()` (upcoming only), Discord `handleClear` keeps the current track — so without the variant one event type silently equates three different outcomes. See `contracts/stats-api.md`. |
| `created_at` | UTC (SQLite `CURRENT_TIMESTAMP`). Every read applies `'localtime'` — see R4. |

**`event_type` values** (closed set — FR-021, FR-023):

`skip`, `pause`, `resume`, `remove`, `shuffle`, `clear_queue`, `track_complete`

A self-skip is not a distinct type: it is `skip` where `actor_id = target_user_id`
(FR-011's self-skip award), and a skip of someone else is `skip` where they differ.

**Write path**: `src/services/statsRecorder.js` is the **only** writer, subscribing to
the shared bus (R1). Every write is wrapped in `try/catch` + `logger.error` and never
rethrows (R8, FR-025, SC-008).

---

## 3. Derived read models (not stored)

Computed per request; nothing is cached or materialised.

### LeaderboardEntry

| Field | Source |
|---|---|
| `rank` | Position in the ordered result, 1-based. |
| `userId` | `history.requested_by_id` — the grouping key (FR-005). |
| `displayName`, `avatar` | From the queuer's **most recent** row, not any older one (FR-006, Q1). |
| `trackCount` | `COUNT(*)` |
| `totalDurationSeconds` | `SUM(COALESCE(duration,0))` — unknown durations contribute 0 per the spec's edge case. |
| `uniqueTrackCount` | `COUNT(DISTINCT url)` |
| `isSelf` | Computed against the requesting member. |

Grouped by `requested_by_id`; ordered `trackCount DESC, MIN(played_at) ASC,
requested_by_id ASC` (R5). Capped at 10, with the requester's own row appended when
outside it (FR-009).

### Award

| Field | Notes |
|---|---|
| `key`, `name`, `description` | Static, defined in code. Every award is always present (FR-014, SC-010). |
| `winner` | `{ userId, displayName, avatar }` or **null**. Usually a member; for Most Played Song it is a track, with `userId` null (FR-010). |
| `value`, `valueLabel` | The winning number and its unit. |

A winner is emitted only when the qualifying count is **≥ 3** (FR-013) — for every
candidate, member or track, so a song played twice does not win Most Played Song;
otherwise `winner` is null and the card renders its "no winner yet" state. Same tie-break as the
leaderboard (R5).

**Award sources** (history-sourced awards are filtered by the selected period and the
counted-play predicate from §1. Events-sourced awards are filtered by period only):

| Award | Table | Rule |
|---|---|---|
| Most Played Song | `history` | `GROUP BY url`, most plays. Winner is the *track*, not a member. |
| Night Owl | `history` | `strftime('%H', played_at,'localtime') >= '22' OR strftime('%H', played_at,'localtime') < '04'` (R4) |
| Early Bird | `history` | `strftime('%H', played_at,'localtime') >= '05' AND strftime('%H', played_at,'localtime') < '09'` (R4) |
| The Hog | `history` | Most plays in one local day: `GROUP BY requested_by_id, date(played_at,'localtime')` |
| DJ Skip | `events` | `event_type='skip' AND target_user_id <> actor_id`, grouped by **`target_user_id`** — see the direction note below |
| Self-Skip King | `events` | `event_type='skip' AND target_user_id = actor_id`, grouped by `actor_id` |
| Queue Yeeter | `events` | `event_type='remove'`, grouped by `actor_id` |
| Shuffle Addict | `events` | `event_type='shuffle'`, grouped by `actor_id` |

The four `events`-sourced awards return `winner: null` until three qualifying actions
accumulate — expected on day one (SC-004), not a defect.

**Direction note — "DJ Skip" is won by the victim, not the skipper.** It groups by
`target_user_id`: the winner is the member whose queued tracks *other people* skipped most
(FR-011's "most-skipped-by-others"). The other three `events` awards group by `actor_id`
and are won by the member who performed the action. The name reads like an actor, and it
sits next to three actor-based awards, so `GROUP BY actor_id` here is the natural typo —
it compiles, it returns a plausible winner, and it is the wrong person. Assert the
direction explicitly in tests: with A skipping B's track three times, **B** wins DJ Skip
and A wins nothing.

**Predicate note**: the hour predicates above repeat the full `strftime(...)` expression on
both sides of `OR`/`AND` on purpose. `>= '22' OR < '04'` is shorthand for prose, not valid
SQL, and this is the one family of expressions R4 insists be copied exactly.

**Most Played Song is shaped differently** from the other seven: its winner is a track,
so `winner.displayName` carries the track title and there is no `userId`. The contract
(`contracts/stats-api.md`) marks it explicitly so the frontend does not try to render an
avatar for it.

### Period

`all` | `week` | `month`. Maps to the SQL predicates in R4. `'localtime'` resolves via the
required, validated `TZ` (FR-030, R10). This applies to period boundaries, Night Owl and
Early Bird hours, and The Hog's day grouping alike. Any other value is rejected
with 400 rather than silently falling back (FR-020).

---

## 4. Entity relationships

```text
history (1) ──── queued by ────> DJ (identified by requested_by_id)
                                   ▲          ▲
events.actor_id ───── performed by ┘          │
events.target_user_id ──── affected ──────────┘
```

There is no `djs` table. A DJ is not stored — it is the grouping of `history` rows by
`requested_by_id`, with name and avatar read from the most recent row. The existing
`users` table is deliberately **not** used as the identity source: it is populated only
by dashboard OAuth login (`db.js:52`), so a member who only ever queues from Discord has
no row in it (Q1).

---

## 5. Queue entry play state — loop-replay marking (FR-005a, R11)

These are in-memory fields on queue entries. They are not persisted, and there is no new
table.

| Field | Set by | Cleared by | Meaning |
|---|---|---|---|
| `hasPlayed` | `musicManager.onTrackChange()` once the entry starts | never (a new entry is a new object) | This entry has started at least once |
| `loopReplay` | `Queue.next()` when `loopMode !== 'off'` **and** the entry it returns has `hasPlayed` | `musicManager.onTrackChange()`, right after it reads the value | This start was chosen by loop mode |

```text
            add()                 next()/previous()/ensurePlaying
  [queued] ───────> hasPlayed=false ─────────────────────────────> onTrackChange: record (counted), hasPlayed=true
                                                                              │
             next() with loop on ─> loopReplay=true ─> onTrackChange: record (is_loop_replay=1), loopReplay cleared
             previous()          ─> (flag untouched) ─> onTrackChange: record (counted)
```

`previous()` MUST NOT set `loopReplay`: a manual step back is an ordinary play. If a
start fails in `player.play()`, `onTrackChange` never runs, so no row is written. A
`loopReplay` left on an entry by a failed start is overwritten the next time `next()`
visits that entry, and only `next()` sets it.

Queue entries are serialised to clients in `queue:update`. The two fields ride along and
are ignored by the web UI. They are internal, not part of any contract.

