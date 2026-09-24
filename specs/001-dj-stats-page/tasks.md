---

description: "Task list for DJ Stats Page"
---

# Tasks: DJ Stats Page

**Input**: Design documents from `/specs/001-dj-stats-page/`

**Prerequisites**: [plan.md](./plan.md), [spec.md](./spec.md), [research.md](./research.md), [data-model.md](./data-model.md), [contracts/stats-api.md](./contracts/stats-api.md)

**Tests**: Test tasks ARE included. The spec did not request TDD, but constitution
Principle V makes `npm test` a blocking CI gate and states that new behavior crossing
transports SHOULD carry tests under `test/`. SC-006 (18 action/surface combinations) and
SC-012 (deterministic ordering) are not verifiable by inspection, so they need tests to
mean anything. Tests are written alongside their implementation, not strictly before it.

**Organization**: Grouped by user story so each can be implemented and tested
independently.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: US1–US4, mapping to the four user stories in spec.md
- Exact file paths are given in every task

## Path Conventions

Two-tree web application: Node backend under `src/`, React SPA under `web/`, Vitest
suites under `test/`. Paths below are repository-relative.

---

## ⚠️ Read before sequencing: the MVP here is NOT User Story 1 alone

US4 is priority P4 because its *awards* deliver the least immediate value — every one of
them starts empty. But its **recording half (T033–T042) collects data that can only ever
be captured going forward**. The same is true of US1's `T010`. Shipping the page first
and the recording weeks later permanently loses that window; the spec says so explicitly
in US4's "Why this priority".

**Minimum shippable release = Phase 1 + Phase 2 + Phase 3 (US1) + T033–T042 (US4
recording).** The four event-derived awards (T043–T044) can follow later without cost.

---

## Phase 1: Setup

**Purpose**: Establish a known-good baseline before touching anything

- [X] T001 Run the full CI gate set and record it green before any change: `npm run lint && npm run format:check && npm test` at the repo root, then `npm run lint && npm run format:check && npm run build` in `web/`. A later red gate is then attributable to this feature.
- [X] T002 [P] Create the directory `web/src/components/stats/` with an `index.jsx` barrel re-exporting its components, following the existing pattern in `web/src/components/albums/index.jsx`.

**Checkpoint**: Baseline green, component directory exists.

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Schema, migration, and the retention behavior change. The schema work lands
once, up front, because both user-story groups touch the same two files (`schema.sql`,
`db.js:migrate()`). The retention change lands here too, for two reasons: it edits
`client.js`, `voice.js` and `handlers.js`, which later emit-site tasks also touch; and
until it ships, every figure on the page resets whenever the bot leaves a voice channel,
so no story's data is meaningful.

**⚠️ CRITICAL**: No user story work can begin until this phase is complete.

- [X] T003 In `src/persistence/schema.sql`, add the `events` table exactly as specified in [data-model.md](./data-model.md) §2: columns `id INTEGER PRIMARY KEY AUTOINCREMENT`, `guild_id TEXT`, `event_type TEXT NOT NULL`, `actor_id TEXT`, `actor_name TEXT`, `actor_avatar TEXT`, `target_user_id TEXT`, `target_user_name TEXT`, `track_title TEXT`, `track_url TEXT`, `metadata TEXT`, `created_at DATETIME DEFAULT CURRENT_TIMESTAMP`; plus indexes `idx_events_type_created ON events(event_type, created_at DESC)`, `idx_events_actor ON events(actor_id)`, `idx_events_target ON events(target_user_id)`. In the same file add `requested_by_id TEXT` and `requested_by_avatar TEXT` to the `history` CREATE TABLE, **and add `CREATE INDEX IF NOT EXISTS idx_history_requested_by_id ON history(requested_by_id);` to the index block** (currently five indexes at `schema.sql:42-46`), so fresh installs match migrated ones. The index must live here as well as in T004: `migrate()` returns early when the `history` table does not exist (`db.js:37-39`) — which is exactly the fresh-install case — so an index created only inside `migrate()` is never created on a new deployment, and every stats query then runs unindexed against the 100k-play target of SC-002. `IF NOT EXISTS` makes having it in both places safe.
- [X] T004 In `src/persistence/db.js`, extend `migrate()` (currently at line 32) to add the two `history` columns on existing databases, guarded by `this.db.pragma('table_info(history)')` exactly as the existing `guild_id` migration is: `ALTER TABLE history ADD COLUMN requested_by_id TEXT`, `ALTER TABLE history ADD COLUMN requested_by_avatar TEXT`, then `CREATE INDEX IF NOT EXISTS idx_history_requested_by_id ON history(requested_by_id)`. Must be idempotent — `migrate()` runs on every boot, before `schema.sql` is executed.
- [X] T005 [P] Add `test/persistence/migration.test.js` asserting that running the migration twice against an in-memory database is a no-op, that pre-existing `history` rows keep their `title`/`requested_by` values with NULL in the two new columns, and that the `events` table and its three indexes exist afterwards.

