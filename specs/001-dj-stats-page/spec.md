# Feature Specification: DJ Stats Page

**Feature Branch**: `001-dj-stats-page`

**Created**: 2026-09-12

**Status**: Implemented — phases 1–7 plus the 2026-09-24 delta (FR-005a loop-replay exclusion, FR-030 required `TZ`), CI gates green. Quickstart steps 4, 5, 8a and 10 still need a manual run against a live Discord deployment.

**Input**: User description: "The goal is to add a DJ Stats page to the web dashboard featuring a DJ Leaderboard, fun awards/superlatives, and a time-period toggle (All Time / This Week / This Month). We'll also add full event tracking (skips, pauses, removes, shuffles, clears) from day one so award data starts accumulating immediately."

## Clarifications

### Session 2026-09-12

- Q: Where should a DJ's displayed name and avatar come from — details captured when they queued a track, or a live Discord profile lookup? → A: Snapshot name and avatar on every play; display the most recent snapshot for each DJ.
- Q: What hours count as "late night" for Night Owl and "early morning" for Early Bird? → A: Night Owl 22:00–04:00, Early Bird 05:00–09:00.
- Q: If writing a stats record fails, should it be dropped and logged, or retried until it lands? → A: Drop the record, log the failure, never block the action (best-effort).
- Q: How many DJs should the leaderboard show before it stops adding rows? → A: Top 10, with the signed-in member's row pinned if they fall outside it.
- Q: Should a DJ need a minimum amount of activity to win an award, or can a single play take it? → A: Require at least 3 qualifying plays or actions to win an award.
- Q: When the bot is removed from the guild, should stats be wiped with the play history or survive a re-add? → A: Clear both `history` and `events` — bot removed means data removed.
- Q: Does Most Played Song, whose winner is a track rather than a member, still need 3 plays to qualify? → A: Yes — generalise FR-010/FR-013 to "winner"; the 3-item minimum applies to tracks too.
- Q: With the voice-leave wipe gone, should members get a manual way to clear history from the dashboard? → A: Out of scope — no manual clear; recorded as a possible follow-up.

### Session 2026-09-24

- Q: Which timezone should decide the award hours, "a single day" for The Hog, and where This Week and This Month start? → A: A single timezone set explicitly in configuration (e.g. `TZ=Europe/Copenhagen`, with timezone data available in the runtime image), validated at startup; not whatever the host happens to default to.
- Q: When loop mode (track or whole queue) replays a track, should each replay count as a new play in the stats? → A: Record every replay in play history but mark it as a loop replay; stats count only the first play, and loop replays are excluded from the leaderboard and every award.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - See who the top DJs are (Priority: P1)

A member opens the dashboard, selects "DJ Stats" from the navigation, and sees a ranked
list of everyone who has queued music. Each entry shows the member's name and avatar,
their rank, how many tracks they queued, how much total listening time they contributed,
and how varied their taste has been. They can immediately tell who keeps the music going
and where they place themselves.

**Why this priority**: This is the core of the request and the foundation every other
story builds on. It is also the story that starts the clock: stats count only activity
recorded from launch onward, so the sooner the leaderboard and its underlying attribution
ship, the sooner the page has anything to show.

**Independent Test**: Queue and play tracks as two or more known members, then open the
DJ Stats page and confirm a ranked list appears with counts and totals matching what was
played. Before any tracks are played, confirm the page shows an empty state rather than an
error.

**Acceptance Scenarios**:

1. **Given** members have queued tracks since launch, **When** a member opens the DJ Stats page, **Then** a leaderboard appears listing each contributing member in descending order of tracks queued, with rank, name, avatar, track count, total listening time, and unique-track count.
2. **Given** two members have queued the same number of tracks, **When** the leaderboard is displayed, **Then** both appear in a stable, predictable order that does not change between page loads.
3. **Given** no music has been queued since launch, **When** a member opens the DJ Stats page, **Then** a friendly empty-state message explains that stats will appear once music starts playing, rather than showing an error or a blank panel.
4. **Given** a member is signed in, **When** the DJ Stats page loads, **Then** the page identifies which leaderboard row is that member's own so they can find themselves at a glance.
5. **Given** more than 10 members have queued tracks and the signed-in member ranks outside the top 10, **When** the leaderboard is displayed, **Then** the top 10 are listed, the list is marked as truncated, and the signed-in member's own row appears in addition, showing their true rank and visually separated from the top 10.
6. **Given** a member changes their Discord display name, **When** the leaderboard is displayed, **Then** all of their activity — before and after the rename — remains grouped under a single entry, labelled with the name captured on their most recent play.

