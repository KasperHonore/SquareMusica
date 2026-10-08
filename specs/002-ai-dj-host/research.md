# Research: AI DJ Host

**Feature**: [spec.md](./spec.md) | **Plan**: [plan.md](./plan.md) | **Date**: 2026-10-06

Each entry: **Decision** / **Rationale** / **Alternatives considered**. Codebase facts are
cited as `file:line` against `main` at 8333ca6.

---

## R1. Ducking: how the DJ voice gets mixed over the music

**Finding.** The bot cannot do this today. `core/player.js:110` builds every resource as
`createAudioResource(stream, { inputType: streamResult.type })` with
`StreamType.Arbitrary` (`integrations/youtube.js:405`). `@discordjs/voice` then runs FFmpeg
and Opus encoding internally, so our code never sees PCM. There is no `inlineVolume` and
no volume feature anywhere in `src/` or `web/src/`. An `AudioPlayer` plays exactly one
resource, and `@discordjs/voice` has no mixer.

**Decision.** When the DJ is configured, the music path becomes:

```
yt-dlp ──► ffmpeg (-f s16le -ar 48000 -ac 2) ──► DuckingMixer (Transform) ──► createAudioResource(StreamType.Raw)
                                                       ▲
                                     overlay(pcmBuffer) │ DJ line, 48 kHz s16le stereo
```

- `integrations/youtube.js` gains `getPcmStream(url)`. It wraps the existing `getStream`
  output in our own FFmpeg child and folds the FFmpeg process into the same idempotent
  `cleanup`. The startup watchdog and drain semantics are unchanged.
- `core/audioMixer.js` (new, no imports beyond `node:stream`) exports `DuckingMixer`, a
  `Transform` over s16le stereo frames:
  - It passes music through untouched when no overlay is set.
  - It accepts `overlay(buffer)`. For each chunk it applies a smoothed music gain
    (1.0 → 0.3, about −10 dB, ramped over 200 ms), adds the overlay samples, and clamps to
    int16. When the overlay is exhausted it ramps back to 1.0 over 300 ms, which keeps the
    restore within FR-003's 1 s limit.
  - `cancelOverlay()` drops the remaining overlay and ramps back up immediately.
  - A partial frame left at a chunk boundary is carried into the next chunk.
- `MusicPlayer` creates one mixer per track. It exposes `overlay(buffer)` and
  `cancelOverlay()`, and calls `cancelOverlay()` itself from `pause()`, `stop()` and
  `play()`. FR-009 therefore holds for every transport without per-transport code.
- **Short next track.** The overlay lives inside the track's own mixer, so it ends when
  that track's PCM ends and is destroyed with the resource. It cannot carry over into the
  following track.
- **Onset latency.** The mixer is a pull-based Transform, so ducking starts at the next
  chunk the voice pipeline reads. Read-ahead downstream (Opus encoder plus resource
  buffer) is a few hundred ms. Setting the mixer's `highWaterMark` to 5 frames
  (5 × 3840 B ≈ 100 ms) keeps the extra latency small, well inside FR-003's 2 s window.

**Dual path.** If the DJ is *not* configured (FR-030), `player.play` keeps today's
`Arbitrary` path byte-for-byte. Operators who never enable the DJ take no new risk from
our FFmpeg child. When it is configured, every track uses the PCM path, whether
commentary is on or off, so enabling the DJ mid-session takes effect at the next track
without switching pipelines.

**Volume edge case.** The spec's "volume changes during a line" edge case has nothing to
act on, because the bot has no volume control. The ducking gain is relative to unity. If a
volume feature is added later, it must multiply into the same mixer gain. Record this as a
follow-up, not work for this feature.

**Alternatives considered**
- *FFmpeg `amix`/`sidechaincompress`*: both inputs must exist when FFmpeg starts.
  Inserting a voice mid-stream means restarting FFmpeg, which causes a gap or seek.
  Rejected.