- [X] T006 Remove the `clearHistory` call from **all four** voice-leave paths (FR-026): `src/transports/discord/client.js:79` (inactivity timer, cached-channel path), `src/transports/discord/client.js:106` (inactivity timer, fallback-fetch path), `src/transports/discord/commands/voice.js:43` (`/leave`), and `src/transports/realtime/handlers.js:313` (dashboard leave). One task, because leaving any single site behind silently reintroduces the wipe. **Sites 1 and 2 are a duplicated six-line block** — the inactivity-timer callback appears twice in `client.js`, once per channel-resolution path; fixing only one leaves the wipe firing whenever the channel cache misses. **Also delete `musicManager.clearHistory()` itself** (`src/core/musicManager.js:206`) in this same task: once the four call sites above are gone it has zero callers. The guild-removal path does **not** use it — `Events.GuildDelete` (`client.js:33-38`) calls `db.clearAllHistory()` directly and emits `historyCleared` itself, and never routes through `musicManager`. Leaving the method behind would add a second dead clear-history method in `core/`, beside the `db.clearHistoryByGuild` the constitution already records as debt (Principle I item 5), which requires closing such items to move *toward* single-guild. Deleting it closes that item's second clause. Update the now-stale comment at `src/transports/discord/voiceManager.js:91`, which names `musicManager.clearHistory` as the caller's job, in the same change. Do **not** remove `db.clearAllHistory()` or the `historyCleared` bus event — those two *are* used by the guild-removal path (T007).
- [X] T007 Make guild removal clear both data sets together (FR-027): add `clearAllEvents()` to `src/persistence/db.js` alongside the existing `clearAllHistory()` (line 154), and call both from the `Events.GuildDelete` handler in `src/transports/discord/client.js:33-38`. Without this the two tables diverge — `history` is wiped while `events` survives, so re-adding the bot shows behavior-award winners above an empty leaderboard.
- [X] T008 [P] Add `test/transports/voiceLeaveRetention.test.js` asserting play history survives a voice leave via each of the three routes — inactivity timeout, `/leave`, and the dashboard control — and that the `historyCleared` event is **not** emitted by any of them.
- [X] T009 [P] Extend `test/transports/voiceLeaveRetention.test.js` with `GuildDelete` coverage asserting both `history` and `events` are cleared in the same operation, and that `historyCleared` is still emitted so the dashboard refetches.

**Checkpoint**: Schema in place, migration idempotent, history no longer wiped on voice
leave, guild removal symmetric. User stories can begin.

---

## Phase 3: User Story 1 — See who the top DJs are (Priority: P1) 🎯 MVP

**Goal**: A ranked top-10 DJ leaderboard on a new DJ Stats page, attributed by stable
member identity.

**Independent Test**: Queue and play tracks as two or more known members, open DJ Stats,
confirm the ranking, counts and totals match what was played. On an empty database,
confirm an empty state renders instead of an error.

**Note on scope**: the `awards` array is returned as `[]` in this phase. That is a
deliberate placeholder, filled by US2 (T024) — it is not a contract violation at this
checkpoint, but FR-014/SC-010 are only satisfied once US2 lands.

### Backend