---

### User Story 2 - Earn fun awards and superlatives (Priority: P2)

A member scrolls past the leaderboard to an awards section showing playful superlatives —
"Night Owl" for the member who queues the most late-night music, "The Hog" for whoever
queued the most tracks in a single day, "Most Played Song" for the track the group cannot
stop replaying, and similar. Each award shows its name, a one-line explanation of how it
is earned, the winning member, and the number behind the win.

**Why this priority**: This is what turns a statistics page into something people share
and argue about. It layers on top of the leaderboard's attribution and becomes
progressively more interesting as activity accrues.

**Independent Test**: Play tracks as known members across varied times of day, then open
the DJ Stats page and confirm each award shows a winner and a value consistent with what
was played. Confirm that an award with no qualifying activity shows a "no winner yet"
state rather than disappearing.

**Acceptance Scenarios**:

1. **Given** members have queued tracks at varying times of day, **When** the awards section is displayed, **Then** each award shows an award name, a plain-language description of how it is earned, the winning member, and the winning value.
2. **Given** an award has no qualifying data yet, **When** the awards section is displayed, **Then** that award still appears with a clear "no winner yet" state rather than being hidden or showing a blank winner.
3. **Given** several members tie for an award, **When** the award is displayed, **Then** a single winner is chosen by a stated, deterministic tie-break so the result is consistent across loads.
4. **Given** the highest qualifying count for an award in the selected period is 2, **When** the awards section is displayed, **Then** that award shows its "no winner yet" state rather than crowning the member sitting at 2.
5. **Given** the awards section is viewed on a narrow phone-width screen, **When** the page renders, **Then** award cards reflow into fewer columns and remain fully readable without horizontal scrolling.

---

### User Story 3 - Compare stats across time periods (Priority: P3)

A member wants to know who has been carrying the music *lately*, not just who has queued
the most since the page went live. They use a toggle at the top of the page to switch
between "All Time", "This Month", and "This Week". Both the leaderboard and the awards
recompute for the selected window, so a member who joined recently can win something this
week even if a more prolific member dominates all time.

**Why this priority**: It makes the page stay interesting after the all-time rankings
settle, and it gives newer or less prolific members a reachable win. It depends on the
leaderboard and awards existing first, and it has little to distinguish until several
weeks of activity have accrued.

**Independent Test**: With recorded activity spanning more than a month, switch between
the three periods and confirm the leaderboard totals and award winners change
appropriately, and that "This Week" totals are a subset of "This Month" totals, which are
a subset of "All Time".

**Acceptance Scenarios**:

1. **Given** the DJ Stats page is open, **When** a member selects a different time period, **Then** both the leaderboard and the awards update to reflect only activity within that period, and the selected period is visibly indicated.
2. **Given** a member selects "This Week", **When** no activity occurred in the current week, **Then** the leaderboard and awards show empty states naming the selected period, rather than silently falling back to all-time results.
3. **Given** the page is opened fresh, **When** no period has been chosen, **Then** "All Time" is selected by default.
4. **Given** a member has switched to "This Month", **When** they navigate away to another dashboard page and return to DJ Stats, **Then** the page opens on the default period and no stale data from the previous selection is displayed.
5. **Given** the feature has been live for less than a month, **When** a member selects "All Time", **Then** the results reflect only the period since launch, and the page does not imply coverage of activity older than that.

---

### User Story 4 - Behavior-based awards from tracked actions (Priority: P4)

Beyond what members queue, the page also celebrates how they behave: who skips other
people's songs the most, who bails on their own picks, who yanks tracks out of the queue,
who cannot stop shuffling. These awards are powered by a record of control actions —
skips, pauses, resumes, removes, shuffles, and queue clears — captured as they happen.