- *`inlineVolume` only*: can duck the music but cannot layer a second source. Rejected.
- *A second AudioPlayer for the voice*: a connection subscribes to one player at a time.
  Rejected.
- *`node-audio-mixer` / `@wetalabs/mixer`*: these add a dependency for about 80 lines of
  code we need exact control over (the ramp envelope and cancel semantics). Rejected,
  which keeps Principle V's "no new runtime deps" posture.

## R2. FFmpeg binary for the PCM transcode

**Decision.** Resolve FFmpeg the way `@discordjs/voice`'s prism-media already does:
`ffmpeg-static` (already a dependency, `package.json:36`), falling back to `ffmpeg` on
`PATH`. The Docker image installs system FFmpeg (`Dockerfile:41`). Arguments:
`-hide_banner -loglevel error -i pipe:0 -f s16le -ar 48000 -ac 2 pipe:1`.

**Rationale.** No new binary. CPU is unchanged, because `Arbitrary` already spawns exactly
this FFmpeg inside the library; we are moving it, not adding one.

**Alternatives considered**: have yt-dlp post-process to PCM. That is slower to start and
loses the existing watchdog semantics.

## R3. Text-to-speech (ElevenLabs)

**Decision.**
- Call `POST https://api.elevenlabs.io/v1/text-to-speech/{voice_id}?output_format=pcm_48000`
  with plain `fetch`, header `xi-api-key`, body `{ text, model_id, voice_settings }`.
  `model_id` defaults to `eleven_flash_v2_5` (lowest latency, about 75 ms model time,
  half the per-character price).
- Use the non-streaming endpoint and buffer the whole clip (15 s at 48 kHz mono ≈ 1.4 MB).
- Convert mono to stereo by duplicating samples: no resampler and no FFmpeg.
- Timeout: `AbortSignal.timeout(8000)`.

**Rationale.**
- Lines are prepared during the previous track (R5), so streaming buys nothing.
- A buffered clip has a known length, so the 15 s cap (FR-002) is checked exactly:
  `bytes / (48000 × 2) ≤ 15`.
- `pcm_48000` already matches Discord's rate.
- Flash v2.5 turns text normalization off, so the LLM is told to write numbers out as
  words (R6).

**Errors.**
- `401` with `detail.status = quota_exceeded`, or a bad key: open the circuit breaker
  (R9), don't retry.
- `429` (`concurrent_limit_exceeded` / `rate_limit_exceeded`): one retry after 1 s, then
  drop the line.
- `422`: log and drop the line.

**Plan-tier risk.** The docs gate 44.1 kHz PCM behind Pro and don't say whether
`pcm_48000` is gated too. Fallback: when the API rejects the format, request `pcm_24000`
and upsample by sample doubling (cheap and adequate for speech). Quickstart step 2 checks
this against the operator's real account.

**Alternatives considered**: the `@elevenlabs/elevenlabs-js` SDK, which adds a dependency
for one POST. Rejected.

## R4. LLM access (LiteLLM-compatible)

**Decision.** Plain `fetch` to `${DJ_LLM_BASE_URL}/chat/completions`:
- `Authorization: Bearer ${DJ_LLM_API_KEY}` when the key is set. The key is optional,
  because a LiteLLM proxy may sit on a private network without one.
- `response_format: { type: "json_object" }`.
- `temperature` 0.9 for lines, 0.7 for picks.
- `AbortSignal.timeout(10000)` for lines, `20000` for picks.
- No SDK retries; R9's breaker handles repeated failure.

The bot always parses and validates the JSON itself and treats malformed output as a
dropped line or batch. `json_schema` strict mode depends on the model behind the proxy,
so it is not relied on.

**Rationale.** It's an OpenAI-compatible endpoint that needs only one call shape. The
`openai` npm package's defaults (10-minute timeout, 2 retries) would have to be overridden
anyway.

**Alternatives considered**: the `openai` package with a custom `baseURL`. It works
equally well but is a new dependency. Rejected.