- [X] T010 [US1] In `src/persistence/db.js`, update `addToHistory()` (line 111) to persist `track.requestedById` into `requested_by_id` and `track.requestedByAvatar` into `requested_by_avatar`. Both are already populated on every track by `src/services/trackResolver.js:92-94` and `src/services/resolutionManager.js:291-293`. Keep the existing `try/catch` + `logger.error` shape — this write is best-effort (FR-025). **This is the only integration point for FR-004; it must ship in the first release (see the MVP note above).**
- [X] T011 [US1] In `src/persistence/db.js`, add `getLeaderboard({ since, limit })` (FR-003) owning its own SQL (Principle II: persistence is reached only through `db.js`). Filter `requested_by_id IS NOT NULL` (this NULL check is the launch boundary, FR-005), optionally `played_at >= since`, `GROUP BY requested_by_id`, selecting `COUNT(*) AS trackCount`, `SUM(COALESCE(duration,0)) AS totalDurationSeconds`, `COUNT(DISTINCT url) AS uniqueTrackCount`, and the display name/avatar from the member's **most recent** row (FR-006, per clarification Q1). Order `trackCount DESC, MIN(played_at) ASC, requested_by_id ASC` — the trailing keys are required for FR-007 and SC-012 determinism, not decoration. **Apply `LIMIT limit + 1`, not `LIMIT limit`.** T013 has to know whether an eleventh qualifying DJ exists in order to set `leaderboardTruncated`, and a result capped at exactly 10 cannot distinguish a full page from a truncated one. Returning one extra row makes that flag computable without a second COUNT; T013 slices it off before rendering.
- [X] T012 [US1] In `src/persistence/db.js`, add `getLeaderboardEntryForUser({ since, userId })` returning one member's aggregate **and their true rank** within the full ordering, for the pinned self-row when they fall outside the top 10 (FR-009).
- [X] T013 [US1] Create `src/services/statsQueries.js` exporting **`SUPPORTED_PERIODS`** — holding only `'all'` in this story, widened to `['all', 'week', 'month']` by T028 — and `resolvePeriod(period)` returning `{ period, since }`, where `'all'` yields `since: null`. `resolvePeriod` MUST reject any value outside `SUPPORTED_PERIODS`; T014 turns that rejection into a 400. **Export the set rather than hardcoding periods in the route**: between this release and T028 the API must reject `week` and `month` honestly, because the alternative — accepting them and resolving `since: null` — serves all-time figures under a "This Week" label, which is exactly the silent substitution FR-019 and FR-020 forbid. Add `buildStatsPayload({ period, selfUserId })` calling the db methods, setting `generatedAt` to the current ISO-8601 timestamp (required by the contract), taking the 11 rows T011 returns and setting `leaderboardTruncated = rows.length > 10` **before slicing to 10**, assigning 1-based `rank`, setting `isSelf`, setting `selfEntry` only when the requester qualifies but ranks outside the top 10 (null otherwise, including when they already appear in the top 10), and returning `awards: []` for now.
- [X] T014 [US1] Create `src/transports/http/routes/stats.js` exposing `GET /` per [contracts/stats-api.md](./contracts/stats-api.md): **`authMiddleware`** (not `optionalAuth` — that never rejects, which would leave the route publicly readable in violation of FR-002 and constitution Principle I), `period` defaulting to `all` (FR-018), an unrecognised `period` returning **400** with `{ "error": "Invalid period. Use <supported>." }`, where `<supported>` enumerates `SUPPORTED_PERIODS` from T013 — so the body reads `Invalid period. Use all.` in this release and `Invalid period. Use all, week, or month.` once T028 widens the set — and never silently falling back (FR-020). Validate against the exported set, never a literal list in the route: a hardcoded three-period list here would accept `week` months before `resolvePeriod` can honour it, a 500 with `{ "error": "Failed to load stats." }` on query failure, and `period` echoed in the body.
- [X] T015 [US1] In `src/transports/http/index.js`, mount `app.use('/api/stats', statsRoutes)` alongside the existing route mounts. Do **not** attach `mutationLimiter` — its `skip` predicate already exempts GET, so it would be inert (research R7).
- [X] T016 [P] [US1] Add `test/http/routes/stats.test.js` covering the response shape, `period` echo, `generatedAt` presence, 400 on an invalid period, **400 on a period that is valid in the contract but not yet in `SUPPORTED_PERIODS`** (`week`/`month` before T028 — the test that stops the US1/US3 gap from degrading into a silent all-time fallback), at most 10 leaderboard entries, `leaderboardTruncated` true when an eleventh DJ qualifies, and `selfEntry` present only when outside the top 10, plus **401 when the session token is missing or invalid** — the route is gated by `authMiddleware`, and that rejection is the only thing keeping per-member behavioral data off the open internet. Mock `db`, `musicManager` and the auth middleware following the existing pattern in `test/http/routes/playback.test.js`; note that pattern mocks auth as an unconditional pass-through, so the 401 case needs a mock that can also reject.
- [X] T017 [P] [US1] Add `test/services/statsQueries.test.js` asserting rows with NULL `requested_by_id` are excluded (FR-005), tie-break ordering is stable across repeated calls (SC-012), unknown durations contribute 0 to `totalDurationSeconds`, and a member's name/avatar come from their most recent row rather than their first. Also assert that a play written after launch carries a stable identity plus a name and avatar snapshot (SC-007) and is reflected in that member's leaderboard totals on the next query (SC-005) — both are currently implied by the write path in T010 but never actually checked.

### Frontend

- [X] T018 [US1] In `web/src/components/layout/Sidebar.jsx`, write the DJ Stats nav icon as an **inline SVG literal**, matching the three icons already in `NAV_ITEMS` (line 24) exactly: `<svg width="15" height="15" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2">` with a stroked trophy path. **Do not add an icon to `web/src/components/icons/index.jsx` and do not import one from there** — this task originally called for that and it was wrong: `Sidebar.jsx` imports nothing from `components/icons/`, and that module's icons are a different family (24×24, `fill="currentColor"`, no stroke), so an imported glyph renders filled and heavier beside three stroked outlines. Not `[P]`: shares `Sidebar.jsx` with T019.
- [X] T019 [US1] In `web/src/components/layout/Sidebar.jsx`, add `{ id: 'stats', label: 'DJ Stats', icon: <inline svg from T018> }` to the **`NAV_ITEMS`** constant (line 24 — the constant is `NAV_ITEMS`, not `navItems`), alongside the existing `search`/`playlists`/`history` entries, so DJ Stats is one click from any dashboard page (FR-001, SC-001). `NAV_ITEMS` is consumed by the `.map()` at line 155; no other Sidebar change is needed, and `Dashboard.jsx` needs none at all — it holds `activeView` as opaque state and never enumerates view ids (research R9).
- [X] T020 [US1] In `web/src/components/center/CenterPanel.jsx`, add a `case 'stats'` to **all three** `activeView` switches (header at line 50, subheader at line 62, body at line 89). Missing any one leaves the page with the wrong surrounding chrome — this is the single easiest thing to half-do in the feature.
- [X] T021 [US1] Create `web/src/pages/Stats.jsx`: fetches `/api/stats?period=all` with `credentials: 'include'`, holds loading / error / data state, renders a loading state and a recoverable error state with a retry button (FR-029), and an empty state when the leaderboard is empty (FR-019). Follow the `useCallback` + `fetch` pattern in `web/src/pages/History.jsx`.
- [X] T022 [US1] Create `web/src/components/stats/StatsLeaderboard.jsx` rendering rank, avatar, display name, track count, total listening time and unique-track count; visually distinguishing the `isSelf` row (FR-008); appending `selfEntry` below the top 10, visually separated, when present; and indicating truncation when `leaderboardTruncated` is true. Truncate long names rather than letting them break the layout. Render a **default avatar placeholder** when `avatar` is null or fails to load — the spec's edge case for a member who has left the guild, whose avatar may no longer resolve — via a null check plus an `onError` handler, never a broken-image icon.