**Why this priority**: It is the most involved slice, touching every surface that can
change playback, and it is the least self-contained — its awards are meaningless until a
body of actions exists. **Its recording half must nonetheless ship in the initial
release.** Like play attribution in Story 1, this data can only be collected going
forward, so any delay permanently loses the window it would have covered.

**Independent Test**: Perform each tracked action (skip, pause, resume, remove, shuffle,
clear) from the dashboard and, separately, from Discord commands. Confirm each action is
recorded with the acting member, the affected track, and the track's original requester,
and that the corresponding awards then show a winner.

**Acceptance Scenarios**:

1. **Given** a member skips a track that another member queued, **When** the action completes, **Then** the system records the skip along with who performed it, which track was affected, and who originally queued that track.
2. **Given** a member performs a pause, resume, remove, shuffle, or queue clear, **When** the action completes, **Then** the system records that action with the acting member and any affected track.
3. **Given** the same action is available from both the web dashboard and a Discord command, **When** it is performed from either surface, **Then** it is recorded identically, with no difference in what is captured.
4. **Given** no control actions have been recorded yet, **When** the awards section is displayed, **Then** the behavior-based awards appear in a "no winner yet" state and the rest of the page is unaffected.
5. **Given** a track finishes on its own rather than being skipped, **When** playback advances, **Then** the completion is recorded as a natural end and is not counted as a skip.

---

### Edge Cases

- **Recording failure must never break playback.** If capturing a play or an action fails for any reason, the underlying operation (play, skip, pause, remove, shuffle, clear) MUST still succeed and the member MUST see no error. The record is dropped and the failure logged — never retried, never queued. Stats are strictly observational, and a lost record shifts a superlative at most, so the trade is accepted deliberately.
- **Day one is empty by design.** Because stats count only activity recorded from launch onward, every section of the page starts with no winners. This is the expected state, not a defect, and the page must communicate it as such rather than appearing broken.
- **Pre-launch music is not counted.** Tracks played before this feature shipped never appear in any figure on the page. The page must not imply that its "All Time" window reaches further back than launch.
- **A member changes their Discord display name.** Attribution follows their stable identity, so their activity stays grouped under one entry; the page labels it with the name captured on their most recent play.
- **A member leaves the guild.** Their recorded contributions remain in the rankings, shown under the name and avatar captured on their most recent play; if that avatar can no longer be retrieved, a default avatar is shown in its place.
- **Tracks with unknown or missing duration.** These still count toward track counts but contribute zero to listening-time totals, and the page does not report a misleadingly precise total.
- **Very long member names or track titles.** These are truncated within their card or row rather than breaking the layout or forcing horizontal scrolling.
- **A single member is the only contributor.** The leaderboard renders a one-row list and awards resolve to that member without implying competition that does not exist.
- **Loop mode left on.** A member who loops one track, or the whole queue, for hours gains nothing on the leaderboard or in any award from the repeats: only the first play counts (FR-005a). The repeats still appear on the History page.
- **The same track is queued repeatedly by one member.** It counts once toward their unique-track/variety measure and once per play toward their total track count.
- **Daylight-saving changeover.** On the night clocks change, hour windows and day/week/month boundaries follow the configured timezone's wall clock (FR-030); a play is never counted in two windows or two days, and none is lost.
- **Period boundary crossing while the page is open.** If the week or month rolls over while a member has the page open, results may reflect the period in effect when the data was fetched; re-opening or re-selecting the period returns current results.
- **Play history now grows without bound.** Nothing prunes it, so the History page and the stats queries must stay usable as it grows. The History page already pages through results rather than loading everything, and the stats figures are aggregates rather than row listings, so both scale with the indexes rather than the row count.
- **A member requests stats while a very large body of activity exists.** The page still loads within the stated performance target, and the leaderboard renders at most 10 rows plus the signed-in member's pinned row, never an unbounded list.

## Requirements *(mandatory)*

### Functional Requirements

#### Navigation & Access

