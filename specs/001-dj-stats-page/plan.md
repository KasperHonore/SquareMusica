# Implementation Plan: DJ Stats Page

**Branch**: `001-dj-stats-page` | **Date**: 2026-09-12 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `/specs/001-dj-stats-page/spec.md`

## Summary

Add a read-only **DJ Stats** page to the web dashboard showing a top-10 DJ leaderboard,
eight fun awards, and an All Time / This Month / This Week toggle — plus the recording
that feeds them: a stable requester identity on every play, and a new `events` table
capturing skips, pauses, resumes, removes, shuffles, clears, and natural track
completions across all three transports.

The technical shape is driven by one finding from the codebase: **there is no existing
single chokepoint for control actions.** The web and realtime surfaces go through
`musicManager`, but the Discord commands call `getPlayer().pause()`, `p.resume()`, and
`advanceAndPlay(...)` directly. Worse, actor identity — who did it — exists *only* at
the transport boundary; `core/player.js` and `core/queue.js` never see a user.

So each transport emits a `stats:event` on the existing shared bus
(`src/events/bus.js`) at its action site, and a single subscriber,
`services/statsRecorder.js`, is the only module that writes stats rows. That is the
mechanism Principle II already designates for cross-module notification, it keeps
`core/` free of any transport import, and a shared event factory makes the recorded
shape identical across surfaces by construction rather than by discipline at **nineteen
emit sites across six files** — the 18 action/surface combinations of the contract matrix
(6 actions × 3 transports, SC-006) plus one `track_complete` from `services/playback.js`
(FR-024).

Play attribution is far simpler: `db.addToHistory` has exactly one caller
(`musicManager.onTrackChange`), so FR-004 is two new columns and a pass-through of
values the track already carries.

## Technical Context

**Language/Version**: Node.js ≥ 22.12.0, ES modules (`"type": "module"`) throughout

**Primary Dependencies**: Backend — express 4, better-sqlite3 9, socket.io 4,
discord.js 14. Frontend — React 18, Vite, Tailwind. **No new runtime dependency is
added by this feature.**

**Storage**: Existing SQLite database via `src/persistence/db.js`. One new table
(`events`), two additive columns on `history`, four new indexes.

**Testing**: Vitest (`npm test`), mirroring the existing `test/http/routes/`,
`test/transports/realtime/`, and `test/services/` layout with `vi.mock` of the
db/musicManager/auth boundaries.

**Target Platform**: Linux server in Docker; dashboard in modern browsers down to
400px width.

**Project Type**: Web application — Express + Socket.io + Discord backend under `src/`,
React SPA under `web/`.

**Performance Goals**: Stats page readable within 2s at 100k plays (SC-002); period
switch under 1s (SC-003). Both are single indexed SQLite aggregate queries.

**Constraints**: Recording is best-effort and MUST never block, delay, or fail a
playback operation (FR-025). `better-sqlite3` is synchronous and bus listeners run
synchronously, so the recorder must not throw. All date/hour SQL must use `'localtime'`
— `CURRENT_TIMESTAMP` is stored in UTC (R4).

**Scale/Scope**: One Discord guild, realistically 5–30 active DJs. Counted from `tasks.md`:
4 backend files added and 14 modified; 5 frontend files added and 2 modified; 6 test files
added and 1 modified — **25 production files, or 32 including tests**, touched by 55 tasks.
(The earlier "23 files" total silently excluded the seven test files it had just enumerated.)

## Constitution Check

*GATE: evaluated before Phase 0 and re-evaluated after Phase 1 design.*

| Principle | Gate | Verdict |
|---|---|---|
| **I. Single-Guild Scope** | No per-guild partitioning of playback state; no new `musicManager.guildId \|\| process.env.GUILD_ID` duplication | **PASS** — `events.guild_id` mirrors `history.guild_id` for consistency only and never keys state. The recorder reads the guild from `musicManager.guildId` at its single write site, adding no new copies of the idiom. Web access stays gated by the existing auth. T006 additionally deletes `musicManager.clearHistory()` once its last caller goes, closing the second clause of the ADR-001 follow-up item 5 rather than adding to it. |
| **II. Layered Dependency Direction** | `core/` MUST NOT import `transports/`; cross-module notification via `events/bus.js`; persistence only via `persistence/db.js` | **PASS** — the design is *built* on the bus. `statsRecorder` lives in `services/` and imports only `events/bus.js`, `persistence/db.js`, and the logger. No new `core/ → transports/` edge; the standing `services/playback.js` exception is not touched or extended. |
| **III. Transport Parity** | A capability MUST NOT silently diverge across Discord, HTTP, Socket.io | **PASS, with the feature's main risk** — see note below. |
| **IV. Fail-Fast Configuration** | Required config validated up front; no import-time side effects before `validateEnv` | **PASS** — this feature introduces **no new environment variables** (R4 rejected a `STATS_TZ` var for exactly this reason). No new module acts at import time. |
| **V. CI-Enforced Validation Gates** | lint, format:check, vitest, web build, docker smoke must all pass | **PASS** — new tests land under `test/`; `test/import-resolution.test.js` is neither weakened nor skipped and will validate the new relative imports for free. |