**Checkpoint**: DJ Stats is reachable, shows a correct ranked leaderboard, and handles
empty/loading/error states. US1 is independently demoable.

---

## Phase 4: User Story 2 — Earn fun awards and superlatives (Priority: P2)

**Goal**: Four history-derived awards rendered as cards beneath the leaderboard.

**Independent Test**: Play tracks as known members across varied times of day; confirm
each award's winner and value match the plays. Confirm an award with fewer than three
qualifying plays shows "no winner yet".

- [X] T023 [US2] In `src/persistence/db.js`, add the four history-derived award queries required by FR-011, specified in [data-model.md](./data-model.md) §3: **Most Played Song** (`GROUP BY url`, most plays), **Night Owl** (`strftime('%H', played_at,'localtime') >= '22' OR strftime('%H', played_at,'localtime') < '04'` — the expression must be repeated in full on both sides; `>= '22' OR < '04'` is shorthand, not valid SQL), **Early Bird** (`strftime('%H', played_at,'localtime') >= '05' AND strftime('%H', played_at,'localtime') < '09'`), **The Hog** (most plays in one local day: `GROUP BY requested_by_id, date(played_at,'localtime')`). Every hour and date expression MUST pass `'localtime'` (FR-012) — `played_at` is stored in UTC, so omitting it silently computes awards in the wrong timezone and produces plausible but wrong winners (research R4). All four also filter `requested_by_id IS NOT NULL` and honour `since`.
- [X] T024 [US2] In `src/services/statsQueries.js`, add the award registry (FR-010): a fixed, code-defined ordering with stable `key`, `name`, `description` and **`valueLabel`** per award — `valueLabel` being the unit the winning number is counted in (`"tracks"`, `"plays"`, `"shuffles"`, `"removals"`), which the contract returns on every award whether or not it has a winner; apply the **minimum of 3** qualifying plays to win (FR-013) — below that, emit `winner: null` and `value: null` rather than crowning the leader; apply the same `MIN(played_at) ASC` tie-break as the leaderboard (FR-015); and always return **every** award regardless of period or data (FR-014, SC-010). Replace the `awards: []` placeholder from T013.
- [X] T025 [P] [US2] Extend `test/services/statsQueries.test.js` with award-boundary cases: a play at 21:59 local does **not** count toward Night Owl while 22:00 does; 03:59 counts and 04:00 does not; 04:59 does **not** count toward Early Bird while 05:00 does; 09:00 does not. Add a play at 12:00 local and assert it counts toward **neither** award — FR-012 defines two deliberate dead zones (04:00–05:00 and 09:00–22:00), and a suite that probes only the four live edges passes just as happily against a predicate that accidentally tiles the whole day. Assert against local hours explicitly — a test that only checks "Night Owl has a winner" passes even when the timezone handling is wrong.
- [X] T026 [P] [US2] In `test/services/statsQueries.test.js`, add tests asserting an award with exactly 2 qualifying plays returns `winner: null`, 3 returns a winner, and that all eight award keys are present in the response on a completely empty database.
- [X] T027 [US2] Create `web/src/components/stats/StatsAwards.jsx`: a responsive card grid reflowing to fewer columns at narrow widths (FR-028), each card showing name, description, winner and value, with an explicit "no winner yet" state when `winner` is null. Handle `most_played_song` specially — its winner is a **track**, so `winner.userId` is null and `displayName` holds the track title; it must not render as a member avatar (see contract). Key cards off `key`, never array position.

**Checkpoint**: Leaderboard plus four working awards. FR-014/SC-010 now satisfied.

---

## Phase 5: User Story 3 — Compare stats across time periods (Priority: P3)

**Goal**: All Time / This Month / This Week toggle recomputing both sections.

**Independent Test**: With activity spanning more than a month, switch periods and
confirm totals and winners change, and that Week ⊆ Month ⊆ All Time.

- [X] T028 [US3] In `src/services/statsQueries.js`, extend `resolvePeriod()` to support `'week'` and `'month'`, computing the `since` boundary on **local calendar** boundaries and converting to the UTC scale `played_at` is stored on (research R4). Month = first day of the current local month: `date('now','localtime','start of month')`. Week = Monday of the current local week: `date('now','localtime','-6 days','weekday 1')` — **in that modifier order**. `'weekday 1','-7 days'` looks equivalent and is not: `weekday 1` is a no-op when today is already Monday, so the `-7 days` still applies and the window starts a week early every Monday. T030 tests exactly this. Keep the timezone basis identical to the award hour predicates in T023.
- [X] T029 [US3] In `src/services/statsQueries.js`, thread the resolved period through `buildStatsPayload()` so both the leaderboard and every award query receive the same `since`, and the response echoes the resolved `period` (contract: the client labels results from this field, not its own state).
- [X] T030 [P] [US3] In `test/services/statsQueries.test.js`, add period-boundary tests: a play one second before the local month start is excluded from `month` but included in `all`; a play on the current local Monday at 00:00 is included in `week`; running on a Monday does not shift the window back a week.
- [X] T031 [P] [US3] Create `web/src/components/stats/StatsPeriodToggle.jsx` — a segmented control with exactly three options (FR-016), the active one visibly indicated.
- [X] T032 [US3] Wire the toggle into `web/src/pages/Stats.jsx`: default `all` on open (FR-018), refetch on change without a full page reload (FR-017), reset to the default when the page is re-entered so no stale selection or data persists, and render empty states that **name the selected period** rather than falling back to another (FR-019).

