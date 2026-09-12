# Phase 0 Research: DJ Stats Page

**Date**: 2026-09-12 | **Spec**: [spec.md](./spec.md)

All Technical Context unknowns are resolved below. No `NEEDS CLARIFICATION` markers remain.

---

## R1. Where to hook action recording so every transport is covered

**Decision**: Each transport emits a domain event on the existing shared bus
(`src/events/bus.js`) at the point where it performs an action; one subscriber,
`src/services/statsRecorder.js`, is the only module that writes stats rows.

**Rationale**: Two facts from the codebase force this shape.

1. **There is no existing single chokepoint.** The web and realtime surfaces route
   through `musicManager` (`musicManager.pause()`, `musicManager.skip()`), but the
   Discord commands do **not** — `handlePause` calls `getPlayer().pause()` directly,
   `handleResume` calls `p.resume()`, and `handleSkip` calls `advanceAndPlay(...)`
   itself (`src/transports/discord/commands/playback.js:107,123,143`). The same holds
   for queue actions: `handleRemove` calls `q.remove(position)`, `handleShuffle` calls
   `q.shuffle()`, and `handleStop` calls `p.stop()` + `q.clear()`, all directly on the
   core singletons (`commands/queue.js:95,113`, `commands/playback.js:163-164`).
   Instrumenting `musicManager` alone would silently miss every Discord action and
   break FR-024.
2. **Actor identity only exists at the transport boundary.** `core/player.js` and
   `core/queue.js` know *what* happened but never *who* did it. The actor is
   `req.user` (HTTP), `socket.user` (realtime), or `interaction.user` (Discord).
   Recording must therefore originate where the actor is in scope.

The bus is the constitutionally-designated mechanism for exactly this: Principle II
states cross-module notification MUST use `src/events/bus.js`, which "lives outside
every transport precisely so `core/` and `transports/` can both depend on it without
forming a cycle." It is already imported by both `core/musicManager.js` and
`transports/discord/client.js`, so this adds no new dependency direction.

A shared event-factory helper gives every emit site an identical payload shape, so
FR-024 ("recorded identically regardless of surface") is guaranteed by construction
rather than by discipline at **nineteen** emit sites spread over six files — the 18
action/surface combinations of the contract matrix plus one `track_complete`.

**Alternatives considered**:

- *Instrument `musicManager` only* — rejected: misses all Discord pause/resume/skip.
- *Route Discord commands through `musicManager` first* — rejected for this feature:
  it is a real improvement and moves toward Principle III, but it rewrites working
  playback paths and would make a stats feature responsible for a playback refactor.
  Recorded as a follow-up, not a prerequisite.
- *Instrument `core/player.js` and `core/queue.js`* — rejected: they have no actor,
  and passing an actor down into core would push transport concerns into `core/`.
- *Wrap each route/handler in middleware* — rejected: Discord slash commands and
  Socket.io handlers have no shared middleware layer with Express.

---

## R2. Distinguishing a skip from a natural track end

**Decision**: The `trackEnd` handler in `src/services/playback.js` emits a
`track-complete` event; the two explicit skip call sites emit a `skip` event. No
mutable `_skipping` flag on `musicManager`.

**Rationale**: Both skip paths (`musicManager.skip()` at `core/musicManager.js:153`
and Discord `handleSkip` at `transports/discord/commands/playback.js:143`) call
`advanceAndPlay({ ..., skipCurrent: true })`, and the `trackEnd` auto-advance
(`services/playback.js:62-66`) calls it with `skipCurrent: true` as well. The
`skipCurrent` argument therefore cannot distinguish the two — only the caller can.
Emitting at the three callers is unambiguous and avoids adding mutable state to the
`musicManager` singleton, which Principle I asks us not to grow.

**Alternatives considered**:

- *`_skipping` flag on `musicManager`* (the approach in the superseded
  `docs/DJ_STATS_PLAN.md`) — rejected: adds shared mutable state, and is racy if a
  skip and a natural end interleave.
- *Infer from track position/time remaining* — rejected: heuristic, untestable.

---

## R3. Enforcing "stats start at launch" (FR-005)

**Decision**: The launch boundary is encoded as data, not as a stored timestamp:
every stats query filters `WHERE requested_by_id IS NOT NULL`.

**Rationale**: `history` rows written before this feature have no `requested_by_id`
column at all; rows written after the migration always populate it. The column's
NULL-ness *is* the boundary, so no configuration, cutover date, or feature flag is
needed, and re-running the migration cannot corrupt it. This also self-heals: if a
future play somehow arrives without a stable id, it is simply excluded, which is
exactly what FR-005 requires rather than a silent misattribution.

