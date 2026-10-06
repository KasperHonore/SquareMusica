---

description: "Task list for feature 002 — AI DJ Host"
---

# Tasks: AI DJ Host

**Input**: Design documents from `/specs/002-ai-dj-host/`

**Prerequisites**: plan.md, spec.md, research.md (R1–R13), data-model.md, contracts/dj-api.md, quickstart.md

**Tests**: Included. plan.md (Technical Context → Testing, and Project Structure → `test/`) names the
test files explicitly, and the Principle III note requires `test/transports/djParity.test.js` to
survive into this list. Write each story's tests first and confirm they fail before implementing.

**Organization**: Tasks are grouped by user story so each story can be implemented and tested
independently. US1 and US2 are both P1; US1 comes first because US2's controls are only
observable once the DJ can speak.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies on incomplete tasks)
- **[Story]**: Which user story this task belongs to (US1–US4)
- Every task names its exact file path

## Path Conventions

Web application: backend under `src/`, tests under `test/`, React SPA under `web/src/`.
Layer rules (Constitution II) apply to every task: `src/core/` MUST NOT import `src/transports/`;
`src/services/dj/*` MUST NOT import `src/transports/`; persistence only via `src/persistence/db.js`.

---

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Record the architectural decision and document the new configuration group.

- [X] T001 [P] Write `docs/ADR-002-dj-audio-mixing.md` in the format of `docs/ADR-001-guild-scope.md`, recording research R1/R2: the PCM transcode moves into our code (`getPcmStream`, `ffmpeg -hide_banner -loglevel error -i pipe:0 -f s16le -ar 48000 -ac 2 pipe:1`), a `DuckingMixer` Transform feeds `StreamType.Raw`, the legacy `StreamType.Arbitrary` path is kept byte-for-byte when the DJ is unconfigured, the rejected alternatives (ffmpeg `amix`/`sidechaincompress`, `inlineVolume` only, second AudioPlayer, mixer npm packages), and the volume follow-up (a future volume feature must multiply into the mixer gain)
- [X] T002 [P] Add the DJ env group to `.env.sample` as a commented block: required-together `ELEVENLABS_API_KEY`, `ELEVENLABS_VOICE_ID`, `DJ_LLM_BASE_URL`, `DJ_LLM_MODEL` (note "set all four or none"); optional `DJ_LLM_API_KEY`, `ELEVENLABS_MODEL_ID` (default `eleven_flash_v2_5`), `DJ_DAILY_LINE_CAP` (default 150), `DJ_DAILY_THEME_TRACK_CAP` (default 100)
- [X] T003 Create the empty service folder `src/services/dj/` with a module-level comment header in `src/services/dj/errors.js` defining `DjError extends Error` with a `code` property and exported constants for every code in contracts §2: `DJ_UNAVAILABLE`, `INVALID_INTERVAL`, `INVALID_LOOKAHEAD`, `INVALID_THEME`, `NOT_IN_VOICE`, `NO_TRACKS_FOR_THEME`, `SERVICE_UNAVAILABLE`, `CAP_REACHED`

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Configuration gate, persistence for settings/usage, the audio mixing pipeline, the two
external clients, and a `djService` skeleton that every story extends.

**⚠️ CRITICAL**: No user story work can begin until this phase is complete

### Tests for Foundational (write first, confirm they fail)

- [X] T004 [P] Extend `test/config/env.test.js`: (a) no DJ vars → `djRequiredVars()` returns `[]` and `isDjConfigured()` is false; (b) only `ELEVENLABS_API_KEY` set → `validateEnv([...base, ...djRequiredVars()])` throws ONE aggregated error naming `ELEVENLABS_VOICE_ID`, `DJ_LLM_BASE_URL`, `DJ_LLM_MODEL` alongside any other missing base var; (c) `validateDjFormats()` rejects a non-positive-integer `DJ_DAILY_LINE_CAP`/`DJ_DAILY_THEME_TRACK_CAP` and a `DJ_LLM_BASE_URL` that is not `http:`/`https:`
- [X] T005 [P] Create `test/persistence/dj.test.js` (settings/usage part): `getDjSettings()` on a fresh DB returns `{ enabled: false, interval: 3, lookahead: 5 }` and creates row `id = 1`; `updateDjSettings({ interval: 4 })` persists; raw inserts violating `CHECK (id = 1)`, `CHECK (interval BETWEEN 1 AND 10)`, `CHECK (lookahead IN (5, 10))` throw; `incrementDjUsage(day, 'lines')` twice yields `lines = 2` via upsert; `incrementDjUsage(day, 'bogus')` throws (field whitelisted to `lines` | `themed_tracks`)
- [X] T006 [P] Create `test/core/audioMixer.test.js` on synthetic s16le stereo buffers: passthrough is byte-identical with no overlay; with an overlay the music gain ramps 1.0 → 0.3 over 200 ms (9600 frames) and overlay samples are added; sums clamp to int16 `[-32768, 32767]`; after the overlay is exhausted gain ramps 0.3 → 1.0 over 300 ms; `cancelOverlay()` drops remaining overlay and starts the release ramp; a chunk ending mid-frame (e.g. 3 bytes) is carried into the next chunk with no sample loss
- [X] T007 [P] Create `test/core/player-overlay.test.js`: with `setMixingEnabled(false)` `play()` builds the resource with the stream's own type (legacy `Arbitrary` path) and `overlay()` returns `false`; with mixing enabled `play()` builds a `StreamType.Raw` resource through a `DuckingMixer`; `overlay(buf)` returns `false` when nothing is playing or paused; `pause()`, `stop()` and `play()` each call `cancelOverlay()` on the current mixer; `musicManager.clearQueue()` and `musicManager.clearUpcomingQueue()` each call `player.cancelOverlay()` while the current track keeps playing (FR-009 queue clear); `musicManager.ensurePlaying()` on an idle player starts the first queued track through `advanceAndPlay` and emits `track:change` and `queue:update`, and returns `false` without starting anything when already playing or paused; when no queued track can be played it returns `false`, calls `player.stop()` and emits `track:change(null)` once. Extend `test/music/queue.test.js` with `peekNext()` cases for loop `off`, `track` and `queue` (including the wrap at the last index) asserting `currentIndex` and `loopReplay` are untouched. Also assert `musicManager.clearAllButCurrent()` calls `player.cancelOverlay()` once, leaves the current track as the only entry with `currentIndex = 0`, and emits one `queue:update`
- [X] T008 [P] Create `test/integrations/elevenlabs.test.js` with `fetch` mocked: request is `POST https://api.elevenlabs.io/v1/text-to-speech/{voiceId}?output_format=pcm_48000` with header `xi-api-key` and body `{ text, model_id }`; mono response is returned as stereo (each sample duplicated); a clip longer than 15 s (`bytes / (48000 × 2) > 15` for mono) is rejected; a format rejection retries once with `pcm_24000` and 2× sample-doubling upsample; `401 quota_exceeded` surfaces a `quota` error kind; `429` retries once after 1 s then fails; `422` fails without retry
- [X] T009 [P] Create `test/integrations/llm.test.js` with `fetch` mocked: `chatJson()` posts to `${DJ_LLM_BASE_URL}/chat/completions` with `response_format: { type: "json_object" }`, sends `Authorization: Bearer` only when `DJ_LLM_API_KEY` is set, parses `choices[0].message.content` as JSON, and throws on malformed JSON, non-2xx, or timeout

### Implementation for Foundational