**Checkpoint**: All three periods work across leaderboard and awards.

---

## Phase 6: User Story 4 — Behavior-based awards from tracked actions (Priority: P4)

**Goal**: Record every control action across all three transports, and add the four
event-derived awards.

**⚠️ T033–T042 (the recording half) must ship in the first release** — this data only
accrues forward. T043–T044 (the awards) may follow later.

**Independent Test**: Perform each of skip, pause, resume, remove, shuffle and clear from
the web dashboard, from a Discord command, and from the realtime controls; confirm each
is recorded with actor, affected track, and the track's original requester.

### Recording infrastructure

- [X] T033 [US4] Create `src/shared/statsEvents.js` exporting the event name `stats:event` and a factory producing the exact payload in [contracts/stats-api.md](./contracts/stats-api.md) — `{ type, actor: {id,name,avatar}|null, track: {title,url,requestedById,requestedBy}|null, metadata }` with `type` constrained to `skip | pause | resume | remove | shuffle | clear_queue | track_complete` — the closed set of FR-021, carrying the actor, timing and affected-track details FR-022 requires. Every emit site uses this factory so the recorded shape cannot drift between surfaces (FR-024). Lives in `shared/` because both `services/` and all three transports import it.
- [X] T034 [US4] In `src/persistence/db.js`, add `logEvent(payload)` inserting into `events`, serialising `metadata` to JSON, wrapped in `try/catch` + `logger.error` following the `addToHistory` shape (line 111). It MUST NOT rethrow (FR-025, SC-008).
- [X] T035 [US4] Create `src/services/statsRecorder.js` exporting a `registerStatsRecorder()` that subscribes to `stats:event` on `botEvents` from `src/events/bus.js` and calls `db.logEvent()`, resolving `guild_id` from `musicManager.guildId` and `target_user_id`/`target_user_name` from the payload's track. The listener MUST swallow every error — `EventEmitter` invokes listeners synchronously, so an uncaught throw propagates into the emitting transport and breaks the action being recorded (research R8). This module is the **only** writer of `events` rows.
- [X] T036 [US4] In `src/index.js`, load `statsRecorder` via `await import(...)` alongside the other dynamic imports (after `validateEnv`, never as a static import — Principle IV) and call `registerStatsRecorder()` with the other setup calls near `setupSocketServer(httpServer)`.

### Emit sites — all six actions × three surfaces (SC-006)

- [X] T037 [US4] In `src/services/playback.js`, emit `track_complete` (actor `null`) from the `trackEnd` handler at line 62 when a track ends naturally. Do **not** add a `_skipping` flag to `musicManager`: both skip paths and the auto-advance all call `advanceAndPlay({ skipCurrent: true })`, so only the caller distinguishes them (research R2).
- [X] T038 [P] [US4] In `src/transports/http/routes/playback.js`, emit `skip`, `pause` and `resume` using `req.user` as the actor. For `skip`, capture `musicManager.getCurrentTrack()` **before** the mutation or the wrong track is recorded. `pause` and `resume` carry the current track too — they target whatever is playing, so per FR-022 and the contract their `track` is non-null; read `musicManager.getCurrentTrack()` for them as well (ordering is immaterial there, since neither changes which track is current). Only `shuffle` and `clear_queue` emit a null `track`.
- [X] T039 [P] [US4] In `src/transports/http/routes/queue.js`, emit `remove` (`DELETE /:position`), `shuffle` (`POST /shuffle`) and `clear_queue` (`DELETE /`) using `req.user`. For `remove`, capture `musicManager.getQueue()[position]` **before** removing. `DELETE /` calls `queue.clear()` and empties everything including the current track, so its emit MUST carry `metadata: { variant: 'all' }` (see contracts/stats-api.md — the three surfaces clear different things).
- [X] T040 [P] [US4] In `src/transports/realtime/handlers.js`, emit from `handlePlayerControl` (skip, pause, resume, shuffle, clear) and `handleQueueRemove` (remove), using `socket.user` as the actor, capturing affected tracks before mutating. `pause` and `resume` carry the current track exactly as `skip` does — per the contract only `shuffle` and `clear_queue` emit a null `track`. The `'clear'` case calls `musicManager.clearUpcomingQueue()` and keeps what is playing, so its `clear_queue` emit MUST carry `metadata: { variant: 'upcoming' }` (see contracts/stats-api.md). Do **not** emit from the `'stop'` case — `stop` is not a tracked action (T041).
- [X] T041 [P] [US4] In `src/transports/discord/commands/playback.js`, emit from `handlePause` (line 107), `handleResume` (line 123) and `handleSkip` (line 143) only, using `interaction.user` as the actor. All three carry the current track: `musicManager` is already imported in this file (line 3), so `musicManager.getCurrentTrack()` is available even though these handlers otherwise bypass the mediator. These call `getPlayer()`/`advanceAndPlay` directly rather than going through `musicManager`, which is exactly why per-transport emission is required (research R1). **Do not emit from `handleStop`.** It runs `p.stop(); q.clear()` (lines 163-164) and so empties the queue, but `stop` is not one of the six tracked actions in FR-021 and is therefore recorded on no surface: HTTP `POST /api/player/stop` and realtime `'stop'` both call `musicManager.stop()`, which clears the queue too (`core/musicManager.js:215`), and neither emits. Emitting `clear_queue` here would make Discord the only surface that records a stop — a Principle III parity violation, not a fix for one. Discord's `clear_queue` comes solely from `handleClear` in T042.
- [X] T042 [P] [US4] In `src/transports/discord/commands/queue.js`, emit `remove` from `handleRemove` (line 95), `shuffle` from `handleShuffle` (line 113), and `clear_queue` from `handleClear` (line 119) — **the sole source of `clear_queue` on the Discord surface** (T041 deliberately does not emit one). Use `interaction.user` as the actor and capture the removed track before `q.remove(position)`. `handleClear` keeps the current track and drops the rest, so its emit MUST carry `metadata: { variant: 'all_but_current' }` — the three surfaces clear different things and the contract requires the variant be recorded (see contracts/stats-api.md).