## R5. When lines are prepared and spoken

**Decision.** `services/dj/djService.js` listens to the mediator's `track:change` event:

1. **Transition counter.** Every non-null `track:change` that follows another track is a
   transition (natural end, skip or loop replay alike). A per-process counter
   `transitionsSinceSpoken` is incremented. The DJ speaks when the counter reaches the
   interval N (FR-006). A *dropped* line does not reset the counter, so the DJ tries again
   at the next transition.
2. **Prepare ahead.** When track *k* starts and transition *k→k+1* will be due, a
   preparation job is scheduled for `max(0, duration − 30 s)` into track *k*, or
   immediately when the duration is unknown or under 30 s. The job snapshots the
   *predicted* next track (`queue.peekNext()`, which honours loop mode) and stores
   `{ forUrl/forKey, text, pcm }`.
3. **Re-prepare on change.** On `queue:update`, if the predicted next track no longer
   matches the prepared `forKey`, discard the line and re-prepare if time allows. This
   handles a member queueing ahead of DJ picks (FR-024) or reordering.
4. **Speak.** On the next `track:change`, if the prepared line's `forKey` matches the
   track that actually started, call `player.overlay(pcm)`. If preparation is still in
   flight, wait at most 2 s after track start (FR-003), then drop it. A stale line (key
   mismatch, e.g. after rapid skips) is discarded, never queued (edge case). Track start is
   never delayed (FR-008).
5. **Silence conditions.** The DJ doesn't prepare or speak when it's disabled, the daily
   line cap is reached, the breaker is open, there is no human in the voice channel
   (FR-010, read from `musicManager.getVoiceContext().connectedUsers`), the queue has no
   next track (edge case), or playback is paused.

**Themed intro (FR-028).** Starting or changing a theme sets `introPending`. The next
track to start is then due, whether or not it is a transition and regardless of the
counter, and its line is an intro to the theme. The intro does not reset the counter.
The DJ only ever talks over the opening of a track (FR-003), so the intro plays over the
first themed or next track, not at the instant the command runs.

**Track key.** `url` when the track is resolved, else `spotifyData.spotifyId`, else
`title|addedAt`. Lazily resolved Spotify tracks have `url: null` until played.

**Alternatives considered**: generating at track start. A 1–3 s LLM call plus TTS would
blow FR-003's 2 s window, so this was rejected.

## R6. Grounding: making every claim true (FR-005, FR-016–FR-020)

**Decision.** The LLM never sees raw history. The bot builds a small **facts list**
deterministically, and the prompt allows only those facts:

- `track` facts: the previous and next track (title, channel/artist), plus who queued it
  only when that member is present, opted in, and has a speakable name. Otherwise the
  queuer's names go to `forbiddenNames`.
- `member` facts: for each *present, not-opted-out* human, their counted plays of the next
  track (from `history` with `COUNTED_PLAY`, so loop replays and DJ picks are excluded,
  FR-018). A fact is emitted only when the count is ≥ 3. Also their single most-played
  track, when ≥ 3.
- `group` facts: e.g. how many present members have queued the next track's artist this
  week (from the new nullable `history.artist`; rows without an artist never match). Members are not named; opted-out members count only toward anonymous totals
  (FR-020).
- `theme` fact when themed mode is active.

There are deliberately no session or recent-history facts: FR-004 limits lines to the
previous and next track, present members' history with them, and the theme, and session
recaps are out of scope for v1.

New db reads (in `persistence/db.js`, reusing `COUNTED_PLAY`): `getUserPlayCountsForUrl`,
`getUserTopTrack`, `getArtistQueuersSince`. These need a new index on `history(url)`.

**Prompt contract** (see [contracts/dj-api.md](./contracts/dj-api.md) §5). The model
returns `{ "line": string, "factIds": string[] }`.