**Alternatives considered**:

- *Store a launch timestamp and filter on `played_at`* — rejected: needs new config,
  and a clock change or a restore from backup would move the boundary.
- *Delete or migrate legacy rows* — rejected: destroys the History page's data, which
  is a separate, working feature.

---

## R4. SQLite stores UTC — but FR-012/periods are local time

**Decision**: Every date and hour expression passes SQLite's `'localtime'` modifier:
`strftime('%H', played_at, 'localtime')` for award windows, and
`date('now','localtime', ...)` for period boundaries.

**Rationale**: This is the highest-risk correctness trap in the feature. `played_at`
and `created_at` default to `CURRENT_TIMESTAMP`, which SQLite records in **UTC**.
Reading the hour without `'localtime'` silently computes Night Owl and Early Bird in
UTC, so in a UTC+2 deployment every award lands two hours off — a bug that produces
plausible-looking winners and would not be caught by a test that only checks "an
award has a winner". Tests MUST assert boundary hours explicitly.

Period boundaries in local time:

| Period | Predicate |
|---|---|
| All Time | `requested_by_id IS NOT NULL` (no date bound) |
| This Month | `played_at >= datetime(date('now','localtime','start of month'),'utc')` |
| This Week | `played_at >= datetime(date('now','localtime','-6 days','weekday 1'),'utc')` |

Week starts Monday. SQLite's `weekday 1` advances to the next Monday **unless today is
already a Monday, in which case it does nothing at all**. That no-op is the whole trap:
the obvious-looking `'weekday 1','-7 days'` subtracts a full week on Mondays, because
nothing was added back, so the window silently starts seven days early one day in seven.

`'-6 days','weekday 1'` is correct on all seven days. Step back six days first — which
from any day of the week lands somewhere in the span `[this Monday, next Monday)` — then
advance to the nearest Monday at or after that point. On a Monday the `-6 days` lands on
the previous Tuesday and `weekday 1` walks forward to today; on a Sunday it lands on the
previous Monday, where `weekday 1` is the no-op and stays put. Verify with:

```bash
python3 -c "import sqlite3; c=sqlite3.connect(':memory:'); \
print([c.execute(\"SELECT date(?,'-6 days','weekday 1')\",(d,)).fetchone()[0] \
for d in ['2026-09-07','2026-09-08','2026-09-09','2026-09-10','2026-09-11','2026-09-12','2026-09-13']])"
```

All seven days must return `2026-09-07`, the Monday of that week.

The inner `date(...)` produces a local calendar day; the outer `datetime(..., 'utc')`
converts it back to the UTC scale the column is stored on, so the comparison is
apples-to-apples.

**Alternatives considered**:

- *Store epoch integers* — cleaner long-term, rejected here: would require rewriting
  existing `history` rows and the working History page.
- *Compute boundaries in JavaScript and bind them* — viable and arguably clearer;
  rejected only for consistency, since the award-hour predicates need `'localtime'`
  inside SQL anyway. Either is acceptable at implementation time provided both use
  the same timezone basis.
- *A `STATS_TZ` env var* — rejected: Principle IV would require adding it to
  `validateEnv` as a fail-fast requirement, and the spec's assumption is explicitly
  "the deployment's local timezone".

---

## R5. Determinism of rankings and award winners (FR-007, FR-015, SC-012)

**Decision**: Every ranking query ends with an explicit total-order tie-break:
`ORDER BY <metric> DESC, MIN(played_at) ASC, requested_by_id ASC`.

**Rationale**: `ORDER BY count DESC` alone leaves ties in storage order, which SQLite
may change after an index is added or rows are rewritten. SC-012 requires identical
results across repeated loads, so the sort must be a total order. "Earliest to reach
the score wins" is also the intuitive reading of a leaderboard tie; `requested_by_id`
is the final, guaranteed-unique fallback.

---

## R6. One stats endpoint or two

**Decision**: A single `GET /api/stats?period=` returning leaderboard and awards
together.

**Rationale**: The page always renders both sections, and the period toggle changes
both at once (FR-017). One round trip per toggle is the simplest way to meet SC-003
(under 1 second) and removes any possibility of the two sections disagreeing about
which period they are showing — a real risk with two in-flight requests when a member
toggles quickly. Both queries hit the same indexed tables and are milliseconds apart
at the 100k-play scale of SC-002.