### Event-derived awards

- [X] T043 [US4] In `src/persistence/db.js`, add the four remaining awards required by FR-011, specified in [data-model.md](./data-model.md) §3: **DJ Skip** (`event_type='skip' AND target_user_id <> actor_id`, grouped by `target_user_id`), **Self-Skip King** (`target_user_id = actor_id`, grouped by `actor_id`), **Queue Yeeter** (`event_type='remove'`), **Shuffle Addict** (`event_type='shuffle'`). All honour `since` and the same tie-break.
- [X] T044 [US4] Register the four awards in the `src/services/statsQueries.js` registry from T024, subject to the same 3-action minimum. They return `winner: null` until three qualifying actions accumulate — expected on day one (SC-004), not a defect.

### Tests

- [X] T045 [P] [US4] Add `test/services/statsRecorder.test.js` asserting that when `db.logEvent` throws, the bus emit still returns normally, the error is logged, and nothing propagates to the emitter (FR-025, SC-008).
- [X] T046 [P] [US4] Add `test/transports/statsParity.test.js` asserting the full **18-combination matrix** from the contract — six action types across HTTP, realtime and Discord — each producing a `stats:event` with an identical payload shape and a non-null actor, **and asserting `track` is non-null for `skip`, `pause`, `resume` and `remove` and null for `shuffle` and `clear_queue`**. Shape-equality between surfaces is not sufficient on its own: three surfaces that all uniformly omit `track` on pause are identically shaped and identically wrong, so per-type nullability must be asserted against the contract, not against the other surfaces. This is what makes SC-006 verifiable; a missed emit site otherwise fails silently, because the action still works and nothing errors.
- [X] T047 [P] [US4] In `test/services/playback.test.js`, add a test asserting a natural track end records `track_complete` with a null actor while an explicit skip records `skip` with its actor, and that the two are never crossed (FR-023).
- [X] T055 [P] [US4] In `test/services/statsQueries.test.js`, add direction and threshold tests for all four `events`-derived awards from T043/T044 — the one award group with no coverage otherwise. **DJ Skip is won by the victim, not the skipper**: with A skipping B's queued track three times, assert **B** wins DJ Skip and A wins nothing, and assert the inverse never holds. Assert the other three group by the actor — Self-Skip King on `actor_id = target_user_id`, Queue Yeeter on `remove`, Shuffle Addict on `shuffle` — and that each returns `winner: null` at 2 qualifying actions and a winner at 3. `GROUP BY actor_id` on DJ Skip compiles, returns a plausible winner and names the wrong person (data-model.md §3, direction note); no other test in the suite would catch it.

**Checkpoint**: All actions recorded on every surface; all eight awards present.

---

## Phase 7: Polish & Cross-Cutting Concerns