**Validation before TTS.** The line is dropped if any check fails:
1. 1–2 sentences, ≤ 240 characters.
2. Every `factIds` entry exists.
3. The text contains no *forbidden name*: the display name of any known DJ from history,
   or any present opted-out member, that isn't in the allowed-names set (present,
   opted-in, and referenced by a used fact).
4. It isn't an exact repeat of any of the last 20 lines (FR-007).

The last 5 lines are also passed in the prompt to reduce near-repeats.

**Rationale.** Validation makes SC-003 testable without an LLM: tests feed canned model
output and assert that fabricated names are rejected.

**Alternatives considered**
- *Trusting the prompt alone*: not verifiable. Rejected.
- *Letting the LLM query history through tools*: unbounded, and leaks data on opted-out
  members. Rejected.

## R7. Member names

**Finding.** `voiceManager.getChannelInfo` (`transports/discord/voiceManager.js:130-153`)
returns `{ id, username, avatar }` and filters out bots.

**Decision.**
- Add `displayName: m.displayName` to each `connectedUsers` entry. The guild member is
  already in `channel.members` through voice states, so no `GuildMembers` intent is
  needed.
- The DJ uses a **speakable name**: strip emoji and symbols, collapse whitespace, cut to
  the first word if over 20 characters. If nothing pronounceable is left, the member is
  treated as unnamed (edge case).
- **Membership events.** Today `VoiceStateUpdate` (`client.js:48-120`) calls
  `musicManager.emitVoiceContext()` only inside the inactivity-timer callback, i.e. when
  the bot leaves. It must also call it on **every** join or leave of the bot's channel,
  after the early `!leftBotChannel && !joinedBotChannel` return. That is a transport-layer
  change to `client.js`, not an existing behaviour. The DJ relies on it to discard
  prepared lines that name a departed member, to resume themed top-up when someone rejoins
  (`NO_LISTENERS`), and to keep the dashboard listener list current.
- **Speak-time re-check (FR-017).** A line is prepared up to 30 s ahead, and an event can
  be missed, so the planner also re-reads `getVoiceContext()?.connectedUsers` and the
  opt-out set immediately before `player.overlay()`. If any `namedUserIds` entry is absent
  or opted out, the line is dropped (reason `stale-member`). The event is an optimisation;
  this check is the guarantee.

## R8. Themed mode: sourcing, ordering, attribution

**Picks (FR-021b, FR-025, FR-026).**

*Inputs.* Each top-up asks the LLM for `needed + 4` picks. The prompt carries:
- The theme.
- Up to 60 **history candidates**: present opted-in members' top tracks plus the server's
  top tracks, deduplicated, each with an id.
- Titles already used in this themed session.

*Response.* `{ picks: [{ candidateId } | { artist, title }] }`. The prompt targets about
half from candidates when enough fit.

*Resolving picks.*
- **Adding to the queue.** Every pick, history or new, is added through
  `musicManager.addToQueue(track)`, never `queue.add` directly, so each add emits
  `queue:update` and every surface converges (Constitution III, FR-015). Picks are
  added already resolved, so the lazy-resolution lookahead is not needed for them.
- **History picks** already have a playable `url`, so they are added directly.
- **New picks** go through `resolveSpotifyTrack({ title, artists: [artist] })`
  (`services/resolver.js:242`). That reuses the existing scored YouTube match and LRU
  cache, and is resolved *before* adding, so an unplayable pick is discarded and replaced
  (FR-026) instead of becoming a dead queue entry.

*Dedupe.* The session keeps a set of track keys plus normalised `artist - title` (when
the artist is known; history candidates may have a `null` artist). If
de-duplication empties a batch, one more request runs with the "allow repeats" note
(FR-025 fallback).

**Lookahead (FR-022).** Count upcoming entries with `addedByDj === true`. Top-ups are
triggered on `queue:update` and `track:change`, debounced 1 s, with one top-up in flight
at a time. They pause when no human is present, the bot isn't in voice, or the themed-track
cap is reached.