- **FR-001**: The dashboard MUST offer a "DJ Stats" destination in its primary navigation, reachable in one click from any other dashboard page.
- **FR-002**: The DJ Stats page MUST be visible only to members who are already authorized to use the dashboard, applying the same access rules as the rest of the dashboard with no additional or relaxed restrictions.

#### Leaderboard

- **FR-003**: The system MUST present a leaderboard ranking members by the number of tracks they queued within the selected time period, in descending order.
- **FR-004**: The system MUST record, against every play from this feature's launch onward, a stable identity for the member who queued the track — one that survives a change of display name — together with a snapshot of that member's display name and avatar as they were at that moment.
- **FR-005**: The system MUST attribute plays to members by that stable identity, and MUST exclude plays recorded before this feature's launch, which carry no such identity. All figures on the page therefore describe activity from launch onward, and the page MUST NOT present them as covering a longer span.
- **FR-005a**: The system MUST mark each play record that loop mode started automatically — a track-loop repeat, or a queue-loop wrap back to an already-played track — as a loop replay. Loop replays MUST still be written to play history, so the History page is unchanged, but MUST be excluded from every leaderboard figure (tracks queued, listening time, distinct tracks) and from every award. A replay the member starts manually (going back to the previous track, or queuing the track again) is an ordinary play and counts.
- **FR-006**: Each leaderboard entry MUST show the member's rank, display name, avatar, tracks queued, total listening time contributed, and count of distinct tracks queued. The display name and avatar MUST be taken from the member's most recent recorded snapshot, never from a live profile lookup, so that the page renders without contacting Discord and continues to work for members who have left the guild or who have never signed into the dashboard.
- **FR-007**: The leaderboard MUST resolve ties by a deterministic rule so that repeated views of unchanged data produce an identical ordering.
- **FR-008**: The leaderboard MUST visually distinguish the signed-in member's own row.
- **FR-009**: The leaderboard MUST display at most the top 10 DJs for the selected period, and MUST make clear when the list has been truncated. When the signed-in member does not place in that top 10, their own row MUST additionally be shown — carrying their true rank, visually separated from the top 10 — so that every member can always locate themselves.

#### Awards

- **FR-010**: The system MUST present a set of named awards, each with an award name, a plain-language description of how it is earned, the winner, and the value that won it. A winner is usually a member, but MAY be a track where the award is about the music rather than the person — "Most Played Song" is the one such award in FR-011.
- **FR-011**: The awards set MUST include at least the following, computed over the selected time period: most-replayed track; a late-night listening award ("Night Owl", counting plays from 22:00 up to 04:00); an early-morning listening award ("Early Bird", counting plays from 05:00 up to 09:00); a most-tracks-in-a-single-day award; a most-skipped-by-others award; a most-self-skipped award; a most-queue-removals award; and a most-shuffles award. **The most-skipped-by-others award is won by the victim, not the skipper** — its winner is the member whose queued tracks other people skipped most often, which is why it is described as "most skipped *by others*". Its working name, "DJ Skip", reads like the name of the person doing the skipping, and the other three action-derived awards (self-skip, removals, shuffles) *are* won by the member who performed the action. That asymmetry is easy to implement backwards and yields a plausible-looking but wrong winner.
- **FR-012**: Hour-bounded awards MUST evaluate their boundaries in the configured stats timezone (FR-030), treating the start hour as inclusive and the end hour as exclusive, so that every play falls in at most one of the two windows. The two windows do not tile the day: with Night Owl running 22:00–04:00 and Early Bird 05:00–09:00, there are **two** gaps where a play counts toward neither award — 04:00–05:00 and 09:00–22:00. Both are deliberate, and a play landing in either is not a defect.
- **FR-013**: An award MUST NOT be given to any candidate — member or track — whose qualifying count for the selected period is below 3. Where no candidate reaches that floor, the award MUST fall back to its "no winner yet" state rather than crowning the highest count below the floor. A track played twice is therefore not "most played".
- **FR-014**: An award with no winner for the selected period — whether because no activity qualified at all, or because no candidate met the minimum in FR-013 — MUST still be displayed, in an explicit "no winner yet" state.
- **FR-015**: Awards MUST resolve ties by a deterministic rule so that repeated views of unchanged data produce the same winner.

#### Time Period