- [X] T048 [P] Verify `web/src/pages/Stats.jsx` and its components at 400px viewport width: no horizontal scrolling of the page body, award cards reflow, long names and titles truncate (FR-028, SC-011).
- [X] T049 [P] Verify determinism (SC-012) of `src/services/statsQueries.js` as served through `src/transports/http/routes/stats.js`: request `/api/stats?period=all` twice against unchanged data and confirm byte-identical `leaderboard` ordering and `awards` winners, then repeat for `week` and `month`. The tie-break keys in T011 and T024 are what this exercises.
- [X] T050 [P] Verify the performance criteria of `/api/stats` and `web/src/pages/Stats.jsx` against a seeded database of ~100,000 plays: the leaderboard and awards become readable within **2 seconds** (SC-002); switching period returns updated results within **1 second** (SC-003); and playback and queue operations show no measurable slowdown with recording active (SC-009). Seed the history rather than trusting a small dev dataset — all three targets are trivially met at low row counts and only bite at scale.
- [ ] T051 Work through [quickstart.md](./quickstart.md) end to end, including the timezone check in step 8 and the best-effort failure injection in step 6. **Status**: steps 1, 2, 3, 6, 7, 8 and 9 verified automatically (including a real 401 with `developerMode` unset, and the timezone check on a UTC+2 host where `utc_h=20` vs `local_h=22`). Steps 4, 5 and 10 need a live Discord bot, an OAuth session and a voice channel, so they remain to be run by hand against a configured deployment; their behavior is covered by `test/transports/statsParity.test.js` (18/18 combinations) and `test/services/playback.test.js` (FR-023) in the meantime.
- [X] T052 Run the Docker smoke test: build the image, boot it, confirm `/api/health` returns `{"status":"ok"}` and `/api/stats?period=all` answers with the migration applied in `/app/data` (Principle V).
- [X] T053 Re-run all CI gates green: root `npm run lint && npm run format:check && npm test`, and `web/` lint, format:check and build. Confirm `test/import-resolution.test.js` still passes — it is what catches a mistyped relative import, since the app cannot boot in CI.
- [X] T054 [P] Confirm the deletion of `docs/DJ_STATS_PLAN.md` is intentional and committed. **Status**: deletion confirmed intentional — it is superseded by this feature's spec, plan and research, and the only surviving reference is `research.md`'s note on where this design departs from it. Committed in ae7de91. The spec, plan and research deliberately depart from it on two points (no `_skipping` flag, single endpoint instead of two).

---

## Dependencies & Execution Order

### Phase dependencies

- **Setup (Phase 1)**: no dependencies
- **Foundational (Phase 2)**: depends on Setup — **blocks all user stories**. Now also carries the retention change (T006–T009); US1's leaderboard is technically buildable without it, but every figure it shows resets on each voice leave until T006 lands
- **US1 (Phase 3)**: depends on Phase 2
- **US2 (Phase 4)**: depends on US1 (extends `statsQueries.js` and the payload built in T013/T024)
- **US3 (Phase 5)**: depends on US1; best after US2 so the toggle exercises both sections
- **US4 (Phase 6)**: recording (T033–T042) depends only on Phase 2; awards (T043–T044) depend on US2's registry (T024)
- **Polish (Phase 7)**: depends on all desired stories

### Story independence

US1 is fully independent once Phase 2 lands. US2 and US3 genuinely build on US1's query
module and page rather than standing alone — they extend the same payload and the same
page, so they are incremental rather than parallel. **US4's recording half is the one
piece that is independent of everything except Phase 2**, which is what makes it safe to
ship early alongside US1 — and why it should be.

### Parallel opportunities

- In Phase 2: T003 → T004 are sequential (same files), and T006 → T007 both touch `client.js` so are safest in order; T005, T008 and T009 are test files and run in parallel
- T016, T017 run in parallel (two test files, no shared files). **T018 and T019 are not parallel** — both edit `Sidebar.jsx`, and T019 uses the icon literal T018 writes
- T025, T026 in parallel (test files)
- T030, T031 in parallel (test file and a new component)
- **T038–T042 are the biggest win**: five emit-site tasks across five separate files, all
  independent once T033–T035 exist
- T045, T046, T047, T055 in parallel
- T048, T049, T050, T054 in parallel

### Parallel example — US4 emit sites

```bash
Task: "Emit skip/pause/resume in src/transports/http/routes/playback.js"
Task: "Emit remove/shuffle/clear_queue in src/transports/http/routes/queue.js"
Task: "Emit from handlePlayerControl and handleQueueRemove in src/transports/realtime/handlers.js"
Task: "Emit from handlePause/handleResume/handleSkip in src/transports/discord/commands/playback.js"
Task: "Emit from handleRemove/handleShuffle/handleClear in src/transports/discord/commands/queue.js"
```

---

## Implementation Strategy

### First release (recommended)

1. Phase 1 → Phase 2
2. Phase 3 (US1) — leaderboard live
3. **T033–T042** — recording live on every surface
4. **STOP and VALIDATE**: leaderboard correct; every action recorded across all three
   transports; no playback regression
5. Ship. Data now accrues for the awards.

Dropping step 3 to "ship faster" is the one sequencing mistake this feature can make that
cannot be undone later.

### Then, incrementally

6. Phase 4 (US2) — four history awards appear, populated from data already collected
7. Phase 5 (US3) — period toggle
8. T043–T044 — the four behavior awards start resolving once three actions accumulate
9. Phase 7 — polish and full validation

---

## Notes

- `[P]` = different files, no dependencies on incomplete tasks
- Every stats write is best-effort: wrap, log, never rethrow, never block playback
- Every date/hour SQL expression needs `'localtime'` — `played_at` is stored in UTC
- Capture affected tracks **before** mutating for `skip` and `remove`
- Commit after each task or logical group
- **Task IDs are stable and never renumbered.** T055 was added by `/speckit-analyze` after Phase 7 was already numbered, so it sits in Phase 6 out of numeric order. Renumbering would silently invalidate the task citations in `plan.md` and the historical record in `remediation.md`; file position, not ID order, gives the sequence


## Phase 8: Convergence