**Principle III note — the real risk.** Parity here is not automatic. The recording
sites are spread across three transports because that is the only layer where the actor
exists, and a missed site is a *silent* gap: the action still works, nothing errors, and
an award is simply wrong forever. Two mitigations are load-bearing and must survive into
`tasks.md`:

1. All emit sites use one shared event-factory helper, so the payload shape cannot drift.
2. A test asserts the full 18-combination matrix from `contracts/stats-api.md` (6 action
   types × 3 surfaces), which is what makes SC-006 verifiable rather than aspirational.

This feature deliberately does **not** fix the underlying divergences it documents. There
are **two**, not one, and both predate this feature:

1. **Discord bypasses `musicManager`** for pause/resume/skip, calling `getPlayer()` and
   `advanceAndPlay(...)` directly. This is what forces per-transport emit sites.
2. **"Clear the queue" means three different things.** HTTP `DELETE /api/queue` calls
   `queue.clear()` and empties everything; realtime `'clear'` calls
   `clearUpcomingQueue()` and leaves the current track playing; Discord `handleClear`
   rewrites the queue to just the current track. One label, three user-visible outcomes.
   This feature does not reconcile them — it makes the divergence *legible* by requiring
   every `clear_queue` event to record which variant occurred in `metadata`
   (`contracts/stats-api.md`). Recording it is the honest option: collapsing all three
   into one undifferentiated event type would let a stats page assert a parity the
   product does not have.

Fixing either would make a stats page responsible for refactoring working playback paths.
Both are recorded as follow-ups in Complexity Tracking.

**`stop` is tracked on no surface, deliberately.** FR-021 lists exactly six actions and
`stop` is not one of them, so no emit site exists for it. The trap: stopping *does* clear
the queue — `musicManager.stop()` calls `queue.clear()` (`core/musicManager.js:215`), and
HTTP, realtime and Discord all reach that outcome — so instrumenting one surface's stop
with `clear_queue` looks like closing a gap and is in fact the parity violation this
section warns about. It is called out here and in the contract because it is exactly the
kind of thing a later reader "fixes" by adding a single emit.

## Project Structure

### Documentation (this feature)

```text
specs/001-dj-stats-page/
├── plan.md              # This file
├── research.md          # Phase 0 output — 9 resolved decisions
├── data-model.md        # Phase 1 output — schema, migration, read models
├── quickstart.md        # Phase 1 output — end-to-end validation guide
├── contracts/
│   └── stats-api.md     # Phase 1 output — HTTP contract + bus event contract
├── checklists/
│   └── requirements.md  # From /speckit-specify
└── tasks.md             # Phase 2 — NOT created by /speckit-plan
```

### Source Code (repository root)

```text
src/
├── index.js                            # MODIFY  T036 register statsRecorder (dynamic import, post-validateEnv)
├── persistence/
│   ├── schema.sql                      # MODIFY  T003 events table + indexes; history columns + history index
│   └── db.js                           # MODIFY  T004,T007,T010-T012,T023,T034,T043 migrate, addToHistory,
│                                       #         clearAllEvents, logEvent, all stats SQL
├── core/
│   └── musicManager.js                 # MODIFY  T006 delete clearHistory() — zero callers once
│                                       #         the four voice-leave sites are gone
├── services/
│   ├── statsRecorder.js                # NEW     T035 sole bus subscriber; sole writer of events
│   ├── statsQueries.js                 # NEW     T013,T024,T028,T029,T044 period boundaries, award registry, shaping
│   └── playback.js                     # MODIFY  T037 emit track_complete from trackEnd
├── shared/
│   └── statsEvents.js                  # NEW     T033 event factory — one payload shape (FR-024)
└── transports/
    ├── http/
    │   ├── index.js                    # MODIFY  T015 mount /api/stats
    │   └── routes/
    │       ├── stats.js                # NEW     T014 GET /api/stats
    │       ├── playback.js             # MODIFY  T038 emit skip/pause/resume
    │       └── queue.js                # MODIFY  T039 emit remove/shuffle/clear_queue
    ├── discord/voiceManager.js         # MODIFY  T006 fix comment naming the deleted method
    ├── realtime/handlers.js            # MODIFY  T006 drop clearHistory; T040 emit from
    │                                   #         handlePlayerControl, handleQueueRemove
    └── discord/
        ├── client.js                   # MODIFY  T006 drop clearHistory (BOTH inactivity paths);
        │                               #         T007 GuildDelete clears events too
        └── commands/
            ├── voice.js                # MODIFY  T006 drop clearHistory from /leave
            ├── playback.js             # MODIFY  T041 emit from handlePause/handleResume/handleSkip
            │                           #         (NOT handleStop — stop is not a tracked action)
            └── queue.js                # MODIFY  T042 emit from handleRemove/handleShuffle/handleClear

web/src/
├── pages/Stats.jsx                     # NEW     T021,T032 page container, period state, fetch
├── components/stats/
│   ├── index.jsx                       # NEW     T002 barrel
│   ├── StatsLeaderboard.jsx            # NEW     T022
│   ├── StatsAwards.jsx                 # NEW     T027
│   └── StatsPeriodToggle.jsx           # NEW     T031
├── components/layout/Sidebar.jsx       # MODIFY  T018,T019 inline-SVG icon + NAV_ITEMS entry
└── components/center/CenterPanel.jsx   # MODIFY  T020 THREE switches (lines 50, 62, 89)

test/
├── persistence/migration.test.js       # NEW     T005 idempotent migration, columns, indexes
├── transports/voiceLeaveRetention.test.js  # NEW T008,T009 retention + GuildDelete symmetry
├── transports/statsParity.test.js      # NEW     T046 18-combination emit matrix (SC-006)
├── http/routes/stats.test.js           # NEW     T016 contract, period validation, 401, shapes
├── services/statsQueries.test.js       # NEW     T017,T025,T026,T030,T055 localtime boundaries,
│                                       #         3-minimum, tie-breaks, period boundaries,
│                                       #         event-award direction (DJ Skip won by victim)
├── services/statsRecorder.test.js      # NEW     T045 best-effort: throws are swallowed + logged
└── services/playback.test.js           # MODIFY  T047 track_complete vs skip never crossed
```