**Alternatives considered**:

- *Separate `/leaderboard` and `/awards`* (the shape in the superseded plan doc) —
  rejected: two round trips, and needs client-side sequencing to prevent a stale
  response from one endpoint landing after a newer response from the other.

---

## R7. Rate limiting and auth for the stats route

**Decision**: Mount at `app.use('/api/stats', statsRoutes)` with `authMiddleware`, and
**without** `mutationLimiter`.

**Rationale**: FR-002 requires the page be visible only to members already authorized to
use the dashboard, "with no additional or relaxed restrictions", and constitution
Principle I states that web access MUST remain gated on membership of the configured
guild. `authMiddleware` (`src/transports/http/middleware/auth.js:72-89`) enforces exactly
that: it verifies the session token and returns **401** when it is missing or invalid,
while still honouring `developerMode` for local runs.

`mutationLimiter` stays off. `src/transports/http/index.js` applies it only to
state-changing route groups, and its `skip` predicate already exempts GET/HEAD/OPTIONS,
so attaching it to a read-only router would be inert.

**Corrected 2026-09-12 — this decision originally specified `optionalAuth`.** The
original reasoning was that it matched the existing read-only `/api/queue/history` route.
That was wrong on the facts: `optionalAuth` (`auth.js:94-112`) calls `next()`
**unconditionally** — it attaches `req.user` when a valid token is present and otherwise
proceeds anyway, so it never rejects. The stats endpoint would have been readable by
anyone who could reach the server, exposing per-member behavioral data (who skips whose
songs) in violation of FR-002 and a constitution MUST. The `/api/queue/history` precedent
may itself be a pre-existing gap; that is out of scope here and is not a licence for a
new one.

**Consequence for the contract**: there is no anonymous caller. Every request that
reaches the handler carries a `req.user`, so `isSelf` always resolves against a known
member and `selfEntry` is driven purely by rank rather than by auth state.

---

## R8. Best-effort recording without blocking playback (FR-025)

**Decision**: The recorder wraps every write in `try/catch`, logs on failure via
`logger.error`, and returns normally. No retry, no queue. Bus listeners are invoked
synchronously by Node's `EventEmitter`, so the recorder must never throw — an
uncaught listener error would propagate into the emitting transport's call stack and
break the action itself.

**Rationale**: This mirrors the shape `db.addToHistory` already uses
(`persistence/db.js:111-133`): validate, `try`, `catch`, `logger.error`, return. Using
the identical pattern keeps the codebase consistent and satisfies FR-025 and SC-008
(every failure logged, none silent). The clarification session explicitly chose
best-effort over durability, on the grounds that a lost record shifts a superlative
while a stalled write stalls playback.

**Note for implementation**: `better-sqlite3` is synchronous, so there is no promise
to reject — a `try/catch` around the statement is genuinely sufficient here.

---

## R9. Frontend integration points

**Decision**: Follow the existing view-routing chain exactly; add no router library.

**Rationale**: The app has no React Router. Navigation is the `NAV_ITEMS` array in
`Sidebar.jsx` (line 24) → `onViewChange` → `Dashboard` `activeView` state → `CenterPanel`
switch → page component, exactly as the History page does (`CenterPanel.jsx`, switches at
lines 50, 62, 89). Adding a fourth `NAV_ITEMS` entry plus a `case 'stats'` in each of
`CenterPanel`'s three switches is the whole integration; `Dashboard` needs no change,
because it holds `activeView` as opaque state (`useState`/`setActiveView`) and never
enumerates the view ids.

**The icon must be an inline SVG literal written into `NAV_ITEMS`, not an import.**
`Sidebar.jsx` imports nothing from `components/icons/`; each of its three entries carries
its own `<svg width="15" height="15" fill="none" viewBox="0 0 24 24" stroke="currentColor"
strokeWidth="2">`. `components/icons/index.jsx` is a different visual family — 24×24,
`fill="currentColor"`, no stroke — so pulling an icon from there would render a filled
glyph beside three stroked outlines at the wrong weight, and add an import the file has
never had. Follow the file's own pattern. Data fetching follows `pages/History.jsx`: `useCallback` + `fetch` with
`credentials: 'include'`, loading and error state, retry button — which is what
FR-029 asks for.

**Note**: `CenterPanel` has **three** separate switches on `activeView` (header,
subheader, and body at lines 50, 62, 89). All three need a `stats` case, or the page
renders with the wrong chrome. This is easy to half-do and worth an explicit task.