**Ordering (FR-024).** `core/queue.js` gets `insertAt(index, track)` and a flag
`prioritizeMemberTracks`. When the flag is set, `add(track)` for a track without
`addedByDj` inserts it before the first upcoming `addedByDj` entry instead of appending.
Member requests therefore stay in FIFO order among themselves, ahead of DJ picks. The
rule lives in the one `Queue` every transport uses, so parity needs no per-transport code.
The DJ service sets the flag on theme start and clears it on stop. After stop, leftover DJ
picks keep their place and new member songs append normally (US4 scenario 4).

**Shuffle and clear during themed mode (FR-024a, FR-024b).** Shuffling would mix DJ
picks in among member requests and break FR-024. `musicManager.shuffleQueue()` therefore
refuses while `queue.prioritizeMemberTracks` is set. That flag is already the
themed-mode signal inside `core/`, so no new import is needed. A clear, or a stop (which
also empties the queue), would otherwise be undone within a second by the next top-up.
`musicManager` gets an injected `setOnQueueCleared(fn)` hook that `djService` wires to
`stopTheme`. It is called before `queue:update` goes out. Each top-up is stamped with its
session `id` and drops any pick that resolves after its session has ended. Discord
`/shuffle` and `/stop` currently change the queue directly, so they are moved onto the
mediator, the same fix `/clear` got in T019a.

**Existing queue at start (FR-021a).** DJ picks are appended, so earlier upcoming tracks
naturally play first. They aren't `addedByDj`, so they don't count toward the lookahead.

**Attribution (FR-027).**
- DJ picks carry `requestedBy: 'SquareMusica DJ'`, `requestedById: null`,
  `addedByDj: true`.
- A new column `history.added_by_dj` records it. `requested_by_id IS NULL` already
  excludes the row from `COUNTED_PLAY`, but the column makes the reason explicit (NULL
  otherwise means a pre-stats row, `schema.sql:11-16`).
- **Awards gap:** skip events on DJ picks would carry `target_user_id = NULL`.
  `getDjSkipAward` must exclude NULL targets so "the DJ" can't become a group.

**Failure notices (FR-029).** Themed state carries `status: 'running' | 'stalled'` and a
`reason`, which is broadcast in `dj:state` so every dashboard shows it. If the session was
started from Discord, one message is also posted to the originating text channel per
stall, which is the transport's own affordance. Theme-start failure is reported in the
command or HTTP/socket reply.

## R9. Outages, caps and the circuit breaker (FR-032–FR-034, SC-008)

**Breaker.** After 3 consecutive failures (any of LLM, TTS, or resolve-all-failed), the
breaker opens for 5 minutes. It then lets one attempt through: success closes it, failure
re-opens it. `quota_exceeded` opens it for 30 minutes. Breaker state is in `dj:state` as
`health: 'ok' | 'degraded'`. Every failure is logged at `warn` with its cause. Playback
code never awaits the DJ, so no failure can reach playback (SC-008).

