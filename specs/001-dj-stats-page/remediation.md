# Remediation Plan: DJ Stats Page

**Created**: 2026-09-12 | **Source**: `/speckit-analyze` findings F1–F10
**Status**: Stages 1–7 applied. **Stage 5 has now been run** (`/speckit-analyze`, 2026-09-12): **0 CRITICAL**, FR coverage 29/29, SC coverage 12/12, constitution PASS on all five principles — the gate this file set is met. That pass raised 12 further findings (2 HIGH, 6 MEDIUM, 4 LOW), all of which are now fixed; see **Stage 7** for the per-finding record. FR count remains **29** (FR-001..FR-029), SC count 12; tasks are now **55** (T055 added). The only outstanding work is the Stage 1 *code* change, tracked as ordinary tasks **T006–T009** in `tasks.md` and executed by `/speckit-implement` like any other task. **Design is complete; the next step is `/speckit-implement`.**

This file is **self-contained**. It assumes no memory of the session that produced it.
Each item carries its own evidence and a command to re-verify that evidence still holds.

**Artifacts under remediation**: `spec.md`, `plan.md`, `research.md`, `data-model.md`,
`contracts/stats-api.md`, `quickstart.md`, `tasks.md` — all in `specs/001-dj-stats-page/`.
No production code has been written yet; this is all still design.

---

## The order, and why it matters

```text
Stage 1  Decide + amend spec.md            (changes requirement numbering)
Stage 2  Fix the auth defect               (downstream docs only)
Stage 3  Add missing task coverage         (tasks.md only)
Stage 4  Sweep ALL FR/SC citations         (must be last)
Stage 5  Re-run /speckit-analyze
```

**Stage 4 must come last.** Finding F4 exists precisely because ~20 citations were
written against a requirement numbering that later shifted when clarifications inserted
FR-012 and FR-013. Stage 1 will insert or amend requirements again. Sweeping citations
before the numbering settles means doing the same work twice and probably re-introducing
the same class of error.

Stages 2 and 3 are independent of numbering and can be done in either order, or in
parallel with Stage 1 if you prefer.

---

## Stage 1 — Retention (F1 + F2). CRITICAL. Start here.

### DECISION (made 2026-09-12): stop wiping history on voice-leave

Option A, **scoped to voice-leave only**. History survives the bot leaving a voice
channel. It is still cleared when the bot is removed from the guild entirely
(`Events.GuildDelete`) — that path is deliberate and stays.

### What's wrong today

`spec.md:235` asserts:

> **Retention**: Recorded plays and actions are retained indefinitely, matching the
> existing treatment of play history.

**This is false about the current codebase.** `musicManager.clearHistory()`
(`src/core/musicManager.js:206`) calls `db.clearAllHistory()` — an unconditional
`DELETE FROM history` (`src/persistence/db.js:154-158`).

**Re-verify**:

```bash
grep -n "clearAllHistory" src/persistence/db.js
grep -rn "clearHistory" src/ --include=*.js | grep -v persistence
```

### The five clearing paths — four change, one stays

| # | Trigger | Location | Action |
|---|---|---|---|
| 1 | Inactivity timer, cached-channel path | `src/transports/discord/client.js:79` | **remove the `clearHistory` call** |
| 2 | Inactivity timer, fallback-fetch path | `src/transports/discord/client.js:106` | **remove the `clearHistory` call** |
| 3 | `/leave` slash command | `src/transports/discord/commands/voice.js:43` | **remove the `clearHistory` call** |
| 4 | Dashboard leave control | `src/transports/realtime/handlers.js:313` | **remove the `clearHistory` call** |
| 5 | Bot removed from the guild (`Events.GuildDelete`) | `src/transports/discord/client.js:33-38` | **KEEP** — wiping a guild's data when the bot is ejected from it is correct, and with single-guild scope (Principle I) the bot has no purpose there afterwards |

**Gotcha**: sites 1 and 2 are a *duplicated six-line block* — the inactivity-timer
callback appears twice in `client.js`, once for the cached-channel path and once for the
fallback fetch. Both must be edited; changing only one leaves the wipe firing whenever
the channel cache misses, which is exactly the kind of bug that looks fixed in testing.

### Consequences to handle

**F2 is NOT auto-resolved by this decision.** Path 5 survives, and it clears `history`
while nothing clears `events` — so the asymmetry persists, just more rarely. The
`GuildDelete` handler must clear **both** tables, or the page shows behavior-award
winners above an empty leaderboard after the bot is re-added to the guild.

**Keep the `historyCleared` event.** It is still emitted by path 5 and is wired through
`src/transports/realtime/socketServer.js:197` to the dashboard, which refetches on it
(`web/src/pages/History.jsx`, the `historyVersion` effect). The existing assertions in
`test/transports/realtime/socketServer.test.js:81,91` stay valid. Do not remove the event
or its listener while cleaning up the call sites.

**`db.clearAllHistory()` stays live** — path 5 calls it.