- [X] T056 In `src/persistence/schema.sql` add `is_loop_replay INTEGER NOT NULL DEFAULT 0` to the `history` table, and in `DatabaseManager.migrate()` (`src/persistence/db.js`) add `ALTER TABLE history ADD COLUMN is_loop_replay INTEGER NOT NULL DEFAULT 0` behind its **own** `table_info` guard, not nested under the `requested_by_id` guard, so a database that already has the other two stats columns still gets it (data-model.md §1) per FR-005a (missing)
- [X] T057 In `src/core/queue.js`, make `next()` set `loopReplay = true` on the entry it returns when `loopMode !== 'off'` and that entry has `hasPlayed`; `previous()` MUST NOT set it. In `src/core/musicManager.js` `onTrackChange()`, read `track.loopReplay`, call `db.addToHistory(track, this.guildId, { loopReplay })`, then clear `loopReplay` and set `hasPlayed = true`. Extend `addToHistory(track, guildId, { loopReplay = false } = {})` in `src/persistence/db.js` to write `is_loop_replay` (research R11, data-model.md §5) per FR-005a (missing)
- [X] T058 In `src/persistence/db.js`, define one counted-play SQL fragment, `requested_by_id IS NOT NULL AND is_loop_replay = 0`, and use it in place of the separate `requested_by_id IS NOT NULL` filters in `getLeaderboard`, `getLeaderboardEntryForUser`, `getMostPlayedSongAward`, `getHogAward` and the shared hour-award helper used by Night Owl and Early Bird. Also update the comment at `db.js:253` (data-model.md §1) per FR-005a, SC-014 (missing)
- [X] T059 In `src/index.js`, add `'TZ'` to the `validateEnv([...])` list, and export `validateTimezone()` from `src/config/env.js`: build `new Intl.DateTimeFormat('en', { timeZone: process.env.TZ })` and rethrow a `RangeError` as a clear error naming `TZ` and its value. Call it right after `validateEnv`, before any dynamic import (research R10) per FR-030, Constitution IV (missing)
- [X] T060 In the `DatabaseManager` constructor (`src/persistence/db.js`), when `process.env.TZ` is set, compare `strftime('%H:%M', ?, 'localtime')` with `Intl.DateTimeFormat` in `TZ` for one fixed January instant and one fixed July instant, and throw an error naming `TZ` and "timezone data missing from runtime" if they differ. Skip the check when `TZ` is unset (research R10) per FR-030 (missing)
- [X] T061 [P] Set `test.env.TZ = 'Europe/Copenhagen'` in `vitest.config.js`, and in `test/services/statsQueries.test.js` add SC-013 cases that seed **fixed UTC** instants rather than host-local ones: `2026-07-15 21:30:00` (23:30 CEST) and `2026-01-15 22:30:00` (23:30 CET) both count toward Night Owl and toward local day the 15th. Also add a case showing This Week and This Month boundaries follow the configured zone across a DST change per SC-013 (partial)
- [X] T062 [P] Add tests for loop replays. In `test/music/queue.test.js`, cover every row of research R11's rules table: track-loop repeat, `/skip` in track-loop, the queue-loop second pass, an unplayed entry after a wrap, `previous` with loop on and off, and re-queuing the same URL. In `test/services/statsQueries.test.js`, assert a track played 20 times with 19 loop replays contributes 1 to `trackCount`, Most Played Song and The Hog, while `getHistory` returns all 20. In `test/persistence/migration.test.js`, add an upgrade case from a database that already has `requested_by_id` and `requested_by_avatar` but not `is_loop_replay` per SC-014, FR-005a (missing)
- [X] T063 [P] Create `test/config/env.test.js`: a missing `TZ` is reported in the same aggregated error as other missing variables, `TZ=Bogus/Zone` is rejected by `validateTimezone()` with a message naming the value, and `TZ=Europe/Copenhagen` passes per plan: R10 test file, FR-030 (missing)
- [X] T064 [P] Document `TZ` as required: add `TZ=Europe/Copenhagen` with a one-line comment to `.env.sample`, add it to the environment variable list in `README.md` (next to `GUILD_ID`, line 83), and add `-e TZ=Europe/Copenhagen` to the `docker run` in the smoke test of `.github/workflows/ci.yml` so the SQLite timezone probe runs in CI instead of being skipped (plan: R10 ripples, Constitution V) per FR-030 (missing)
- [X] T065 Re-run [quickstart.md](./quickstart.md) step 8 (missing or bogus `TZ` fails startup; summer/winter Night Owl) and the new step 8a (loop replays kept in History and excluded from stats), then re-run all CI gates from T053, including the Docker smoke test with `TZ` set per SC-013, SC-014 (partial). **Status**: TZ fail-fast (missing and `Bogus/Zone`), the summer/winter 23:30 probe in the built image, the `is_loop_replay` migration in `/app/data`, the root gates (332 tests), web gates, and the Docker smoke test (`/api/health` ok, `/api/stats` 401 unauthenticated) verified 2026-09-24. Step 8a's live `/loop track` run needs a Discord voice session and is covered by `test/music/queue.test.js` and the SC-014 cases in `statsQueries.test.js` meanwhile.
- [X] T066 Correct the stale status line in `spec.md` (line 7 still says "Implementation not started") to reflect the implemented state plus the 2026-09-24 delta. This is a maintainer-approved documentation fix, not a requirement change per spec: header (partial)