- **FR-016**: The page MUST offer a period selector with exactly three options: All Time, This Month, and This Week.
- **FR-017**: Changing the selected period MUST recompute both the leaderboard and the awards over that period, and MUST NOT require a full page reload.
- **FR-018**: "All Time" MUST be the selected period when the page is first opened.
- **FR-019**: Empty results for a period MUST be presented as an empty state that names the selected period, never as an unannounced fallback to a different period.
- **FR-020**: The system MUST reject a request for an unrecognised time-period value with an error, rather than defaulting to, or silently substituting, one of the three supported periods. A member (or client) asking for a period that does not exist MUST be told so, never shown another period's figures under the label they asked for.

#### Action Tracking

- **FR-021**: The system MUST record each of the following control actions as it occurs: skip, pause, resume, remove-from-queue, shuffle, and clear-queue.
- **FR-022**: Each recorded action MUST capture the member who performed it, when it occurred, and — where the action targets a specific track — that track's identity and the member who originally queued it.
- **FR-023**: The system MUST record when a track finishes playing naturally, and MUST distinguish a natural completion from a skip.
- **FR-024**: Actions MUST be recorded identically regardless of which surface they were performed from (web dashboard, Discord command, or realtime dashboard control), so that no surface produces an incomplete or differently-shaped record.
- **FR-025**: A failure to record a play or a control action MUST NOT prevent, delay noticeably, or surface an error for the underlying operation. On failure the record MUST be dropped rather than retried or queued, and the failure MUST be written to the operational log so the loss is visible rather than silent. Stats recording is best-effort by design.
- **FR-026**: Play history MUST NOT be deleted when the bot leaves a voice channel — whether by inactivity timeout, an explicit leave command, or the dashboard leave control. This changes existing behavior, which clears all play history on every such leave and would otherwise reset every figure on this page.
- **FR-027**: When the bot is removed from the guild, recorded plays and recorded actions MUST be cleared together in the same operation, so that the two data sets can never disagree about what happened.

#### Presentation

- **FR-028**: The page MUST match the existing dashboard's visual style and remain fully usable at phone width, with no horizontal scrolling of the page body.
- **FR-029**: The page MUST show a loading state while stats are being retrieved, and a recoverable error state with a retry affordance if retrieval fails.

#### Timezone

- **FR-030**: Every time-of-day and calendar computation on the page — the Night Owl and Early Bird hour windows (FR-012), "a single day" for The Hog, and the start of This Week (Monday) and This Month — MUST use one explicitly configured IANA timezone (e.g. `Europe/Copenhagen`), including its daylight-saving transitions. The deployed runtime MUST carry the timezone data needed to honour it, and an unrecognised timezone value MUST stop startup with a clear error rather than silently falling back to UTC or the host default.

### Key Entities