> **Superseded in part by Stage 7 (2026-09-12).** The sentence that followed here — "this
> change does *not* touch constitution ADR-001 follow-up item 5 … no constitution debt is
> closed or expanded" — was written on the assumption that `musicManager.clearHistory()`
> survives. It does not. Path 5 (`Events.GuildDelete`, `client.js:33-38`) calls
> `db.clearAllHistory()` **directly** and emits `historyCleared` itself; it never routes
> through `musicManager`. So once sites 1–4 are gone, `musicManager.clearHistory()` has
> zero callers, and T006 now deletes it — which **closes the second clause of item 5**
> ("`clearHistory` calls `db.clearAllHistory()`"). `db.clearHistoryByGuild` remains dead
> code and is still untouched debt. `db.clearAllHistory()` itself stays live either way.

**The History page changes meaning** — from "this session" to "everything since the bot
joined". It already paginates (`limit`/`offset` with a load-more control), so unbounded
growth is handled in the UI. At friend-group scale the table growth is negligible. There
is now no user-facing way to clear history short of removing the bot from the guild;
adding one is out of scope for this feature but worth noting as a follow-up.

**ADR: not required, optional.** The Development Workflow section mandates an ADR for
decisions touching guild scope, Principle II layer boundaries, or transport parity. This
touches none of the three — all four edited call sites behave identically before and
after across every transport, so parity is preserved. Record it as an ADR only if you
want the product-behavior change documented for its own sake.

### Spec amendments — ✅ DONE (2026-09-12)

- [x] Retention assumption rewritten (`spec.md`, Assumptions) — now states plays and
      actions are retained while the bot remains in the guild and cleared together if it
      is removed, and explicitly flags that this **changes** existing behavior
- [x] **FR-025 repurposed**: play history MUST NOT be deleted when the bot leaves a voice
      channel (inactivity timeout, leave command, or dashboard control)
- [x] **FR-026 added**: guild removal MUST clear plays and actions together
- [x] "No manual clear" assumption added — no dashboard clear control is in scope
- [x] Edge case added for unbounded history growth
- [x] FR count 27 → 28; old FR-026/FR-027 shifted to FR-027/FR-028

<details><summary>Original instruction (superseded)</summary>

- Rewrite the `spec.md:235` Retention assumption. "Matching the existing treatment of
      play history" is wrong in both directions — the existing treatment is a wipe, and
      this feature *changes* it. State that plays and actions are retained for as long as
      the bot remains in the guild, and are cleared together if it is removed.
- [ ] Amend **FR-025** to the same guarantee — "retained indefinitely" flat is still
      inaccurate given path 5.
- [ ] Add a new FR: play history MUST NOT be deleted when the bot leaves a voice channel.
      This is now in-scope behavior change and needs its own requirement and task, not a
      silent edit.

</details>

### Tasks to add to `tasks.md`

- [ ] Remove the `clearHistory` call from all four voice-leave paths (sites 1–4 above);
      one task, since leaving any single site behind reintroduces the bug
- [ ] Extend the `GuildDelete` handler to clear `events` alongside `history` (F2)
- [ ] Test: leaving a voice channel — via inactivity timer, `/leave`, and the dashboard —
      leaves `history` intact
- [ ] Test: `GuildDelete` clears both `history` and `events`

### Done when

- [ ] Sites 1–4 no longer clear history; site 5 clears both tables
- [ ] `historyCleared` event, socket forwarding and frontend refetch still work
- [ ] Retention assumption and FR-025 match actual behavior; new FR added
- [ ] Tasks and tests added for both the removal and the `GuildDelete` symmetry

---

## Stage 1b — Award/track ambiguity (F6). ✅ DONE (2026-09-12).

`FR-010` says every award has "the winning **member**", and `FR-013` gates on "a member
whose qualifying count… is below 3". But **Most Played Song's winner is a track, not a
member** — `contracts/stats-api.md` handles this explicitly, the spec never acknowledges
it, and FR-013's minimum is undefined for it.

**Fix**: amend FR-010 and FR-013 to cover track-valued awards. Decide whether the
3-item minimum applies to Most Played Song (recommendation: yes — a song played twice is
not "most played").

**✅ Applied**: FR-010 now says "the winner" and notes it may be a track; FR-013 gates on
"any candidate — member or track"; FR-014 reworded to match. The 3-item minimum applies to
Most Played Song, so a track played twice does not win.

**Still outstanding**: `contracts/stats-api.md` and `data-model.md` use member-centric
phrasing around the award winner. Reword them in Stage 3 for consistency — behavior is
already correct in both.

---

## Stage 2 — Auth defect (F3). ✅ DONE (2026-09-12).

### What's wrong

`research.md:176-183` (decision R7) chose `optionalAuth` for the stats route, and
`tasks.md:92` (T010) and `contracts/stats-api.md:8` follow it.

`optionalAuth` (`src/transports/http/middleware/auth.js:94-112`) calls `next()`
**unconditionally**. It attaches `req.user` when a valid token is present and otherwise
proceeds anyway — it never rejects. `GET /api/stats` would be readable by anyone who can
reach the server, exposing per-member behavioral data (who skips whose songs).

**Re-verify**:

```bash
sed -n '94,112p' src/transports/http/middleware/auth.js
```

This breaks:

- **FR-002** — "with no additional or **relaxed** restrictions"
- **Constitution Principle I** — *"Web access MUST remain gated on membership of the
  configured guild."* A constitution MUST, so this is non-negotiable.
- **`contracts/stats-api.md:107`** — documents a 401 that `optionalAuth` can never emit.

The original reasoning argued from the existing `/api/queue/history` route also using
`optionalAuth`, without checking what the middleware actually does. That precedent may
itself be a pre-existing gap; either way it does not license a new one.