- [X] T010 Add to `src/config/env.js`: `DJ_GROUP_VARS = ['ELEVENLABS_API_KEY','ELEVENLABS_VOICE_ID','DJ_LLM_BASE_URL','DJ_LLM_MODEL']`; `djRequiredVars()` returning all four names if ANY is set, else `[]`; `isDjConfigured()`; `validateDjFormats()` checking caps are positive integers and the base URL parses as `http(s)`; `getDjConfig()` returning `{ elevenlabs: { apiKey, voiceId, modelId (default 'eleven_flash_v2_5') }, llm: { baseUrl, model, apiKey|null }, caps: { lines (default 150), themedTracks (default 100) } }` (R10)
- [X] T011 Update `src/index.js` to append `djRequiredVars()` to the existing `validateEnv([...])` list and call `validateDjFormats()` in the same pre-dynamic-import phase (Constitution IV); after playback is initialised, if `isDjConfigured()` call `player.setMixingEnabled(true)` and dynamically import and `init()` `src/services/dj/djService.js`; when unconfigured construct nothing
- [X] T012 Add to `src/persistence/schema.sql` (all `CREATE TABLE IF NOT EXISTS`): `dj_settings` (`id INTEGER PRIMARY KEY CHECK (id = 1)`, `enabled INTEGER NOT NULL DEFAULT 0`, `interval INTEGER NOT NULL DEFAULT 3 CHECK (interval BETWEEN 1 AND 10)`, `lookahead INTEGER NOT NULL DEFAULT 5 CHECK (lookahead IN (5, 10))`, `updated_at DATETIME DEFAULT CURRENT_TIMESTAMP`); `dj_shoutout_optouts` (`user_id TEXT PRIMARY KEY`, `created_at DATETIME DEFAULT CURRENT_TIMESTAMP`); `dj_usage` (`day TEXT PRIMARY KEY`, `lines INTEGER NOT NULL DEFAULT 0`, `themed_tracks INTEGER NOT NULL DEFAULT 0`)
- [X] T013 Add to `DatabaseManager` in `src/persistence/db.js`: `getDjSettings()` (runs `INSERT OR IGNORE INTO dj_settings (id) VALUES (1)` then returns `{ enabled: boolean, interval, lookahead }`); `updateDjSettings(partial)` as a single UPDATE that also sets `updated_at`; `getDjUsage(day)` returning `{ lines, themed_tracks }` (zeros when no row); `incrementDjUsage(day, field)` with `field` whitelisted to `'lines' | 'themed_tracks'` using `INSERT ... ON CONFLICT(day) DO UPDATE SET <field> = <field> + 1`; optionally prune `dj_usage` rows older than 30 days in the boot path (depends on T012)
- [X] T014 [P] Create `src/core/audioMixer.js` exporting `DuckingMixer extends Transform` (imports only `node:stream`): s16le stereo (4 bytes/frame), `highWaterMark` 5 frames of 20 ms (5 × 3840 B); `overlay(buffer)` replaces any in-progress overlay; per-sample linear gain ramp toward 0.3 over 200 ms attack and back to 1.0 over 300 ms release; music × gain + overlay, clamped to int16; `cancelOverlay()` drops remaining overlay and begins release; partial frames carried across chunks (R1, contracts §4)
- [X] T015 [P] Add `getPcmStream(url)` to `src/integrations/youtube.js`: call the existing `getStream(url)`, pipe its stream into an FFmpeg child resolved from `ffmpeg-static` falling back to `ffmpeg` on `PATH`, args `-hide_banner -loglevel error -i pipe:0 -f s16le -ar 48000 -ac 2 pipe:1`; fold the FFmpeg process kill into the same idempotent `cleanup` and keep the existing startup watchdog/drain semantics; return the same result shape with `type: StreamType.Raw` (R2)
- [X] T016 Update `src/core/player.js`: add `setMixingEnabled(bool)`; in `play()` when mixing is enabled use `getPcmStream`, pipe through a new `DuckingMixer` per track and create the resource with `StreamType.Raw`, otherwise keep today's code path unchanged; add `overlay(pcm): boolean` (false if nothing playing, paused, or mixing disabled) and idempotent `cancelOverlay()`; call `cancelOverlay()` from `pause()`, `stop()` and at the start of `play()`; no new imports from outside `core/` and `integrations/` (depends on T014, T015)
- [X] T017 [P] Create `src/integrations/elevenlabs.js` exporting `synthesize(text)` → 48 kHz s16le stereo `Buffer` using built-in `fetch` (no SDK): endpoint, headers and body per contracts §5c with `AbortSignal.timeout(8000)`; mono→stereo by sample duplication; reject clips > 15 s; on output-format rejection log one `warn`, switch to `pcm_24000` with 2× sample-doubling for the process lifetime; error kinds `quota` (401 `quota_exceeded` / bad key, no retry), `rate` (429, one retry after 1 s), `invalid` (422, no retry) (R3)
- [X] T018 [P] Create `src/integrations/llm.js` exporting `chatJson({ system, user, temperature, timeoutMs })` using built-in `fetch` to `${baseUrl}/chat/completions` with `model`, `response_format: { type: 'json_object' }`, optional Bearer key, `AbortSignal.timeout(timeoutMs)`, no retries; returns parsed JSON or throws (R4)
- [X] T019 Update `src/core/musicManager.js`: add `setGetDjState(fn)` (same injection pattern as `setGetChannelInfo`) and include `dj: getDjState?.() ?? { available: false }` in `getFullState()`; call `this.player?.cancelOverlay?.()` in `clearQueue()` and `clearUpcomingQueue()` (FR-009); change the existing `ensurePlaying()` (`src/core/musicManager.js:171`) to call `advanceAndPlay({ player: this.player, queue: this.queue, connection, skipCurrent: false })` instead of `tryPlayWithFallback` and return `played` (behaviour change: when nothing can play, `advanceAndPlay` always calls `player.stop()`, emits `track:change(null)` and `queue:update`, and on success also starts lookahead resolution; today's code emits only when `queue.length > 0`; existing transport tests mock `ensurePlaying`, so only the new T007 cases cover it), so member adds and themed picks share one start path (FR-026, Constitution III) and `services/dj/` never needs `transports/` or a new `guildId || GUILD_ID` copy. Also add to `src/core/queue.js` a side-effect-free `peekNext()` mirroring `next()`: loop `track` returns the current entry, loop `queue` at the last index returns `tracks[0]`, otherwise `tracks[currentIndex + 1] ?? null`; it never changes `currentIndex` or loop-replay flags. `getVoiceContext()` and `emitVoiceContext()` already exist (`src/core/musicManager.js:270-280`) and return the full channel info or `null`; do NOT change their shape — DJ code reads `getVoiceContext()?.connectedUsers ?? []`
- [ ] T019a Add `clearAllButCurrent()` to `src/core/musicManager.js`: keep the current track (if any) as the only entry with `currentIndex = 0`, call `this.player?.cancelOverlay?.()`, and `emitQueueUpdate()` once. Change `handleClear` in `src/transports/discord/commands/queue.js` to compute `clearedCount` first, then call `musicManager.clearAllButCurrent()` in place of assigning `q.tracks`/`q.currentIndex` and calling `emitQueueUpdate()` directly. Keep the `all_but_current` stats variant and the reply unchanged. This makes all three transports' queue clears pass through the mediator, which cancels the overlay (FR-009, Constitution III) (depends on T019)
- [X] T020 Update `src/transports/realtime/socketServer.js` to add `dj:state` to the `managerListeners` table so every `musicManager.emit('dj:state', state)` is re-broadcast to all sockets; add `DJ_STATE: 'dj:state'` to `src/transports/realtime/events.js`
- [X] T021 Create `src/services/dj/djService.js` skeleton: `init()` loads settings via `db.getDjSettings()`, registers `musicManager.setGetDjState(getState)`; `getState()` returns the `DjState` shape from contracts §1 (`available`, `enabled`, `interval`, `lookahead`, `health`, `caps { lines, themedTracks, resetsAt }`, `theme: null`), and `{ available: false }` when not initialised; private `broadcast()` that emits exactly one `musicManager.emit('dj:state', getState())`; `resetsAt` is the next local midnight as an ISO string with offset; never imports `src/transports/` (depends on T003, T010, T013, T019)
- [X] T022 Add `setSettings({ enabled?, interval?, lookahead? }, actor)` to `src/services/dj/djService.js`: throw `DJ_UNAVAILABLE` when not configured; validate the whole partial before writing — `interval` an integer from 1 to 10 inclusive else `INVALID_INTERVAL`, `lookahead` exactly 5 or 10 else `INVALID_LOOKAHEAD`, `enabled` boolean; on success call `db.updateDjSettings` once, update in-memory state, broadcast once; on error state is unchanged; also export a non-throwing `getStateOrUnavailable()` helper used by transports when the service was never constructed
- [X] T023 Add the breaker and caps to `src/services/dj/djService.js` (R9): `recordFailure(kind)` / `recordSuccess()`; after 3 consecutive failures open for 5 min, half-open allows one attempt, `quota` opens for 30 min; `health: 'degraded'` while open; every failure logged at `warn` with cause via `src/utils/logger.js`; caps read limits from `getDjConfig().caps` and usage from `db.getDjUsage(today)` where `today` is `date('now','localtime')`; `caps.*.reached` computed as `used >= limit`; broadcast when health or a `reached` flag flips; schedule a timer for `caps.resetsAt` that re-reads usage for the new day, recomputes `reached`, broadcasts once, and reschedules itself for the following midnight (FR-034)

**Checkpoint**: `npm test` green for T004–T009; with no DJ vars the app boots and plays exactly as before; with DJ vars the PCM path plays music identically to the legacy path.

---

## Phase 3: User Story 1 - The DJ introduces songs out loud (Priority: P1) 🎯 MVP

**Goal**: With the DJ enabled, at every Nth transition a validated one-or-two-sentence line about the previous/next track is spoken over the opening of the next track with the music ducked, never delaying playback.

**Independent Test**: Set `dj_settings` to `enabled = 1, interval = 1` (via `djService.setSettings` in a REPL or directly in SQLite), queue three tracks and let them play. A line referencing the upcoming or previous track is heard within 2 s of each track start over lowered music; each line is ≤ 2 sentences; music returns to full level afterwards; `/skip` during a line stops it (quickstart §2–§3).

### Tests for User Story 1 ⚠️

- [X] T024 [P] [US1] Create `test/services/dj/lineWriter.test.js` with `llm.chatJson` and `elevenlabs.synthesize` mocked: accepts a 1–2 sentence line ≤ 240 characters whose `factIds` all exist; rejects 3 sentences, > 240 characters, an unknown fact id, an exact repeat of any of the last 20 spoken lines, malformed JSON, a line stating a quantity (digits, or a number word followed by a count noun, e.g. "twelve times") that does not equal a numeric value in one of its cited facts (FR-005) — while accepting "Hey Kasper, this one's for you." and "Here's one more classic." with no numeric facts — and a line containing a term from `contentFilter.js` (spec edge case: no slurs or harassment); a rejected line never calls `synthesize`; the prompt includes only the last 5 lines in `recentLines`
- [X] T025 [P] [US1] Create `test/services/dj/linePlanner.test.js` with fake timers and a fake player: interval 3 over 6 transitions speaks exactly 2 times; a dropped line does not reset `transitionsSinceSpoken`; seven tracks played back to back from an idle queue are six transitions (the first `track:change` after `track:change(null)` or a cold start is NOT a transition, FR-006); `resetCounter()` restarts the count so with interval 4 the next line is at the 4th transition after the call; a skip counts as a transition; the predicted next track comes from `queue.peekNext()`, so with loop `track` or loop `queue` at the last index the prepared line matches the track that actually starts; preparation is scheduled at `max(0, duration − 30 s)` and immediately when duration is unknown or < 30 s; a prepared line whose `forKey` ≠ the started track's key is discarded (rapid skip); a line still in flight 2 s after track start is dropped and the track is never delayed; no preparation when disabled, paused, the queue has no next track, the breaker is open, the line cap is reached, or `connectedUsers` has no human (FR-010); a `queue:update` that changes the predicted next track discards and re-prepares; loop replays count as transitions but the same text is not spoken twice in a row for the same track; a prepared line with `namedUserIds: ['A']` is dropped (`stale-member`) when A is missing from `connectedUsers` at speak time, even though no `voice:context` event fired; the same applies when A has opted out since preparation; the counter is not reset by either drop
- [X] T026 [P] [US1] Create `test/services/dj/djService.test.js` (settings/breaker/caps part): `setSettings({ interval: 11 })` throws `INVALID_INTERVAL` and state is unchanged; `setSettings({ lookahead: 7 })` throws `INVALID_LOOKAHEAD`; a valid mutation emits exactly one `dj:state`; changing `interval`, or `enabled` from false to true, calls the planner's `resetCounter()` once, while a `lookahead`-only change does not (FR-006); 3 consecutive failures set `health: 'degraded'`, and after 5 min one success restores `'ok'`; a `quota` failure keeps it open 30 min; usage increments only on successful TTS and `caps.lines.reached` flips at the limit; unconfigured service rejects mutations with `DJ_UNAVAILABLE`; with fake timers, when `caps.lines.reached` is true, crossing local midnight flips it to false, moves `resetsAt` forward a day, and emits exactly one `dj:state`

### Implementation for User Story 1

- [X] T027 [P] [US1] Create `src/services/dj/context.js` exporting `trackKey(track)` (`url` when resolved, else `spotifyData.spotifyId`, else `` `${title}|${addedAt}` ``) and `buildContext({ previous, next, theme, present, recentLines })` producing the Listening Context shape from data-model.md with `track` facts (previous and next: title, artist/channel) and a `theme` fact when `theme` is set; the track's queuer is NOT included in US1 (T051 adds it under the member rules); member/group facts are added in US3 — leave a clearly named extension point `addMemberFacts(ctx)` returning `ctx` unchanged for now
- [X] T028 [US1] Create `src/services/dj/lineWriter.js` exporting `writeLine(ctx, recentSpoken)`: build the system prompt from contracts §5a (one or two short sentences, only provided facts, only `allowedNames`, spell numbers as words, no emoji, return `{"line","factIds"}`) and the user payload `{ next, previous, theme, allowedNames, facts, recentLines }` (last 5); call `llm.chatJson` with `temperature 0.9`, `timeoutMs 10000`; validate per R6 steps 1, 2 and 4 (1–2 sentences, ≤ 240 characters; every `factIds` entry exists; not identical to any of the last 20 spoken lines) plus two checks run before TTS: (a) every quantity in the line — digits, or an English number word from zero to one hundred immediately followed by a count noun (`plays`, `times`, `tracks`, `songs`, `spins`, `days`, `weeks`, `people`, `of you`) — must equal a numeric value in one of the cited facts, otherwise reject (FR-005); number words used as ordinary words ("this one's for you", "one more") are not quantities; (b) `isClean(text)` from a new `src/services/dj/contentFilter.js` — a module-level lowercase word list of slurs and harassment terms matched case-insensitively on word boundaries — must pass, otherwise reject; the system prompt also forbids insults, slurs and personal information beyond the provided facts. Step 3 (forbidden names) is added in US3; on pass call `elevenlabs.synthesize(text)` and return `{ forKey, text, pcm, factIds, namedUserIds: [], preparedAt }`; on any failure throw with a `kind` the breaker understands (depends on T027)
- [X] T029 [US1] Create `src/services/dj/linePlanner.js` implementing R5: transition counter `transitionsSinceSpoken`; a transition is a non-null `track:change` whose previous `track:change` was also non-null — `track:change(null)` (stop, empty queue) and the first start after boot set `previous = null` so the next start is not counted (FR-006); export `resetCounter()` setting the counter to 0; on `track:change` schedule preparation for the predicted next track (`queue.peekNext()`, T019) at `max(0, duration − 30 s)`; one preparation in flight at a time; on `queue:update` discard and re-prepare if the predicted next key changed; on the next `track:change` if due and the prepared `forKey` matches, call `player.overlay(pcm)`, else wait up to 2 s for an in-flight preparation then drop; reset counter only after a line is actually overlaid; never `await` inside the playback call path; check all silence conditions from R5 step 5 before preparing and before speaking; immediately before `player.overlay(pcm)`, re-read `getVoiceContext()?.connectedUsers ?? []` and `db.getShoutoutOptOuts()`, and if any `namedUserIds` entry is absent or opted out, drop the line with reason `stale-member` and do not reset `transitionsSinceSpoken` (R7, FR-017, FR-020); until US3, `namedUserIds` is always `[]`, so the check passes trivially; keep a 20-entry ring buffer of spoken texts (depends on T028)
- [X] T030 [US1] Wire the planner into `src/services/dj/djService.js`: subscribe to the mediator's `track:change` and `queue:update` in `init()`; pass getters for settings, `musicManager.getVoiceContext()`, the queue and `player` from `src/services/playback.js` (getters only, no transport imports); call `recordSuccess()`/`recordFailure(kind)` around `writeLine`; call `db.incrementDjUsage(today, 'lines')` when TTS succeeds and refresh caps; in `setSettings` call `planner.resetCounter()` when `interval` changes or `enabled` goes false→true (FR-006); do NOT add a second broadcast here — `setSettings` (T022) already emits exactly one `dj:state` (depends on T029, T023)
- [X] T031 [US1] Add structured `info`/`warn` logging in `src/services/dj/linePlanner.js` for: line prepared (key, chars, ms), line spoken, line dropped (reason: stale, stale-member, late, validation, service, cap, no-listeners), never logging the TTS buffer or the API keys; keep daily `due` and `spoken` counters (a due line is a transition selected by the interval while no silence condition holds) and log `due`, `spoken` and the ratio at `info` on each local-day rollover and on shutdown, so SC-002's 90% target can be checked

**Checkpoint**: US1 independent test passes; skip/pause/stop during a line restores full level (FR-009); with the LLM endpoint down music plays uninterrupted and health turns degraded after 3 failures (quickstart §7).

---

## Phase 4: User Story 2 - Members control the DJ (Priority: P1)

**Goal**: Any guild member can enable/disable the DJ, set the interval and lookahead from Discord, the HTTP API, Socket.io and the dashboard with identical semantics; changes broadcast within 2 s and persist across restarts.

**Independent Test**: Enable the DJ from Discord → dashboard shows it enabled without refresh; change the interval on the dashboard → `/dj status` reports it; `PATCH /api/dj {"interval": 11}` → 400 `INVALID_INTERVAL`, state unchanged; restart → enabled/interval/lookahead unchanged (quickstart §4).

### Tests for User Story 2 ⚠️

- [X] T032 [P] [US2] Create `test/http/routes/dj.test.js` mirroring `test/http/routes/stats.test.js`: `GET /api/dj` returns `DjState` (and `{ available: false }` when unconfigured); `PATCH /api/dj` accepts any subset of `{ enabled, interval, lookahead }`, calls `djService.setSettings` once, returns the new state; error codes map to HTTP per contracts §2 (`DJ_UNAVAILABLE` 503, `INVALID_INTERVAL` 400, `INVALID_LOOKAHEAD` 400) with body `{ code, message }`; unauthenticated requests are rejected by `authMiddleware`
- [X] T033 [P] [US2] Create `test/transports/djParity.test.js` modelled on `test/transports/statsParity.test.js`: against a mocked `djService`, drive the "Read state", "Enable / disable", "Set interval" and "Set lookahead" rows of contracts §3 through Discord (`/dj status|on|off|interval|lookahead`), HTTP and Socket (`dj:settings`) and assert the same service call, the same arguments, and the same error-code mapping (HTTP status / Discord ephemeral text / socket `error {code,message}`); structure the matrix as a table so US3 and US4 append rows. Add a "Clear queue during a DJ line" row: Discord `/clear`, HTTP `DELETE /api/queue`, and socket `player:control { action: 'clear' }` each result in exactly one `player.cancelOverlay()` call (FR-009)

### Implementation for User Story 2

- [X] T034 [P] [US2] Create `src/services/dj/messages.js` exporting the shared error-code table from contracts §2: `{ code → { http, text } }` with the exact Discord texts ("The DJ isn't set up on this server.", "Interval must be a whole number from 1 to 10.", "Lookahead must be 5 or 10.", "Theme must be 1–200 characters.", the existing not-in-voice text, "I couldn't find any tracks for that theme.", "The DJ's music brain is unavailable right now, try again soon.", "The DJ has hit today's limit; it resets at HH:MM." with HH:MM from `caps.resetsAt`); every transport uses this table so mappings cannot diverge
- [X] T035 [US2] Create `src/transports/http/routes/dj.js` (depends on T034): `GET /` → `djService.getState()` (or `{ available: false }`); `PATCH /` → validates body is an object, calls `djService.setSettings(body, actor)` with `actor = { id, name }` from the JWT user, returns state; maps `DjError` via `messages.js` to `res.status(http).json({ code, message })`
- [X] T036 [US2] Mount `/api/dj` in `src/transports/http/index.js` behind `authMiddleware`, with the existing `mutationLimiter` on non-GET methods (depends on T035)
- [X] T037 [US2] Add `handleDjSettings(socket, payload)` (depends on T034) to `src/transports/realtime/handlers.js`: per-user `isThrottled` with key `dj` at 1000 ms, adding `'dj': 1000` to `THROTTLE_INTERVALS_MS` (keys missing from that table are never throttled); calls `djService.setSettings(payload, actor)`; on `DjError` emits `error { code, message }` from `messages.js`; add `DJ_SETTINGS: 'dj:settings'` to `src/transports/realtime/events.js`
- [X] T038 [US2] Register `dj:settings` → `handleDjSettings` in `src/transports/realtime/socketServer.js` (depends on T037)
- [X] T039 [US2] Create `src/transports/discord/commands/dj.js` (depends on T034) with subcommands `status`, `on`, `off`, `interval every:<1-10>`, `lookahead size:<5|10>`: thin adapters over `djService.getState()`/`setSettings()`; settings changes reply publicly like `/loop`; errors reply ephemerally with `messages.js` text; `status` shows enabled, interval, lookahead, health and caps (used/limit, reset time); never posts DJ line text (FR-001a)
- [X] T040 [US2] Add the `/dj` `SlashCommandBuilder` (subcommands from T039; `every` integer min 1 max 10; `size` integer choices 5 and 10) to `src/transports/discord/commands/register.js` and route `dj` to the handler in `src/transports/discord/commands/index.js` (depends on T039)
- [X] T041 [P] [US2] Extend `web/src/hooks/useSocket.js` to hold `djState` from `initial:state.dj` and `dj:state` events, and expose `setDjSettings(partial)` emitting `dj:settings`; expose both through `web/src/context/SocketContext.jsx`
- [X] T042 [P] [US2] Create `web/src/pages/Dj.jsx`: when `djState.available === false` show "The DJ isn't set up on this server." and no controls; otherwise an on/off toggle, an interval selector 1–10, a lookahead selector 5/10, a health badge (`ok`/`degraded`) and caps (`used / limit`, "limit reached, resets at HH:MM" when reached); never displays DJ line text; matches existing Tailwind patterns in `web/src/pages/Stats.jsx`
- [X] T043 [US2] Add a "DJ" nav item to `web/src/components/layout/Sidebar.jsx` and render `Dj` for it in `web/src/components/center/CenterPanel.jsx` (depends on T042)

**Checkpoint**: US2 independent test passes; DJ parity test green for settings rows; `npm run register` adds `/dj`.

---

## Phase 5: User Story 3 - Personal shout-outs to people in the room (Priority: P2)

**Goal**: The DJ can name present, opted-in members and cite true history (≥ 3 counted plays), never names absent or opted-out members, and members can opt out from any surface.

**Independent Test**: With A and B in voice and A having ≥ 3 counted plays of the next track, the line may name A with a true count; after A leaves or runs `/dj shoutouts enabled:false`, A is never named while group lines still work (quickstart §5).

### Tests for User Story 3 ⚠️

- [ ] T044 [P] [US3] Extend `test/persistence/dj.test.js`: `setShoutoutOptOut(uid, true)` then `isShoutoutOptedOut(uid)` is true and `getShoutoutOptOuts()` contains it; `setShoutoutOptOut(uid, false)` deletes the row; `getUserPlayCountsForUrl(url, ids)` excludes loop replays (`is_loop_replay = 1`) and rows with `requested_by_id IS NULL`; `getUserTopTrack(uid)` returns `null` when the user has no counted plays; `getKnownMemberNames()` returns the latest `requested_by` per `requested_by_id` and never includes `'SquareMusica DJ'` or other rows with `requested_by_id IS NULL`; `getArtistQueuersSince(artist, userIds, days)` counts distinct present `requested_by_id` with counted plays of that artist in the window and never matches rows whose `artist` is `NULL`; extend `test/persistence/migration.test.js`: an existing DB gains nullable `history.artist` idempotently and old rows read as `null`
- [ ] T045 [P] [US3] Extend `test/services/dj/lineWriter.test.js` and add context cases: a member fact is emitted only when count ≥ 3; absent members and opted-out members never appear in `allowedNames` or member facts; group facts never name anyone; a model line containing a known DJ name not in `allowedNames` is rejected; a line naming an opted-out present member is rejected; with no qualifying member facts the line is still accepted as a general music line; a next track queued by member C who has no history rows and has left the channel produces no `queuedBy` in the facts, and a model line naming C is rejected; the same happens when C is present but opted out; when C is present and opted in, `queuedBy` uses C's speakable name and C is in `allowedNames`
- [ ] T046 [P] [US3] Add `speakableName` cases to a new `test/services/dj/context.test.js`: emoji/symbols stripped, whitespace collapsed, names over 20 characters cut to the first word, emoji-only names return `null`
- [ ] T046a [P] [US3] Create `test/transports/voiceContext.test.js`: a `VoiceStateUpdate` where a member joins the bot's channel emits `voice:context` once; a leave emits it once; an update in an unrelated channel emits nothing; with no cached bot channel it emits nothing

### Implementation for User Story 3

- [ ] T047 [US3] Add `CREATE INDEX IF NOT EXISTS idx_history_url ON history(url)` to `src/persistence/schema.sql` and to the boot path in `src/persistence/db.js` for existing databases; add a nullable `artist TEXT` column to `history` in `schema.sql` plus a guarded `ALTER TABLE history ADD COLUMN artist TEXT` in `migrate()` following the existing pattern, and write it in `addToHistory` as `track.spotifyData?.artists?.[0] ?? track.channel ?? null`
- [ ] T048 [US3] Add to `src/persistence/db.js` reusing `COUNTED_PLAY`: `isShoutoutOptedOut(userId)`, `setShoutoutOptOut(userId, optedOut)` (insert-or-ignore / delete), `getShoutoutOptOuts()` → `Set<string>`, `getUserPlayCountsForUrl(url, userIds)` → `[{ userId, count }]` (`url = ?` and `requested_by_id IN (...)`), `getUserTopTrack(userId)` → `{ url, title, count } | null`, `getKnownMemberNames()` → `string[]` (rows with `requested_by_id IS NULL`, i.e. DJ picks, excluded); `getArtistQueuersSince(artist, userIds, days)` → number, counting distinct `requested_by_id` in `userIds` with counted plays where `artist = ?` (case-insensitive) in the last `days` local days; `NULL` artist never matches (depends on T047)
- [ ] T049 [P] [US3] Add `displayName: m.displayName` to each `connectedUsers` entry in `getChannelInfo` in `src/transports/discord/voiceManager.js` (R7)
- [ ] T050a [P] [US3] In `src/transports/discord/client.js` `VoiceStateUpdate`, call `musicManager.emitVoiceContext()` on every join or leave of the bot's channel, right after the `!leftBotChannel && !joinedBotChannel` early return and before the human-count branch, so it fires on both the cached and the fetch path (R7). Today it fires only from the inactivity-timer callback and `voiceDisconnected`
- [ ] T050 [US3] In `init()` of `src/services/dj/djService.js`, subscribe to the mediator event `voice:context` (sent on every join or leave of the bot's channel by T050a). On each event, discard a prepared line whose `namedUserIds` includes a member no longer in `connectedUsers` (FR-017), and let the theme engine re-check `NO_LISTENERS`. This event only makes discarding happen sooner; T029's speak-time re-check is what guarantees FR-017 (depends on T030, T050a)
- [ ] T051 [US3] Implement member and group facts in `src/services/dj/context.js`: `speakableName(displayName)` per R7; `present` built from `connectedUsers` with `optedOut` from `db.getShoutoutOptOuts()`; for present, opted-in members with a non-null speakable name emit `member` facts for counted plays of the next track (only when ≥ 3, FR-018) and their top track (only when ≥ 3); `group` facts are anonymous totals that may include opted-out members (FR-020); compute `allowedNames` (present, opted-in, referenced by a fact) and `forbiddenNames` (`db.getKnownMemberNames()` plus present opted-out display names, minus `allowedNames`); add a `queuedBy` field to a `track` fact only when the queuer (`requestedById`) is present, opted in, and has a non-null speakable name, using that speakable name, otherwise leave it out; DJ picks (`addedByDj`) get `queuedBy: 'the DJ'`; add every queuer's display name that was not allowed, plus their `requestedBy` username, to `forbiddenNames`, so a first-time queuer with no history rows is still covered (FR-017, FR-020) (depends on T048)
- [ ] T052 [US3] Add R6 validation step 3 to `src/services/dj/lineWriter.js`: reject any line whose text contains a `forbiddenNames` entry (case-insensitive, word-boundary match); set `namedUserIds` from allowed names that appear in the text (depends on T051)
- [ ] T053 [US3] Add `getShoutouts(userId)` → `{ enabled }` and `setShoutouts(userId, enabled)` to `src/services/dj/djService.js` (throws `DJ_UNAVAILABLE` when unconfigured; validates boolean; after writing, emits `musicManager.emit('dj:shoutouts', { userId, enabled })` exactly once whichever transport made the change, so every open surface of that member converges (Constitution III, FR-015); no `dj:state` broadcast since the preference is per-member); if a prepared line names that user and they opt out, discard it
- [ ] T054 [P] [US3] Add `GET /shoutouts/me` → `{ enabled }` and `PUT /shoutouts/me` `{ enabled }` to `src/transports/http/routes/dj.js` using the JWT user id
- [ ] T055 [P] [US3] Add `handleDjShoutouts(socket, { enabled }, ack)` to `src/transports/realtime/handlers.js` (throttle key `dj`), ack `{ enabled }`; add `DJ_SHOUTOUTS: 'dj:shoutouts'` to `events.js`; register in `src/transports/realtime/socketServer.js`; on connection join each socket with a `discord_id` to room `user:<discord_id>`, and add a `managerListeners` entry forwarding `dj:shoutouts` only to `io.to('user:' + userId)` as `dj:shoutouts { enabled }`
- [ ] T056 [P] [US3] Add `/dj shoutouts enabled:<true|false>` to `src/transports/discord/commands/dj.js` and `src/transports/discord/commands/register.js`; reply ephemerally stating the current value
- [ ] T057 [US3] Append the "Own shout-outs" row to the matrix in `test/transports/djParity.test.js`, and assert that a change made from Discord, HTTP or Socket results in exactly one `dj:shoutouts { enabled }` push to that member's `user:<id>` room and none to other members' sockets (depends on T054–T056)
- [ ] T058 [P] [US3] Create `web/src/components/dj/ListenerList.jsx` showing present members from `voice:context` / `initial:state` (display name, avatar) and add a "Shout-outs about me" toggle to `web/src/pages/Dj.jsx` that loads `GET /api/dj/shoutouts/me` once, saves via `dj:shoutouts`, and updates from `dj:shoutouts` pushes so a change made in Discord shows without refresh; wire `voice:context` and `setShoutouts` through `web/src/hooks/useSocket.js` and `web/src/context/SocketContext.jsx`

**Checkpoint**: US3 independent test passes; SC-003 is covered by T045's rejection tests without a live LLM.

---

## Phase 6: User Story 4 - Themed DJ mode builds and keeps the set going (Priority: P3)

**Goal**: A member starts a free-text theme; the DJ fills and tops up the queue to the lookahead with a history/new mix, keeps member requests ahead of its picks, attributes picks to the DJ, and reports stalls.

**Independent Test**: Empty queue, `/dj theme description:"classic rock road trip" lookahead:5` → music within 30 s and 5 upcoming DJ-attributed picks within 60 s; as tracks finish upcoming picks return to 5; a member song plays next; `/dj theme-stop` stops additions and keeps queued picks (quickstart §6).

### Tests for User Story 4 ⚠️

- [ ] T059 [P] [US4] Extend `test/music/queue.test.js`: `insertAt(index, track)` clamps to `[currentIndex + 1, length]` and sets `addedAt`; with `prioritizeMemberTracks = true`, `add()` of a non-DJ track inserts before the first upcoming `addedByDj` entry and multiple member adds keep FIFO order; with the flag `false` `add()` appends as today; `countUpcoming(t => t.addedByDj)` counts only entries after `currentIndex`
- [ ] T060 [P] [US4] Extend `test/persistence/migration.test.js`: an existing DB without `history.added_by_dj` gains it as `INTEGER NOT NULL DEFAULT 0` and migration is idempotent; extend `test/persistence/dj.test.js`: `getTopTracks({ userIds, limit })` excludes loop replays and DJ rows; `getDjSkipAward` ignores skip events with `target_user_id IS NULL`
- [ ] T061 [P] [US4] Create `test/services/dj/themeEngine.test.js` with `llm.chatJson` and `resolveSpotifyTrack` mocked: start on an empty queue tops up to the lookahead counting only `addedByDj` upcoming entries; existing upcoming member tracks are kept and not counted (FR-021a); each request asks for `needed + 4` picks with ≤ 60 history candidates, and the system prompt asks for about half of the picks from candidates when enough fit (FR-021b); unknown `candidateId` ignored; picks in `avoid`/`usedKeys` ignored; unresolvable new picks are dropped and replaced (FR-026); a batch emptied by dedupe triggers one `allowRepeats` retry (FR-025); zero playable tracks on start throws `NO_TRACKS_FOR_THEME` and no session exists; top-up stalls with `NO_LISTENERS`, `NOT_IN_VOICE`, `CAP_REACHED`, `SERVICE_UNAVAILABLE`, `THEME_EXHAUSTED` and resumes when the condition clears; debounce 1 s with one top-up in flight; member-queued tracks and every track that starts playing during the session are added to `usedKeys` and are never picked again (FR-025); `startTheme` resolves as soon as the first pick is in the queue, and the rest of the batch keeps resolving in the background (SC-005)
- [ ] T062 [P] [US4] Extend `test/services/dj/djService.test.js`: `startTheme` rejects empty or > 200-character trimmed theme, or a theme failing `contentFilter.isClean`, with `INVALID_THEME`, bot not connected with `NOT_IN_VOICE`, breaker open with `SERVICE_UNAVAILABLE`, themed cap reached with `CAP_REACHED`; `startTheme` while running changes theme, keeps `usedKeys` and sets `introPending`; `stopTheme` clears `prioritizeMemberTracks`, keeps queued picks, and broadcasts once; themed mode works with commentary disabled (silent build)
- [ ] T062a [P] [US4] Extend `test/services/dj/linePlanner.test.js` with themed-intro cases (FR-006 exception, FR-028): with `introPending` set on an empty queue, the intro is spoken over the first themed track even though it is not a transition; after a theme change, the intro is spoken over the next track to start; neither intro changes `transitionsSinceSpoken`; with commentary disabled, `introPending` is cleared and nothing is spoken

### Implementation for User Story 4

- [ ] T063 [US4] Add to `src/core/queue.js` (no new imports): `insertAt(index, track)` clamped to `[currentIndex + 1, length]` setting `addedAt`; `prioritizeMemberTracks` boolean default `false`, making `add(track)` with `!track.addedByDj` insert before the first upcoming `addedByDj` entry; `countUpcoming(predicate)`; ensure `addedByDj` survives in `queue:update` payloads
- [ ] T064 [US4] Add `added_by_dj INTEGER NOT NULL DEFAULT 0` to `history` in `src/persistence/schema.sql` and a guarded `ALTER TABLE history ADD COLUMN added_by_dj INTEGER NOT NULL DEFAULT 0` in `migrate()` in `src/persistence/db.js` following the existing pattern; write it from `track.addedByDj` in `addToHistory`; add `getTopTracks({ userIds?, limit })` → `[{ url, title, artist, count, duration, thumbnail }]` using `COUNTED_PLAY` (`artist` from T047, may be `null`); add `AND e.target_user_id IS NOT NULL` to `getDjSkipAward`; `incrementDjUsage(day, 'themed_tracks')` already exists from T013
- [ ] T065 [US4] Pass `addedByDj` through `addToHistory` in `src/core/musicManager.js` so DJ picks are recorded with `requested_by = 'SquareMusica DJ'`, `requested_by_id = NULL`, `added_by_dj = 1` (FR-027) (depends on T064)
- [ ] T066 [US4] Create `src/services/dj/themeEngine.js` implementing R8: session `{ theme (trimmed, 1–200 characters), startedBy { id, name }, startedAt, origin { transport: 'discord'|'http'|'socket', channelId? }, usedKeys: Set, status: 'running'|'stalled', reason: null|'NO_LISTENERS'|'NOT_IN_VOICE'|'CAP_REACHED'|'SERVICE_UNAVAILABLE'|'THEME_EXHAUSTED', introPending }`; `topUp()` computes `needed = lookahead − queue.countUpcoming(t => t.addedByDj)`, builds ≤ 60 deduped history candidates from present opted-in members' `getTopTracks` plus server top tracks, calls `llm.chatJson` (`temperature 0.7`, `timeoutMs 20000`) with the contracts §5b payload and a system prompt that asks for about half of the picks from the history candidates when enough fit the theme, and all new songs when none fit (FR-021b; a target, not validated), adds history picks directly and resolves new picks through `resolveSpotifyTrack({ title, artists: [artist] })` from `src/services/resolver.js` before adding, tags picks `{ addedByDj: true, requestedBy: 'SquareMusica DJ', requestedById: null }`, history candidates carry `artist` or `null`; records keys in `usedKeys` — the URL for every pick, plus normalised `artist - title` when the artist is known — — also adding the key of every member-queued track seen in `queue:update` and every track seen in `track:change` while the session exists (FR-025) —; adds each pick to the queue as soon as it resolves (not after the whole batch) and exposes a promise for the first added pick so the caller can start playback early (SC-005); increments `themed_tracks` usage per added pick, retries once with `allowRepeats` when dedupe empties a batch; triggered on `track:change`/`queue:update` debounced 1 s, one in flight; sets `stalled` + reason when blocked and back to `running` when cleared (depends on T063, T064)
- [ ] T067 [US4] Add `startTheme({ theme, lookahead? }, actor, origin)` and `stopTheme(actor)` to `src/services/dj/djService.js`: validate theme (trimmed 1–200 characters and `contentFilter.isClean`, else `INVALID_THEME`), optional lookahead (`INVALID_LOOKAHEAD`, persisted via `setSettings`), `musicManager.getPlayerState().connected` else `NOT_IN_VOICE` (do NOT copy the `musicManager.guildId || process.env.GUILD_ID` idiom), breaker open → `SERVICE_UNAVAILABLE`, themed cap reached → `CAP_REACHED`; first start sets `queue.prioritizeMemberTracks = true`, runs the first top-up and awaits only its first added pick — calling `musicManager.ensurePlaying()` (T019) as soon as it lands — or the batch's end; throws `NO_TRACKS_FOR_THEME` and discards the session if the batch ended with zero tracks added; never imports `src/transports/` or reads `process.env.GUILD_ID`; existing session → change theme (`introPending = true`, keep `usedKeys`); `stopTheme` discards the session and clears the flag; include `ThemeState` in `getState()`; broadcast once per mutation; on bot leaving voice mark `stalled NOT_IN_VOICE` (depends on T066; `contentFilter.js` from T028)
- [ ] T068 [US4] Add the themed intro to `src/services/dj/linePlanner.js` and `src/services/dj/lineWriter.js`: when `introPending`, the next `track:change` to a non-null track is due whether or not it is a transition (FR-006 exception) — so on an empty queue the intro is spoken over the first themed track — and the prompt asks for a one-or-two-sentence intro to the theme; the intro does not reset `transitionsSinceSpoken`; start preparing the intro as soon as `introPending` is set; clear `introPending` once spoken or if commentary is disabled (FR-028). (depends on T062a)
- [ ] T069 [P] [US4] Add `POST /theme` `{ theme, lookahead? }` → 200 `DjState` and `DELETE /theme` → 200 `DjState` to `src/transports/http/routes/dj.js` with `origin = { transport: 'http' }`, mapping `INVALID_THEME` 400, `NOT_IN_VOICE` 409, `NO_TRACKS_FOR_THEME` 422, `SERVICE_UNAVAILABLE` 503, `CAP_REACHED` 429
- [ ] T070 [P] [US4] Add `handleDjThemeStart` (`dj:theme:start` `{ theme, lookahead? }`) and `handleDjThemeStop` (`dj:theme:stop`) to `src/transports/realtime/handlers.js` with throttle key `dj` and `origin = { transport: 'socket' }`; add both names to `events.js` and register them in `src/transports/realtime/socketServer.js`
- [ ] T071 [P] [US4] Add `/dj theme description:<text, max 200> [lookahead:<5|10>]` and `/dj theme-stop` to `src/transports/discord/commands/dj.js` and `register.js` with `origin = { transport: 'discord', channelId: interaction.channelId }`; `/dj theme` MUST call `interaction.deferReply()` before `startTheme` (the first top-up can take up to 20 s, past Discord's 3 s limit) and answer with `editReply`, as `commands/playback.js:51` does; in `dj.js` subscribe to `dj:state` and when the session `origin.transport === 'discord'` transitions to `stalled`, post one message per stall to `origin.channelId` stating the reason (FR-029, transport affordance only)
- [ ] T072 [US4] Append the "Start / change theme" and "Stop theme" rows to the matrix in `test/transports/djParity.test.js` (depends on T069–T071)
- [ ] T073 [P] [US4] Create `web/src/components/dj/ThemeControl.jsx`: theme text input (max 200), lookahead 5/10, Start/Change and Stop buttons emitting `dj:theme:start`/`dj:theme:stop`; shows active theme, who started it, `running`/`stalled` with a human-readable reason; render it in `web/src/pages/Dj.jsx` and wire actions through `web/src/hooks/useSocket.js` / `SocketContext.jsx`
- [ ] T074 [P] [US4] Show a "DJ" attribution badge instead of a member name when `addedByDj` is true in `web/src/components/QueueItemDefault.jsx` and `web/src/components/QueueItemCompact.jsx`

**Checkpoint**: US4 independent test passes; DJ picks never appear in member stats on the Stats page (FR-027).

---

## Phase 7: Polish & Cross-Cutting Concerns

**Purpose**: Documentation, gates and live validation across all stories.

- [ ] T075 [P] Document the DJ in `README.md`: the env group (all four or none, optional vars and defaults), `/dj` subcommands, `npm run register`, the ElevenLabs `pcm_48000` plan-tier caveat and fallback, and a link to `docs/ADR-002-dj-audio-mixing.md`
- [ ] T076 [P] Verify layering by grep: no file under `src/core/` or `src/services/dj/` imports from `src/transports/`; no new `guildId || process.env.GUILD_ID` occurrences; fix any found
- [ ] T077 Run `npm run lint && npm run format:check && npm test` and `cd web && npm run lint && npm run format:check && npm run build`; fix failures without weakening `test/import-resolution.test.js`
- [ ] T078 Build the Docker image (`docker build -t kasperhonore/discord-music .`) and run it with no DJ vars; confirm `/api/health` returns `{"status":"ok"}` and `GET /api/dj` returns `{ "available": false }`
- [ ] T079 Run quickstart.md §2–§8 against a live guild, ElevenLabs account and LiteLLM endpoint; record results (including whether `pcm_48000` was accepted, and the T031 `spoken / due` ratio against SC-002's 90%) in `specs/002-ai-dj-host/quickstart.md` or the PR description

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: none.
- **Foundational (Phase 2)**: after Setup. Blocks all stories.
- **US1 (Phase 3)**: after Foundational.
- **US2 (Phase 4)**: after Foundational. Transport work is independent of US1; its end-to-end check ("the next DJ line is spoken at the fourth transition") needs US1.
- **US3 (Phase 5)**: after US1 (extends `context.js` and `lineWriter.js`). Its transport tasks follow US2's files (`routes/dj.js`, `commands/dj.js`, `handlers.js`, `Dj.jsx`).
- **US4 (Phase 6)**: after US2 (transport files, `Dj.jsx`). Works without US3, but history candidates use US3's opt-out set if present (otherwise treat everyone as opted in). Intro speech (T068) and theme validation (T067 uses `contentFilter.js` from T028) need US1.
- **Polish (Phase 7)**: after the stories being shipped.

### Within-phase ordering

- Foundational: T012 → T013 → T021 → T022 → T023; T014 + T015 → T016; T010 → T011; T019 → T021; T019 → T019a.
- US1: T027 → T028 → T029 → T030 → T031; T019 → T029 (`peekNext`); T019 → T030 (`resetCounter` wiring uses settings).
- US2: T034 → T035, T037, T039; T035 → T036; T037 → T038; T039 → T040; T042 → T043.
- US3: T047 → T048 → T051 → T052; T050a → T050; T030 → T050; T053 before T054–T056; T057 after T054–T056.
- US4: T028 → T067 (`contentFilter.isClean`); T063, T064 → T066 → T067 → T068; T062a before T068; T019 (`ensurePlaying`) → T067; T064 → T065; T072 after T069–T071.

### Parallel Opportunities

- Setup: T001, T002 together.
- Foundational tests T004–T009 all together; then T014, T015, T017, T018 together (separate files).
- US1 tests T024–T026 together; T027 in parallel with tests.
- US2: T032–T034, T041, T042 together (separate files); then T035, T037, T039 together after T034.
- US3: T044–T046, T046a, T049, T050a together; T054–T056, T058 together after T053.
- US4: T059–T062, T062a together; T069–T071, T073, T074 together after T067.

---

## Parallel Example: User Story 1

```bash
# Tests first, together:
Task: "Create test/services/dj/lineWriter.test.js"
Task: "Create test/services/dj/linePlanner.test.js"
Task: "Create test/services/dj/djService.test.js (settings/breaker/caps part)"
Task: "Create src/services/dj/context.js"   # independent of the tests
```

## Parallel Example: User Story 2

```bash
Task: "Create src/services/dj/messages.js"
Task: "Create web/src/pages/Dj.jsx"
Task: "Extend web/src/hooks/useSocket.js"
# After messages.js lands:
Task: "Create src/transports/http/routes/dj.js"
Task: "Add handleDjSettings to src/transports/realtime/handlers.js"
Task: "Create src/transports/discord/commands/dj.js"
```

## Parallel Example: User Story 4

```bash
# After T067 (startTheme/stopTheme) lands:
Task: "POST/DELETE /theme in src/transports/http/routes/dj.js"
Task: "dj:theme:start / dj:theme:stop in src/transports/realtime/handlers.js"
Task: "/dj theme, /dj theme-stop in src/transports/discord/commands/dj.js"
Task: "Create web/src/components/dj/ThemeControl.jsx"
Task: "DJ badge in web/src/components/QueueItemDefault.jsx and QueueItemCompact.jsx"
```

---

## Implementation Strategy

### MVP First (User Story 1)

1. Phase 1 Setup → Phase 2 Foundational (the audio pipeline is the riskiest part; validate it before anything else by playing tracks on the PCM path with no overlay).
2. Phase 3 US1 → validate with settings set directly in the DB.
3. **STOP and VALIDATE**: quickstart §2 and §3.

### Incremental Delivery

1. Setup + Foundational → unconfigured path unchanged, PCM path proven.
2. US1 → DJ speaks (MVP).
3. US2 → members control it on every surface (ship US1 + US2 together as the first release, both P1).
4. US3 → shout-outs.
5. US4 → themed mode.

### Parallel Team Strategy

After Foundational: developer A takes US1, developer B takes US2's transports and web page. Once both land, A takes US3 and B takes US4.

---

## Notes

- [P] tasks touch different files and have no dependency on incomplete tasks.
- Every transport is a thin adapter over `djService` using the shared `messages.js` table; `djParity.test.js` grows with each story (Principle III).
- Playback code never awaits the DJ (FR-008, SC-008).
- DJ line text is never shown on any surface (FR-001a).
- Commit after each task or logical group; stop at any checkpoint to validate the story on its own.

---

## Phase 8: Convergence

- [ ] T080 Isolate the DJ from the playback call path in `src/services/dj/djService.js`: wrap the `track:change` and `queue:update` listeners registered in `startPlanner()` in try/catch that logs at `warn` and records the failure, so a synchronous throw in the planner (settings/voice-context getters, `player.overlay`, opt-out reads) can never propagate into `player.play()`'s catch (`src/core/player.js:186-191`) and tear down the track that just started; add a `test/services/dj/djService.test.js` case where the planner throws on `track:change` and playback is unaffected per FR-032, SC-008 (partial)
- [ ] T081 In `src/services/dj/linePlanner.js`, make `prepare()` a no-op when a line is already prepared for the same predicted next key and epoch, so `resetCounter()` (interval change or DJ enable late in a track) does not trigger a second LLM + TTS call and a second `dj_usage.lines` increment for a line that is never spoken; cover in `test/services/dj/linePlanner.test.js` per T029 / FR-033 (partial)
- [ ] T082 In `src/services/dj/linePlanner.js`, re-arm preparation when a silence condition that blocked it clears before the transition (playback resumed after pause, a human joins via `voice:context`, DJ enabled, breaker closes), so a due transition is not dropped as `late` solely because the `duration − 30 s` timer fired while silent; cover in `test/services/dj/linePlanner.test.js` per SC-002 (partial)
- [ ] T083 Format the cap reset time in `web/src/pages/Dj.jsx` in the server's configured timezone rather than the browser's (include the server timezone or a pre-formatted `resetsAtLocal` HH:MM in `DjState.caps` from `src/services/dj/djService.js`, reusing the formatter in `src/services/dj/messages.js`), so the dashboard and `/dj status` / `CAP_REACHED` text always show the same reset time per FR-034, Constitution III (contradicts)
- [ ] T084 Broadcast `dj:state` from `src/services/dj/djService.js` when usage counts change (after each `incrementDjUsage`), not only when a `reached` flag flips, so the dashboard's `used / limit` stays current without a refresh per FR-015, FR-034 (partial)
- [ ] T085 Distinguish "loading/disconnected" from "DJ not configured" in `web/src/hooks/useSocket.js` and `web/src/pages/Dj.jsx`: start `djState` as `null` (unknown) and show a loading/disconnected state until `initial:state` arrives, so a configured server is never reported as "The DJ isn't set up on this server." on page load or reconnect per FR-030 (partial)
- [ ] T086 Bring non-contract error codes in line with contracts §2: make `setSettings` reject a non-boolean `enabled` with a `DjError` (not a plain `TypeError`) in `src/services/dj/djService.js`, either add `INVALID_BODY` to `src/services/dj/messages.js` (and contracts §2 via a spec update) or map body-shape errors onto existing codes in `src/transports/http/routes/dj.js` and `src/transports/realtime/handlers.js`, and give the socket throttle rejection a `{ code, message }` payload; extend `test/transports/djParity.test.js` so all three transports map these identically per contracts §2, Constitution III (unrequested)
- [ ] T087 Wire the speak-time opt-out re-check in `src/services/dj/djService.js` `startPlanner()` by passing `getOptOuts: () => db.getShoutoutOptOuts()` to `createLinePlanner` (once T048 adds it), replacing the `() => new Set()` fallback in `src/services/dj/linePlanner.js:33`, and assert it in `test/services/dj/linePlanner.test.js` per T029, FR-020 (partial)
- [ ] T088 Stop `quantitiesIn` in `src/services/dj/lineWriter.js` from treating digits that are part of a cited-or-context track title/artist (e.g. "22", "7 Rings", "Blink-182") as unsupported quantities: strip the previous/next track title and artist strings from the line before quantity extraction, regardless of whether `f-next`/`f-prev` is in `factIds`; add cases to `test/services/dj/lineWriter.test.js` per FR-005, T028(a) (partial)
- [ ] T089 Log distinct drop reasons `paused` and `disabled` (instead of mapping them to `stale`, and instead of logging nothing at transition time) in `src/services/dj/linePlanner.js` per T031 (partial)
- [ ] T090 Add tests for wiring not covered today: `/api/dj` is mounted in `src/transports/http/index.js` with `mutationLimiter` applied to PATCH and not GET; `initial:state` carries `dj` (and `{ available: false }` when the service was never constructed); Discord `/dj status` output (health, caps used/limit, reset time) and the `CAP_REACHED` HH:MM text from `messages.js`; place them in `test/http/routes/dj.test.js` and `test/transports/djParity.test.js` per T032, T036, FR-034 (partial)
- [ ] T091 Decide on `MusicPlayer.overlay()` returning `true` while the track is Buffering (`src/core/player.js:100-110`), which goes beyond contracts §4 ("false if nothing is playing"): either record the behaviour in `docs/ADR-002-dj-audio-mixing.md` as an accepted deviation or make it return `false` while buffering, per plan: player seam / contracts §4 (unrequested)