**Daily caps.** Operator env `DJ_DAILY_LINE_CAP` (default 150) and
`DJ_DAILY_THEME_TRACK_CAP` (default 100). Usage is kept in table `dj_usage(day, lines,
themed_tracks)`, with `day = date('now','localtime')` in the configured `TZ` (feature
001's R10 guarantees `localtime` honours it).

*When a line counts.* It counts when **TTS succeeds** (the cost is incurred), not when
the overlay plays. Lines spoken therefore never exceed the cap. This is stricter than the
spec's wording "lines spoken", and only matters for a line generated and then dropped.

*When the cap is reached.* `dj:state.caps.{lines,themedTracks}.reached` and `resetsAt`
(next local midnight) go to the controls (FR-034).

## R10. Configuration (FR-030, FR-031; Principle IV)

**Decision.**

*DJ group: all four or none.*
- `ELEVENLABS_API_KEY`
- `ELEVENLABS_VOICE_ID`
- `DJ_LLM_BASE_URL`
- `DJ_LLM_MODEL`

*Optional.*
- `DJ_LLM_API_KEY`
- `ELEVENLABS_MODEL_ID` (default `eleven_flash_v2_5`)
- `DJ_DAILY_LINE_CAP`
- `DJ_DAILY_THEME_TRACK_CAP`

*Validation.* `config/env.js` gains `djRequiredVars()`: if *any* group var is set, it
returns all four names. `src/index.js` appends them to the list it already passes to
`validateEnv`. A partial DJ config is then reported **in the same single aggregated
error** as any other missing variable. The cap values are checked as positive integers,
and the base URL must parse as `http(s)`. All of this runs before any dynamic import.

*Unconfigured.* `isDjConfigured()` is false. The DJ service is never constructed, the
player keeps the `Arbitrary` path, and every DJ surface returns `available: false`
(`503 DJ_UNAVAILABLE` on mutations).

*CI.* The smoke test sets no DJ vars, so it exercises the unconfigured path unchanged.

## R11. Persistence of settings (FR-014)

**Decision.** New tables in `schema.sql`, all `CREATE TABLE IF NOT EXISTS`, so no
`migrate()` step is needed for new tables:
- `dj_settings`: a single row with `id = 1`.
- `dj_shoutout_optouts`: one row per opted-out user.
- `dj_usage`.

Plus one guarded `ALTER TABLE history ADD COLUMN added_by_dj` in `migrate()`, following
the existing pattern (`db.js:79-125`), and `CREATE INDEX IF NOT EXISTS idx_history_url`.
Themed session and recent lines stay in memory (FR-014 says the theme does not persist).

## R12. Transport surface

**Decision.** One service API is called by all three transports
(`services/dj/djService.js`):
- `getState()`
- `setSettings({ enabled?, interval?, lookahead? }, actor)`
- `setShoutouts(userId, enabled)`
- `getShoutouts(userId)`
- `startTheme({ theme, lookahead? }, actor, origin)`
- `stopTheme(actor)`

Validation lives in the service and throws coded errors (`DJ_UNAVAILABLE`,
`INVALID_INTERVAL`, `INVALID_LOOKAHEAD`, `INVALID_THEME`, `NOT_IN_VOICE`,
`NO_TRACKS_FOR_THEME`). Each transport maps those codes to its own reply format. The
contract matrix is in [contracts/dj-api.md](./contracts/dj-api.md).

*State broadcast.* `musicManager.setGetDjState(fn)` (the same injection pattern as
`setGetChannelInfo`) puts `dj` into `getFullState()`, and therefore into `initial:state`.
The service calls `musicManager.emit('dj:state', state)` on every change, and
`socketServer` re-broadcasts it from its existing `managerListeners` table.

*Voice check.* Theme start reads `musicManager.getPlayerState().connected`. It must
**not** copy the `musicManager.guildId || process.env.GUILD_ID` idiom, which is ADR-001
follow-up 2.

*Member identity.* Every per-member key in this feature (`dj_shoutout_optouts.user_id`,
`present[].userId`, `namedUserIds`, `forbiddenNames` lookups, the `user:<id>` socket room)
is the **Discord user id**, the same id `connectedUsers[].id` and
`history.requested_by_id` carry. HTTP reads it from `req.user.discord_id` and socket
handlers from `socket.user.discord_id` (both are the `users` row loaded by `verifyToken`;
`user.id` there is the internal `users.id` and MUST NOT be used), and Discord from
`interaction.user.id`. The parity test asserts all three resolve the same
member to the same id.

*Permissions (FR-015a).* The same gates as the existing controls: Discord any guild
member, HTTP `authMiddleware` with `mutationLimiter`, socket auth with per-user
`isThrottled`.

## R13. ADR

**Decision.** Record the audio pipeline change (R1, R2) as `docs/ADR-002-dj-audio-mixing.md`
in the ADR-001 format. It changes how every track reaches Discord whenever the DJ is
configured. That's architecturally significant even though it touches none of the
constitution's named boundaries.