### Fix

Replace `optionalAuth` with `authMiddleware` in three places:

| File | Location |
|---|---|
| `research.md` | R7 decision + rationale (lines ~176-183) |
| `tasks.md` | T010 (line 92) |
| `contracts/stats-api.md` | line 8 comment; confirm the 401 row is now reachable |

The frontend already fetches with `credentials: 'include'` (`tasks.md` T017), so nothing
on the web side needs to change.

Keep the rest of R7 — the reasoning about **not** attaching `mutationLimiter` is correct
(its `skip` predicate already exempts GET, so it would be inert).

**✅ Applied 2026-09-12** — seven edits across three files, two more than this plan
originally scoped:

- `research.md` R7 — decision changed to `authMiddleware`, rationale rewritten against
  FR-002 and Principle I, with a dated note recording that the original `optionalAuth`
  choice was wrong and why
- `contracts/stats-api.md` — mount comment; **401 row** reworded to name the actual
  trigger; **`selfEntry`** and **`isSelf`** rows rewritten (both previously described
  anonymous-caller behaviour that can no longer occur)
- `tasks.md` — **T010** now specifies `authMiddleware` with an inline note on why
  `optionalAuth` is wrong; **T009** no longer refers to unauthenticated callers;
  **T012** gained a 401 assertion, flagging that the existing test pattern mocks auth as
  an unconditional pass-through and so needs a mock that can reject

Verified: no `optionalAuth` or anonymous-caller language remains in any design artifact.

**Not done here (deliberate)**: T010's line still carries the wrong FR citations
(`FR-017`, `FR-018`). Those belong to the Stage 4 sweep and are listed in its table —
fixing them piecemeal is what would leave that table half-stale.

---

## Stage 3 — Missing coverage (F5, F7, F8, F9). ✅ DONE (2026-09-12).

| Finding | Gap | Action |
|---|---|---|
| **F5** ✅ | FR-025 and the new FR-026 have **zero** tasks | Stage 1 settled the policy; add the four tasks listed at the end of Stage 1 |
| **F7** ✅ | SC-002 (2s at 100k plays), SC-003 (1s period switch), SC-009 (no measurable playback slowdown) have no verification task | Add one Phase 7 perf-check task covering all three. Seed a large history to test SC-002 honestly |
| **F8** ✅ | SC-005, SC-007 covered only implicitly by T006's write path | Extend T013 with an assertion that a post-launch play lands with a stable identity and appears in leaderboard totals |
| **F9** ✅ | `data-model.md` §3 reads as if the service layer owns award SQL; `plan.md:115,118` and tasks put all SQL in `db.js` per Principle II | Reword data-model §3. Prose only, no behavior change |

**F10** needs no action — US1 shipping `awards: []` is already flagged inline in
`tasks.md` Phase 3 as deliberate.

**✅ Applied 2026-09-12.** Task count 49 → 54; all IDs and cross-references renumbered.