- **DJ (Member)**: A guild member who has queued at least one track since launch. Identified by a stable identity that survives display-name changes; presented using the display name and avatar captured on their most recent recorded play.
- **Play Record**: One occurrence of a track being played — the track's title, link, duration, who queued it, and when it played. Play records already exist today but carry only a display name; from launch onward they also carry the queuing member's stable identity plus a snapshot of their display name and avatar at that moment, and only those enriched records feed this page. Each record also notes whether loop mode started it; loop replays are kept in history but never counted here (FR-005a).
- **Control Action**: One occurrence of a member changing playback or queue state — the action type, the acting member, when it happened, and, where applicable, the affected track and that track's original requester. New with this feature; the basis of the behavior-derived awards.
- **Leaderboard Entry**: A member's aggregated standing for a selected period — rank, tracks queued, total listening time, and distinct-track count.
- **Award**: A named superlative with a description, the rule that determines its winner, the winning member for a selected period, and the winning value. May have no winner.
- **Time Period**: The window that scopes every figure on the page — All Time (meaning since launch), This Month, or This Week.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: A member can go from any dashboard page to seeing their own rank on the DJ Stats leaderboard in one click and under 5 seconds.
- **SC-002**: The leaderboard and awards finish loading and become readable within 2 seconds for a body of up to 100,000 plays.
- **SC-003**: Switching between the three time periods produces updated results within 1 second, without the page appearing to reload.
- **SC-004**: On day one, with no post-launch activity yet recorded, every section of the page — the leaderboard and every single award — renders an explicit empty state, with zero errors and zero blank panels.
- **SC-005**: A track played after launch is reflected in the leaderboard totals on the next load of the page.
- **SC-006**: All six tracked action types are instrumented on all three surfaces — 18 of 18 action/surface combinations — verified by performing each action on each of the web dashboard, a Discord command, and a realtime dashboard control. No surface is left uninstrumented.
- **SC-007**: Every play record written after launch carries a stable identity plus a name and avatar snapshot for the queuing member, so no stored play is unattributed or split across renames.
- **SC-008**: Every stats recording failure produces a log entry naming what was lost; zero failures are silent.
- **SC-009**: Zero playback or queue operations fail, error, or slow down measurably as a result of stats recording.
- **SC-010**: Every award defined by the feature is displayed at all times, each either with a winner or in an explicit "no winner yet" state — no award is ever missing or blank.
- **SC-011**: The page is fully readable and operable at 400px viewport width, with no horizontal scrolling of the page body.
- **SC-012**: Repeated loads of the same unchanged data produce identical rankings and award winners.
- **SC-013**: A play recorded at 23:30 in the configured timezone counts toward Night Owl and toward that local calendar day, week and month in both summer and winter time, whatever timezone the host machine is set to.
- **SC-014**: With track-loop on, a single queued track that plays 20 times contributes exactly 1 to its queuer's track count, 1 play toward Most Played Song, and 1 play toward The Hog, while the History page lists all 20 plays.

## Assumptions

- **Stats begin at launch**: Play records created before this feature carry no stable member identity and are excluded from every figure on the page. "All Time" means "since this feature shipped". The leaderboard and all awards start empty on day one and fill in as activity accrues — this is the accepted, deliberate trade for attribution that is exactly correct and rename-proof.
- **No backfill**: Neither historical plays nor pre-launch control actions can be reconstructed, and no attempt is made to infer identities from stored display names.
- **Audience and visibility**: All stats are visible to every member authorized to use the dashboard. This is a single friend-group guild, and the superlatives are intended to be seen and joked about; no per-member opt-out or privacy control is in scope.
- **Web surface only**: The DJ Stats page is a web dashboard feature. No Discord slash command for stats is in scope. The project's transport-parity principle is honored where it applies — the *recording* of control actions must be identical across Discord, HTTP, and realtime surfaces (FR-024) — but stats presentation is a read-only reporting view, not a playback capability that would diverge between transports.
- **Calendar-based periods**: "This Week" means the current calendar week and "This Month" the current calendar month, in the configured stats timezone (FR-030) — not rolling 7- and 30-day windows. This matches the labels shown to members.
- **Every played track has a requester**: Tracks are always queued by an identifiable member, so there is no "system" or "autoplay" DJ to exclude from the leaderboard.
- **Awards follow the period toggle**: Award winners are recomputed for the selected period, not fixed to all-time.
- **Stats are read-only and observational**: Nothing on this page changes playback, queue state, or any member's data.
- **Near-real-time is sufficient**: Stats reflect activity as of page load or period change. Live push updates of the stats page while it is open are not required.
- **No manual clear**: With the voice-leave wipe removed (FR-026), nothing in the product clears play history or stats on demand; the only remaining path is removing the bot from the guild, which clears both (FR-027). A dashboard "clear history" control is deliberately out of scope — this feature exists to accumulate exactly this data, and a destructive control beside a leaderboard mostly invites accidental loss. Recorded as a possible follow-up if it turns out to be wanted.
- **Retention**: Recorded plays and actions are retained for as long as the bot remains in the guild, and are cleared together if it is removed (FR-026, FR-027). This is **not** the existing treatment of play history, which is wiped whenever the bot leaves a voice channel — that behavior is changed by this feature, because it would otherwise reset the leaderboard and every history-derived award many times a day. No time-based purge or size cap is introduced.
- **Existing infrastructure is reused**: The feature builds on the dashboard's existing authentication, navigation, styling, and play-recording path rather than introducing a parallel system.