File counts above are derived from the task text in `tasks.md`, not estimated: **4 backend
files added and 14 modified; 5 frontend files added and 2 modified; 6 test files added and
1 modified** — 25 production files, 32 including tests.

`core/musicManager.js` **is** touched, by exactly one deletion: T006 removes the
now-callerless `clearHistory()`. It is **not** touched for attribution — an earlier draft
listed it as a MODIFY to "pass id/avatar through onTrackChange", and that was wrong:
`addToHistory` already receives the whole track object, which already carries
`requestedById` and `requestedByAvatar` on all three transports. `voiceManager.js` is
touched only to correct a comment that names the deleted method.
`components/icons/index.jsx` is not touched at all: the Sidebar's nav icons are inline SVG
literals in `NAV_ITEMS` and that module is a different visual family (research R9).


**Structure Decision**: The repository is an established two-tree web application —
a Node backend under `src/` following the constitution's layered ordering
(`config`/`core`/`events`/`persistence`/`services`/`shared`/`transports`/`utils`), and a
React SPA under `web/`. This feature adds no new top-level directory and introduces no
new architectural layer; every new file slots into an existing one. `statsEvents.js`
goes in `shared/` because both `services/` and all three transports import it, and
`shared/` is the layer that may be depended on from anywhere without creating a cycle.

## Complexity Tracking

No constitution violations require justification. Three deliberate trade-offs are recorded
here because a reviewer will reasonably question each:

| Decision | Why | Simpler alternative rejected because |
|---|---|---|
| Emit from 19 sites across 6 files rather than one chokepoint | Actor identity exists only at the transport boundary, and Discord bypasses `musicManager` for pause/resume/skip | Instrumenting `musicManager` alone is simpler but silently misses every Discord action, breaking FR-024 and SC-006. Pushing the actor down into `core/` would put transport concerns in `core/`, violating Principle II |
| Leave Discord's `musicManager` bypass in place | Routing Discord through `musicManager` is the right long-term fix and moves toward Principle III, but it rewrites working playback paths | Folding a playback refactor into a stats feature enlarges the blast radius well beyond what the spec asks for. Recorded as a follow-up, to be raised on its own merits |
| Leave the three divergent "clear" semantics in place and record the variant in `metadata` | HTTP clears everything, realtime clears only upcoming, Discord keeps the current track — a pre-existing product divergence this feature discovered rather than caused | Emitting one undifferentiated `clear_queue` would let the stats page assert a parity that does not exist, and any derived count would silently equate three outcomes. Reconciling the three is a playback behavior change needing its own decision, not a side effect of adding a leaderboard |

## Phase Status

- [x] **Phase 0** — `research.md`, 9 decisions, no `NEEDS CLARIFICATION` remaining
- [x] **Phase 1** — `data-model.md`, `contracts/stats-api.md`, `quickstart.md`
- [x] Constitution re-checked post-design — still PASS; no new violations introduced
- [x] **Phase 2** — `tasks.md`, 55 tasks (`/speckit-tasks`; amended by `/speckit-analyze` 2026-09-12)
- [x] Analyzed 2026-09-12 — 0 CRITICAL, FR 29/29 and SC 12/12 covered; 12 findings applied