- **F5** — four Phase 2 tasks added for the retention change: **T006** (remove
  `clearHistory` from all four voice-leave sites, with the duplicated-block warning and an
  explicit "do not remove the event or the db method" note), **T007** (`clearAllEvents()`
  + symmetric `GuildDelete`), **T008**/**T009** (tests). Placed in Foundational because
  they edit `client.js`, `voice.js` and `handlers.js` — files the US4 emit-site tasks also
  touch — and because until T006 lands every figure on the page resets on each voice leave
- **F7** — **T050** added to Phase 7 covering SC-002, SC-003 and SC-009 against a seeded
  ~100k-play database, noting that all three pass trivially on a small dev dataset
- **F8** — **T017** extended with SC-005 and SC-007 assertions
- **F9** — `data-model.md` preamble now states that all SQL lives in `db.js` and that
  `statsQueries.js` never issues SQL
- **Stage 1b leftover** — award-winner wording generalised for tracks in both
  `data-model.md` (two places) and `contracts/stats-api.md`

Verified: 54 tasks, sequential T001–T054, format checks pass, and FR-025, FR-026, SC-002,
SC-003, SC-005, SC-007, SC-009 each now have ≥1 citing task.

---

## Stage 4 — Citation sweep (F4). ✅ DONE (2026-09-12).

> **Historical record — do not re-apply.** The numbering below is the FR-001..FR-028 that
> was final *when Stage 4 ran*. Stage 6 finding C1 has since inserted FR-020 and shifted
> FR-020..FR-028 to FR-021..FR-029. Current numbering is FR-001..FR-029 / SC-001..SC-012.

~20 FR/SC citations point at the wrong requirement. The prose is correct everywhere; only
the IDs are wrong. Cause: clarification sessions inserted FR-012 and FR-013 and renumbered
everything above them, after the downstream artifacts had been written.

**Re-verify the current numbering first** — Stage 1 will have changed it:

```bash
grep -o '^- \*\*FR-[0-9]\{3\}\*\*: .\{0,70\}' specs/001-dj-stats-page/spec.md
grep -o '^- \*\*SC-[0-9]\{3\}\*\*: .\{0,70\}' specs/001-dj-stats-page/spec.md
```

### Corrections against the FINAL numbering (FR-001..FR-028, 28 FRs / 12 SCs)

Stage 1 is complete, so this numbering is settled — the table below is directly usable.
Rows marked **†** shifted by one more when FR-026 was inserted; the rest are unchanged
from the original analysis.

**`tasks.md`**

| Task | Topic in the task text | Cited | Should be |
|---|---|---|---|
| T010 | period defaults to `all` | FR-017 | **FR-018** |
| T010 | never silently falls back | FR-018 | **FR-019** |
| T017 | empty state when leaderboard empty | FR-018 | **FR-019** |
| T017 | loading / error / retry | FR-026 | **FR-028** † |
| T020 | every award always returned | SC-009 | **SC-010** |
| T023 | responsive award grid | FR-025 | **FR-027** † |
| T027 | selector with exactly three options | FR-014 | **FR-016** |
| T028 | default `all` on open | FR-017 | **FR-018** |
| T028 | refetch without full page reload | FR-016 | **FR-017** |
| T028 | empty states naming the period | FR-018 | **FR-019** |
| T043 | natural end vs skip | FR-021 | **FR-022** |
| T044 | 400px width | FR-025 | **FR-027** † |
| T044 | no horizontal scrolling | SC-010 | **SC-011** |

**`contracts/stats-api.md`**

| Location | Topic | Cited | Should be |
|---|---|---|---|
| query-param table | `period` defaults to `all` | FR-017 | **FR-018** |
| after param table | 400, never a silent fallback | FR-018 | **FR-019** |
| field contract, `awards` row | every award always present | SC-009 | **SC-010** |
| "Other responses" | error state with retry | FR-026 | **FR-028** † |

**`data-model.md`**

| Location | Topic | Cited | Should be |
|---|---|---|---|
| §3 Period | 400 rather than silent fallback | FR-018 | **FR-019** |
| §2 `event_type` values | closed set of recorded actions | FR-019 | **FR-020** |
| §2 `event_type` values | natural completion distinguished | FR-021 | **FR-022** |
| §3 Award | every award always present | SC-009 | **SC-010** |

**`quickstart.md`**

| Heading | Cited | Should be |
|---|---|---|
| §5 Skip vs natural completion | FR-021 | **FR-022** |
| §7 API contract | FR-018 | **FR-019** |
| §10 The page itself | FR-025, SC-010 | **FR-027, FR-028** †; drop SC-010 (it belongs to §9) |

**`research.md`**

| Location | Topic | Cited | Should be |
|---|---|---|---|
| R6 (line ~160) | toggle changes both sections at once | FR-016 | **FR-017** |
| R9 (line ~218) | loading / error / retry | FR-026 | **FR-028** † |

### Verification script

Run after the sweep. Prints every citation next to the text of the requirement it points
at, so a mismatch is visible by eye:

```bash
cd specs/001-dj-stats-page && python3 - <<'PY'
import re, pathlib
spec = pathlib.Path("spec.md").read_text()
ref = dict(re.findall(r"^- \*\*((?:FR|SC)-\d{3})\*\*: (.+)$", spec, re.M))
for f in ["tasks.md","contracts/stats-api.md","data-model.md","quickstart.md","research.md","plan.md"]:
    txt = pathlib.Path(f).read_text()
    print(f"\n=== {f} ===")
    for i, line in enumerate(txt.split("\n"), 1):
        for c in dict.fromkeys(re.findall(r"(?:FR|SC)-\d{3}", line)):
            print(f"  L{i} {c}: {ref.get(c,'*** NO SUCH REQUIREMENT ***')[:88]}")
PY
```

**✅ Applied 2026-09-12 — 29 citations corrected across 5 files**, re-derived against the
final FR-001..FR-028 / T001..T054 numbering rather than the stale table above:

| File | Corrected |
|---|---|
| `tasks.md` | 14 (T014 ×2, T021 ×2, T024, T027, T031, T032 ×3, T047, T048 ×2, plus two phase-note/checkpoint references) |
| `contracts/stats-api.md` | 4 |
| `data-model.md` | 5 |
| `quickstart.md` | 4 |
| `research.md` | 2 |

Two were **not** in the original analysis table and only surfaced on re-derivation:

- `data-model.md` — the `actor_*` and `target_user_*` field rows both cited FR-020
  ("record each action") where they describe FR-021 ("capture the member who performed
  it… and the member who originally queued it")
- `quickstart.md` §10 — "Reload twice: identical rankings and winners" cited **SC-011**
  (400px readability) instead of **SC-012** (determinism)

**Beyond the sweep**: 8 traceability citations were *added* where a task implemented a
requirement in prose without naming it (FR-001, FR-003, FR-007, FR-010, FR-011 ×2,
FR-012, FR-020, FR-021, SC-001). These were never wrong — just invisible to the coverage
check.

**Verified**: zero dangling citations; **FR coverage 28/28, SC coverage 12/12**; 54 tasks
sequential T001–T054.

---

## Stage 5 — Verify

```bash
cd /home/claude/Documents/SquareMusica
# artifacts only — no production code has changed yet
git status specs/001-dj-stats-page/
```

Then re-run `/speckit-analyze`. Expected: **0 CRITICAL**, coverage ≥ 95% for both FRs and
SCs, constitution alignment PASS on all five principles.

Only then run `/speckit-implement`.

---

## Quick reference — findings and status

| ID | Sev | Summary | Stage |
|---|---|---|---|
| F1 | CRITICAL | History wiped on every voice-leave; spec's retention assumption is false. **Decided: stop wiping on voice-leave; keep the `GuildDelete` wipe** | 1 |
| F2 | CRITICAL | `history` and `events` cleared asymmetrically. **Not resolved by the F1 decision** — the surviving `GuildDelete` path must clear both | 1 |
| F3 | CRITICAL | `optionalAuth` doesn't gate; violates FR-002 + Principle I. **✅ FIXED** | 2 |
| F4 | HIGH | ~20 FR/SC citations off by one or two. **✅ FIXED** — 29 corrected, 2 more found on re-derivation | 4 |
| F5 | HIGH ✅ | FR-025 (retention) has zero tasks | 3 |
| F6 | MEDIUM ✅ | FR-010/FR-013 assume every award winner is a member | 1b |
| F7 | MEDIUM ✅ | SC-002, SC-003, SC-009 unverified | 3 |
| F8 | MEDIUM ✅ | SC-005, SC-007 covered only implicitly | 3 |
| F9 | LOW ✅ | data-model §3 wording drifts from Principle II ownership | 3 |
| F10 | LOW | US1 ships `awards: []` — already flagged as deliberate | none |


---

## Stage 6 — Independent audit findings (2026-09-12). ✅ DONE (2026-09-12).

An independent agent audited all artifacts against the live codebase, forming findings
before reading this file. **Verdict: not ready for implementation.** I re-verified the
five highest-impact claims myself; all five were correct.

### CRITICAL

**A1 — "This Week" SQL is wrong every Monday.** `research.md` R4 specifies
`date('now','localtime','weekday 1','-7 days')` and claims it "is a no-op shift when today
is already Monday". It is not: `weekday 1` is a no-op on a Monday, and the `-7 days` then
still applies, so the window starts a week early. Verified on SQLite 3.46.1:

| Run on | Current spec | Correct |
|---|---|---|
| Mon 2026-09-07 | **2026-08-31** ✗ | 2026-09-07 |
| Tue–Sun | 2026-09-07 ✓ | 2026-09-07 |

**Fix**: `date('now','localtime','-6 days','weekday 1')` — verified correct on all seven
days. Update R4's table **and** its prose, plus T028. Note T030 already demands a test
that "running on a Monday does not shift the window back a week", which would fail against
the current spec — the design contradicts itself.

**A2 — quickstart still tests the abandoned anonymous-access behavior.** Steps 7 and 11
(`quickstart.md:98-100,153-154`) call `/api/stats` with bare `curl`, no cookie or token,
expecting 200 bodies. The route is now `authMiddleware`, which 401s without a token; step
11 runs under `NODE_ENV=production`, where `developerMode` is ignored. **The Stage 2 fix
did not ripple to quickstart.md** — that file was not in Stage 2's scope list.
**Fix**: authenticate both steps; add an explicit unauthenticated→401 check.

### HIGH

**B1 — Principle III violation; `plan.md` records PASS.** `musicManager.stop()` calls
`this.queue.clear()` (`core/musicManager.js:215`). HTTP `POST /api/player/stop`
(`routes/playback.js:53`) and realtime `'stop'` (`handlers.js:214`) both call it and emit
nothing, while Discord `handleStop` emits `clear_queue` (T041). The same user-visible
outcome is recorded on one surface only — exactly the silent gap the plan's own risk note
warns about, and it makes SC-006's "18 of 18" a false assurance.
**Fix**: decide whether stop records `clear_queue` everywhere or nowhere; then update the
contract matrix, T038/T040/T041, and `plan.md`'s Principle III verdict.

**B2 — three different "clear" semantics share one event type.** HTTP `DELETE /api/queue`
→ `queue.clear()` (everything); realtime `'clear'` → `clearUpcoming()` (upcoming only);
Discord `handleClear` → keeps current track. The contract asserts parity these do not have.
**Fix**: record the variant in `metadata`, and name this divergence in the plan's
Principle III note alongside the Discord bypass.

**B3 — Discord emits `clear_queue` from two sites; the contract lists one.** T041
(`handleStop`) and T042 (`handleClear`) both emit; the contract maps only `handleStop`.
Discord contributes two clear sources where others contribute one.

**B4 — `idx_history_requested_by_id` is never created on a fresh install.** T004 puts it
inside `migrate()`, which returns early when `history` does not exist (`db.js:37-39`) —
precisely the fresh-install case. T003 adds the columns to `schema.sql` but not the index,
whose index block (`schema.sql:42-46`) has no entry for it. Fresh deployments run SC-002's
100k-play target unindexed.
**Fix**: add it to `schema.sql` in T003; keep it in `migrate()` for existing DBs.

### MEDIUM

- **C1** — No requirement mandates 400-on-invalid-period. The contract, `data-model.md:155`
  and T014 all cite **FR-019**, which governs *empty results*, not input validation. Passed
  the Stage 4 sweep because the citation points at a real FR, just the wrong one. Add an FR.
- **C2** — `plan.md`'s structure tree and Scale/Scope are stale: it says "3 backend files
  added, 6 modified"; tasks now add 4 and modify 13, and the tree omits `src/index.js`,
  `discord/client.js`, `discord/commands/voice.js`, `web/src/components/stats/index.jsx`
  and 4 test files. **Stage 3 added T006–T009/T050 without updating plan.md.**
- **C3** — `plan.md` lists `core/musicManager.js # MODIFY`, but **no task touches it** and
  it is unnecessary: `addToHistory` already receives the whole track object. Delete the line.
- **C4** — Sidebar integration is specified against symbols that do not exist. The constant
  is **`NAV_ITEMS`** (`Sidebar.jsx:24`), not `navItems`; its three icons are **inline SVG**
  at 15×15 with `fill="none" stroke="currentColor"`, whereas `icons/index.jsx` uses
  `fill="currentColor"` and no stroke, and Sidebar imports nothing from it. Following
  T018/T019 yields a mismatched icon and an unmentioned import.
- **C5** — FR-012 names one dead zone (09:00–22:00) but the award windows create a second,
  **04:00–05:00**, that no requirement mentions.

### LOW

D1 `research.md`/T041 cite `commands/playback.js:161-162` for `p.stop()`/`q.clear()`;
actual lines are **163-164**. · D2 `research.md` contradicts itself on CenterPanel switch
lines (8,50,63,90 vs 50,62,89 — the latter is correct). · D3 "twelve call sites" understates
the ~20 emits the contract matrix implies. · D4 `data-model.md:136` writes invalid SQL
shorthand (`>= '22' OR < '04'`) for the one expression the docs insist must be exact. ·
D5 `checklists/requirements.md` still records "FR 24→25, SC 9→11"; actual is 28 and 12. ·
D6 T049 is the only task with no file path. · D7 "DJ Skip" is grouped by `target_user_id`
but reads as the actor — easy to implement backwards.

### Suggested order for Stage 6

1. **A1** — one-modifier fix, but it is a wrong answer already written into the design
2. **B1/B2/B3** — one scoping decision on stop-vs-clear, then contract + task edits
3. **A2, B4** — surgical
4. **C1–C5**, then **D1–D7**
5. Re-run the audit

---

### ✅ Applied 2026-09-12 — all 18 findings

Documentation only. No file outside `specs/001-dj-stats-page/` was created or modified;
no production code was written. **FR count 28 → 29.**

| ID | What changed |
|---|---|
| **A1** | `research.md` R4: period table now `date('now','localtime','-6 days','weekday 1')`, and the prose beneath it rewritten — it previously explained the *wrong* mechanism ("a no-op shift when today is already Monday"), and now explains that the `weekday 1` no-op on Mondays is exactly what makes `'weekday 1','-7 days'` start the window a week early, plus why `-6 days` first is correct on all seven days, with a runnable check. `tasks.md` T028 given the explicit expression, the modifier order called out as load-bearing, and a pointer to T030 which tests it. `grep -rn "weekday"` shows no remaining occurrence of the old expression in any artifact. |
| **A2** | `quickstart.md` §7 rewritten: obtains a live session token from the `sessions` table, sends it as `Authorization: Bearer`, notes the cookie-jar alternative, and **adds an explicit unauthenticated → 401 check** plus a warning that `developerMode` makes that check vacuous. §11 (Docker) likewise: 401 check first, then an authenticated call using a token read out of the container's own database, with a note that `NODE_ENV=production` disables the `developerMode` bypass entirely. Existing assertions (period echo, 10-entry cap, 8 awards, 400-on-bogus) all kept. |
| **B1 + B3** | **Decision applied: `stop` is a tracked action on no surface.** T041 no longer emits `clear_queue` from `handleStop` and now covers only `handlePause`/`handleResume`/`handleSkip`, with the reasoning inline. T042 states that `handleClear` is the sole Discord source of `clear_queue`. The contract's emit matrix Discord cell for `clear_queue` now reads `commands/queue.js` `handleClear`. An explicit "stop is deliberately not recorded" note was added to **both** `contracts/stats-api.md` and `plan.md`'s Principle III section, naming the side-effect clear and why emitting on it would be the parity violation rather than a fix. T040 also told not to emit from the realtime `'stop'` case. |
| **B2** | `contracts/stats-api.md` gains a table of the three clear semantics and requires `metadata: {"variant":"all"\|"upcoming"\|"all_but_current"}` on every `clear_queue` emit, with the reasoning. Same requirement added to `data-model.md`'s `metadata` row. `plan.md`'s Principle III note now lists **two** pre-existing divergences (the Discord `musicManager` bypass **and** the three clear semantics) instead of claiming the bypass is the only one, and a third Complexity Tracking row records the clear divergence as a follow-up. T039/T040/T042 each given their variant value so the contract is implementable. |
| **B4** | T003 now adds `CREATE INDEX IF NOT EXISTS idx_history_requested_by_id ON history(requested_by_id);` to `schema.sql`'s index block, with the `db.js:37-39` early-return evidence. `data-model.md` §1 shows the index in both `schema.sql` and `migrate()` and explains why the duplication is required and safe. |
| **C1** | New **FR-020** added to spec.md's Time Period section: an unrecognised period MUST be rejected with an error, never defaulted or silently substituted. **FR-020..FR-028 renumbered to FR-021..FR-029** (definitions rewritten descending, then the new FR inserted); 47 citations shifted across 7 artifacts, including spec.md's own internal cross-references (Assumptions' retention/no-manual-clear notes, the "Web surface only" assumption). The 400-behaviour citations were then re-pointed from FR-019 to FR-020 in `contracts/stats-api.md`, `data-model.md` §3, `tasks.md` T014 — **and in `quickstart.md` §7, a fourth site not named in the audit** (its heading also gained FR-002 for the new 401 check). FR-019 citations that genuinely concern empty states (T021, T032) were left alone. |
| **C2 + C3** | `plan.md`'s source tree regenerated by extracting every backticked file path from the 54 task descriptions programmatically, then classifying touched-vs-merely-referenced by hand. It now carries per-file task IDs and includes the previously-omitted `src/index.js`, `discord/client.js`, `discord/commands/voice.js` and `web/src/components/stats/index.jsx`, and all 7 test files. The `core/musicManager.js # MODIFY` line is **deleted** — no task touches it and `addToHistory` already receives the whole track object. Scale/Scope corrected. |
| **C4** | Verified against the live files. T019 now targets **`NAV_ITEMS`** (`Sidebar.jsx:24`), not `navItems`, and notes `Dashboard.jsx` needs no change. T018's original purpose (a `Trophy` in `icons/index.jsx`) was wrong and is **dropped**; the ID is kept and repurposed to writing the nav icon as an **inline SVG literal** matching the three existing ones (15×15, `fill="none"`, `stroke="currentColor"`, `strokeWidth="2"`), with an explicit "do not import from `components/icons/`" instruction. T018 lost its `[P]` (it now shares `Sidebar.jsx` with T019) and the Parallel-opportunities list was corrected. `research.md` R9 rewritten to match. |
| **C5** | FR-012 now names **both** dead zones — 04:00–05:00 as well as 09:00–22:00 — and states that a play landing in either is deliberate, not a defect. |
| **D1** | `commands/playback.js:161-162` → **163-164** in `research.md` R1 and in T041 (via its new `handleStop` note). Verified against the file. |
| **D2** | `research.md` R9's contradictory "CenterPanel.jsx:8,50,63,90" replaced; both mentions now say switches at lines **50, 62, 89**, matching the file and T020. |
| **D3** | "twelve call sites" replaced in `plan.md` (Summary and Complexity Tracking) and `research.md` R1 with **19 emit sites across 6 files** — the 18 action/surface combinations plus one `track_complete`. |
| **D4** | Night Owl and Early Bird predicates written out in full (expression repeated on both sides of `OR`/`AND`) in `data-model.md` §3, **and in T023**, which carried the same invalid shorthand. A predicate note records why these must be copied exactly. |
| **D5** | `checklists/requirements.md` Notes gained an "Iteration 3" entry recording the **final counts: 29 FRs, 12 SCs**, and which requirements were added after iteration 2. Iteration 2's figures were marked "at the time" rather than rewritten, since they are an accurate record of that iteration. **All 16 checkbox lines and their states are untouched.** |
| **D6** | T049 now names `src/services/statsQueries.js` and `src/transports/http/routes/stats.js`, and says what to compare across the three periods. |
| **D7** | Direction note added to `data-model.md` §3 (winner is the *victim*, grouped by `target_user_id`; the other three event awards group by `actor_id`) with a concrete test assertion, and to spec.md **FR-011**. The award is **not** renamed. |

### Verification run

- **Week SQL**: `date(d,'-6 days','weekday 1')` returns `2026-09-07` for all of Mon 2026-09-07 through Sun 2026-09-13. The old expression returns `2026-08-31` on the Monday — the bug, reproduced and then fixed.
- **Citations**: zero dangling; every `FR-`/`SC-` reference in all six downstream artifacts reviewed against the requirement text it points at.
- **Numbering**: FR-001..FR-029 (29) and SC-001..SC-012 (12), both sequential, no gaps or duplicates.
- **Tasks**: 54, T001..T054 sequential, no duplicates, zero format violations; story labels present on every task in Phases 3–6 and absent from Phases 1, 2 and 7.
- **Coverage**: 41/41 — every FR and SC is referenced by at least one task, the new FR-020 included (T014).
- **Scope**: `git status --short` shows no change outside `specs/001-dj-stats-page/`.

### Deliberately not done

- **T005** was left alone. It asserts the `events` table and its three indexes exist after migration, but not `idx_history_requested_by_id` — the index B4 is about. Adding that assertion would be the natural regression guard for B4 and is a reasonable follow-up; it was outside the finding's stated scope.
- The audit put the backend file delta at "4 added and 13 modified". Mechanical extraction from the task text yields **4 added and 12 modified**; the tree lists all 12 by name with their task IDs. Similarly the audit said "4 of the 8 test files" were omitted; the tasks name **7** test files (6 new, 1 modified). The plan now carries the derived numbers.

### What the audit confirmed as correct

Worth recording so it is not re-litigated: `optionalAuth` genuinely never rejects; the
retention analysis is exact (**four** voice-leave sites plus `GuildDelete`, no fifth path);
`addToHistory` has exactly one caller; tracks already carry `requestedById`/`requestedByAvatar`
on all three transports; `CenterPanel` has exactly three switches; the UTC/localtime
reasoning is sound apart from A1; R1's Discord-bypass premise holds; Stage 4's sweep is
honest (zero dangling citations, FR 28/28, SC 12/12); task format is clean across all 54;
no placeholders; no duplicated requirements. Constitution I, II, IV and V all PASS.

---

## Stage 7 — `/speckit-analyze` pass (2026-09-12). ✅ DONE (2026-09-12).

Stage 5 called for re-running `/speckit-analyze` before implementation. It was run. The
headline gate passed — **0 CRITICAL, FR 29/29, SC 12/12, constitution PASS ×5** — and it
surfaced 12 further findings, all applied. No requirement was added, renumbered or removed,
so no citation sweep was needed this time.

| ID | Sev | Finding | Fix |
|---|---|---|---|
| I1 | **HIGH** | T006 claimed `musicManager.clearHistory()` is "still used by the guild-removal path". **False** — `Events.GuildDelete` (`client.js:33-38`) calls `db.clearAllHistory()` directly and emits `historyCleared` itself. Its only callers were the four voice-leave sites T006 deletes, so T006 as written left a dead method in `core/` | T006 now deletes `clearHistory()` and fixes the stale comment at `voiceManager.js:91`. Recorded as closing the second clause of ADR-001 follow-up item 5 rather than adding to it. `plan.md` corrected: `core/musicManager.js` **is** touched (its tree previously asserted the opposite), backend modified count 12 → 14 |
| C1 | **HIGH** | The DJ Skip direction — won by the **victim**, flagged four times across FR-011 and data-model §3 as "easy to implement backwards, yields a plausible but wrong winner" — had **zero** verification in tasks.md or quickstart.md | New **T055** asserts it explicitly (A skips B×3 ⇒ **B** wins, A wins nothing), plus actor-direction and 2-vs-3 threshold for the other three `events` awards |
| G1 | MED | T043/T044 (four event-derived award queries + registry entries) had no test task at all | Covered by T055 |
| U1 | MED | Between the US1 ship and T028, `?period=week` passes T014's validation then hits a `resolvePeriod` that only knows `all` — undefined behaviour, and the plausible implementation is a silent all-time fallback under a "This Week" label (exactly what FR-019/FR-020 forbid) | T013 now exports `SUPPORTED_PERIODS` (`['all']`, widened by T028); T014 validates against it and its 400 message enumerates it; T016 tests the interim rejection; contract documents both |
| U2 | MED | T013 sets `leaderboardTruncated` "when more than 10 DJs qualified", but T011 returns at most `limit` rows — an implementer passing `limit: 10` cannot compute the flag | T011 now returns `LIMIT limit + 1`; T013 sets the flag from `rows.length > 10` **before** slicing to 10 |
| U3 | MED | Contract implied `pause`/`resume` carry a non-null `track`, but T038/T040/T041 instructed capturing one only for `skip`. T046's "identical payload shape" assertion **passes when all three surfaces uniformly omit it** — silent by construction | Per-type nullability table added to the contract and to data-model §2; T038/T040/T041 now state pause/resume read `musicManager.getCurrentTrack()` (already imported in the Discord file); T046 asserts the table, not surface-agreement |
| G2 | MED | `generatedAt` (contract 200 example) and `valueLabel` (contract + data-model Award table) had no implementing task | `generatedAt` added to T013, `valueLabel` to T024; both given field-contract rows |
| G3 | MED | Spec edge case "if that avatar can no longer be retrieved, a default avatar is shown" had no task | Default-avatar fallback added to T022 |
| A1 | LOW | T025 probed only the four live hour edges; nothing asserted FR-012's two deliberate dead zones (04:00–05:00, 09:00–22:00), so a predicate that accidentally tiles the whole day would pass | T025 extended with 04:59/05:00 and a 12:00 "counts toward neither" case |
| I2 | LOW | `plan.md` said "23 files touched" immediately after enumerating counts summing to 30 — the total silently dropped the seven test files it had just listed | Now states **25 production / 32 including tests**, reflecting I1's two extra files |
| I3 | LOW | `plan.md` Phase 2 still unchecked though tasks.md holds 55 tasks; `spec.md` still **Status: Draft** after clarify, plan, tasks and two remediation rounds | Phase 2 ticked with an analyze line; spec status → **Planned** |
| D1 | LOW | The three-way `clear_queue` variant divergence is restated in six places | **No action.** All six agree and each restatement is load-bearing where it sits. Noted for maintenance only |

### Verification of this stage

```bash
cd /home/claude/Documents/SquareMusica/specs/001-dj-stats-page
grep -c '^- \[ \] T' tasks.md                      # 55
grep -n 'clearHistory' tasks.md                    # T006 must say DELETE, not preserve
grep -n 'T055' tasks.md plan.md                    # present in both
grep -n 'SUPPORTED_PERIODS' tasks.md contracts/stats-api.md
grep -n 'generatedAt\|valueLabel' tasks.md         # both now have tasks
grep -rn 'musicManager.clearHistory' ../../src/    # after T006: definition and callers all gone
```

### What this pass confirmed as correct

Recorded so it is not re-litigated. Verified against the source, not just the documents:
`migrate()` does run before `schema.sql` and returns early on a fresh install
(`db.js:24-39`), so the deliberate double-declaration of `idx_history_requested_by_id` in
T003+T004 is both correct and necessary; `mutationLimiter`'s `skip` predicate does exempt
GET (`http/index.js:50`), so T015's "do not attach it" holds; `musicManager` is already
imported in `discord/commands/playback.js` (line 3), so U3's fix is implementable on every
surface; all eight file paths the tasks cite as existing patterns exist on disk; the
19-emit-site arithmetic (18 combinations + one `track_complete` across six files) is
internally consistent; FR and SC citations remain free of dangling references.
