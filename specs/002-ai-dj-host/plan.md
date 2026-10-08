# Implementation Plan: AI DJ Host

**Branch**: `002-ai-dj-host` | **Date**: 2026-10-06 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `/specs/002-ai-dj-host/spec.md`

## Summary

Add an AI DJ to SquareMusica. It speaks one or two sentences over the opening of the next
track while the music is lowered. It grounds what it says in the queue, the play history,
and the members present in the voice channel. It can also run a **themed mode** that keeps
the queue topped up 5 or 10 tracks ahead. Lines are written by an LLM behind a
LiteLLM-compatible endpoint and voiced by ElevenLabs. Members control it from Discord, the
HTTP API and Socket.io with identical semantics.

The technical shape is driven by one finding: **the bot cannot mix or duck audio today.**
Every track goes to `@discordjs/voice` as `StreamType.Arbitrary` (`core/player.js:110`),
which transcodes inside the library, so our code never touches PCM. There is no volume
control anywhere. Clarification Q5 chose ducking over a gap between tracks, so this
feature has to:

1. Move the FFmpeg transcode into our own code (`getPcmStream`).
2. Insert a small `DuckingMixer` Transform in front of a `StreamType.Raw` resource.

The mixer lives in `core/` and is driven only through `player.overlay()` and
`cancelOverlay()`. This path is used only when the DJ is configured; otherwise playback is
byte-for-byte unchanged. Because it changes how every track reaches Discord, it gets
`docs/ADR-002-dj-audio-mixing.md` (R13).

Everything else follows existing patterns:
- A `services/dj/` module listens to the mediator's `track:change` and `queue:update`
  events. It prepares the next line about 30 s before a transition, so track start is
  never delayed (FR-008).
- One service API is called by all three transports.
- New single-row and lookup tables hold settings, opt-outs and daily usage.
- An all-or-none DJ env group joins the existing aggregated `validateEnv` call.

Line content is scoped by FR-004 (narrowed 2026-10-06): previous and next track,
present members' history with them, and the theme. There are no session-recap facts.

Truthfulness (FR-005, SC-003) is enforced by construction. The LLM is given a
pre-computed facts list and an allowed-names list. Its output is validated (fact ids exist,
no forbidden names, length, no repeats) before any audio is synthesised.

## Technical Context

**Language/Version**: Node.js ≥ 22.12.0, ES modules throughout.

**Primary Dependencies**: Backend uses `@discordjs/voice` 0.19 (`StreamType.Raw`), express 4,
socket.io 4, better-sqlite3 9 and discord.js 14. FFmpeg comes from the existing
`ffmpeg-static` / system binary. The frontend is React 18, Vite and Tailwind.
- **No new runtime dependency.** ElevenLabs and the LLM are called with Node 22's built-in
  `fetch` (R3, R4).
- The mixer is about 100 lines of our own code (R1).

**External services**: ElevenLabs TTS (`eleven_flash_v2_5`, `pcm_48000`) and a
LiteLLM-compatible `/chat/completions` endpoint. Both are optional, configured as one group.

**Storage**: Existing SQLite through `persistence/db.js`:
- Three new tables: `dj_settings`, `dj_shoutout_optouts`, `dj_usage`.
- Two additive columns, `history.added_by_dj` and `history.artist` (nullable).
- One new index, `idx_history_url`.

**Testing**: Vitest, mirroring `test/services/`, `test/http/routes/`, `test/transports/`
and `test/persistence/`.
- The mixer is tested on synthetic PCM buffers.
- LLM and TTS are mocked at the `fetch` boundary.
- A parity test drives every DJ operation through all three transports.

**Target Platform**: Linux server in Docker, and the dashboard in modern browsers.

**Project Type**: Web application. The Express, Socket.io and Discord backend is under
`src/`; the React SPA is under `web/`.

**Performance Goals**:
- DJ voice starts within 2 s of track start, and music restores within 1 s of the line
  ending (FR-003).
- Zero added delay to track start (FR-008).
- Themed mode: music within 30 s, full lookahead within 60 s (SC-005).
- Settings broadcast within 2 s (SC-004).

**Constraints**:
- The DJ path must never block or fail playback (FR-032, SC-008): playback code never
  awaits the DJ.
- Mixer CPU is a per-sample add and multiply. The FFmpeg transcode replaces the one the
  library already ran, so net CPU is roughly unchanged.
- One line in flight at a time.
- Daily caps bound spend (FR-033).

**Scale/Scope**:
- One guild and one DJ. Realistically 2–15 listeners, up to about 150 lines a day.
- About 13 backend files added and 14 modified, 3 frontend files added and 6 modified,
  and about 13 test files added. Exact counts come from `tasks.md`.

## Constitution Check

*GATE: evaluated before Phase 0 and re-evaluated after Phase 1 design.*

| Principle | Gate | Verdict |
|---|---|---|
| **I. Single-Guild Scope** | No per-guild partitioning of playback state; no new `guildId \|\| GUILD_ID` copies | **PASS.** One DJ, with a single-row `dj_settings` (`CHECK (id = 1)`). Themed session and line state are single in-memory cells in `djService`. Theme start checks voice through `musicManager.getPlayerState().connected` rather than copying the ADR-001 follow-up 2 idiom (R12). No new guild keying anywhere. |
| **II. Layered Dependency Direction** | `core/` never imports `transports/`; cross-module notification by bus/mediator events; persistence only via `db.js` | **PASS.** `core/audioMixer.js` imports only `node:stream`. `core/player.js` gains `overlay`/`cancelOverlay` and imports nothing new from outside `core/` and `integrations/`. `core/queue.js` gains `insertAt` and `prioritizeMemberTracks`, with no imports. `services/dj/*` imports `core/musicManager.js`, `services/playback.js` (getters), `services/resolver.js`, `persistence/db.js` and `config/env.js`, and **never** `transports/`. Voice members reach the DJ through the existing injected `getChannelInfo`, via `musicManager.getVoiceContext()`. DJ state reaches transports by injection, `musicManager.setGetDjState(fn)`, plus a `dj:state` mediator event, the same seam as `setGetChannelInfo`. The `services/playback.js → transports/` exception is neither touched nor extended. |
| **III. Transport Parity** | Same semantics on Discord, HTTP, Socket.io; state broadcast, not polled | **PASS, with the feature's parity risk noted below.** All operations go through one `djService` API with service-side validation and coded errors ([contracts §3](./contracts/dj-api.md)). Two behaviours that could have diverged by transport are placed where every transport already converges. Ducking cancellation on pause, stop and skip lives in `MusicPlayer` itself. Member-before-DJ ordering (FR-024) lives in `Queue.add`. Every mutation emits one `dj:state` broadcast. Per-transport differences are limited to transport concerns: auth, `mutationLimiter`, socket throttling, ephemeral replies, and posting stall notices to the originating Discord channel. |
| **IV. Fail-Fast Configuration** | Aggregated validation before dynamic imports | **PASS.** The DJ group is all-or-none (R10). If any of the four group vars is set, all four join the single `validateEnv([...])` list in `src/index.js`, so a partial config is reported in the **same** aggregated error as any other missing variable (FR-031). Caps and the base URL are format-checked in the same pre-import phase. With no DJ vars set, nothing changes and no DJ module is constructed. **Ripples:** `.env.sample` and the README env list must document the group. The CI smoke test sets none of them and so exercises the unconfigured path. |
| **V. CI-Enforced Validation Gates** | lint, format:check, vitest (incl. import-resolution), web build, docker smoke | **PASS.** New tests go under `test/`. `test/import-resolution.test.js` covers the new relative imports for free and is not weakened. The docker smoke test keeps passing because the unconfigured path leaves `player.play` on the legacy `Arbitrary` path and no DJ code runs at boot. No new native module. |

**Principle III note: the parity risk.** The `/dj` command, the `/api/dj` routes and the
`dj:*` socket events are nine operations × three surfaces, and a missed or divergent site
fails silently. The mitigation, which must survive into `tasks.md`: every transport is a
thin adapter over `djService` with one shared error-code table, and
`test/transports/djParity.test.js` asserts the full matrix from contracts §3, covering the
call, the arguments and the error mapping.

Two more parity seams are fixed in the design rather than left to each transport:
- **Member identity.** Opt-outs and the `user:<id>` room are keyed by the Discord id on
  all three transports; HTTP and socket read `user.discord_id`, never the internal `user.id` (R12).
- **Themed adds.** Picks go through `musicManager.addToQueue`, so they broadcast
  `queue:update` like a member add (R8).

**Pre-existing divergence, partly fixed here.** Discord `/pause` and `/skip` call
`getPlayer()` directly rather than going through `musicManager` (feature 001's plan).
That is harmless here because pause, stop and skip cancellation is inside `MusicPlayer`,
which both paths reach. Discord `/clear` was different: it changed `queue.tracks`
directly, so it never reached the player or the mediator. It now calls
`musicManager.clearAllButCurrent()` (T019a), so FR-009 holds for queue clears on every
transport. The Discord-specific clear behaviour (keep the current track, drop everything
else) and its stats variant are unchanged. The same applies to Discord `/shuffle` and
`/stop` (T063b): they also changed the queue directly, so the themed-mode shuffle refusal
(FR-024a) and the clear-stops-theme hook (FR-024b) would have missed Discord. Both now
go through `musicManager`.

**Post-design re-check (after Phase 1, re-run 2026-10-06 after FR-004 narrowing):** all
five still **PASS**. The re-run removed the unused `getRecentTracks` read, added the
`client.js` voice event and speak-time re-check (I), fixed member identity to the Discord
id, and routed themed adds through `musicManager.addToQueue` (III). Phase 1 added no
`core → transports` edge, no guild keying, and no new required variable. The only
architectural novelty is the audio pipeline, which is recorded in ADR-002.

## Project Structure

### Documentation (this feature)

```text
specs/002-ai-dj-host/
├── plan.md              # This file
├── research.md          # Phase 0: R1–R13
├── data-model.md        # Phase 1
├── quickstart.md        # Phase 1
├── contracts/
│   └── dj-api.md        # Phase 1: state, errors, parity matrix, player seam, model I/O
├── checklists/
│   └── requirements.md
└── tasks.md             # Phase 2 (/speckit-tasks; not created here)
```

### Source Code (repository root)

```text
src/
├── config/env.js                       # M: djRequiredVars(), isDjConfigured(), validateDjFormats()
├── index.js                            # M: append DJ group to validateEnv; init djService after playback
├── core/
│   ├── audioMixer.js                   # A: DuckingMixer Transform (R1)
│   ├── player.js                       # M: PCM path when mixing enabled; overlay/cancelOverlay; cancel on pause/stop/play
│   ├── queue.js                        # M: insertAt, prioritizeMemberTracks, countUpcoming, peekNext
│   └── musicManager.js                 # M: setGetDjState; dj in getFullState; addToHistory passes addedByDj; ensurePlaying via advanceAndPlay; clearAllButCurrent (cancels overlay); shuffleQueue refuses in themed mode; setOnQueueCleared hook
├── integrations/
│   ├── youtube.js                      # M: getPcmStream(url) wrapping getStream + ffmpeg child in shared cleanup
│   ├── elevenlabs.js                   # A: synthesize(text) → 48 kHz stereo PCM Buffer (R3)
│   └── llm.js                          # A: chatJson({system, user, timeoutMs}) via fetch (R4)
├── persistence/
│   ├── schema.sql                      # M: dj_settings, dj_shoutout_optouts, dj_usage, added_by_dj, artist, idx_history_url
│   └── db.js                           # M: migrate added_by_dj and artist; DJ settings/opt-out/usage methods; grounding reads; DJ-skip NULL guard
├── services/dj/
│   ├── errors.js                       # A: DjError + error-code constants (contracts §2)
│   ├── messages.js                     # A: shared code → { http, text } table for all transports
│   ├── contentFilter.js                # A: isClean(text) blocklist for lines and themes
│   ├── djService.js                    # A: public API (R12), state, breaker, caps, event wiring
│   ├── linePlanner.js                  # A: transition counter, prepare-ahead scheduling, speak-time member re-check, speak/drop (R5, R7)
│   ├── context.js                      # A: facts + allowed/forbidden names + speakable names (R6, R7)
│   ├── lineWriter.js                   # A: prompt, validation, TTS call (R6)
│   └── themeEngine.js                  # A: themed session, top-up, picks, dedupe, resolve (R8)
└── transports/
    ├── discord/
    │   ├── client.js                   # M: emitVoiceContext on every join/leave of the bot's channel (R7; not done today)
    │   ├── voiceManager.js             # M: displayName in connectedUsers
    │   └── commands/
    │       ├── dj.js                   # A: /dj subcommands
    │       ├── index.js                # M: register dj handler
    │       ├── playback.js             # M: /stop via musicManager.stop()
    │       ├── queue.js                # M: /clear via musicManager.clearAllButCurrent(); /shuffle via musicManager.shuffleQueue()
    │       └── register.js             # M: /dj SlashCommandBuilder
    ├── http/
    │   ├── index.js                    # M: mount /api/dj with mutationLimiter
    │   └── routes/dj.js                # A: GET/PATCH /, POST/DELETE /theme, GET/PUT /shoutouts/me
    └── realtime/
        ├── events.js                   # M: dj:state, dj:settings, dj:theme:start, dj:theme:stop, dj:shoutouts
        ├── handlers.js                 # M: handleDjSettings, handleDjThemeStart, handleDjThemeStop, handleDjShoutouts
        └── socketServer.js             # M: register handlers; dj:state in managerListeners

web/src/
├── hooks/useSocket.js                  # M: djState stream + dj actions
├── context/SocketContext.jsx           # M: expose dj state/actions
├── components/layout/Sidebar.jsx       # M: "DJ" nav item
├── components/center/CenterPanel.jsx   # M: render DjView
├── pages/Dj.jsx                        # A: DJ view (toggle, interval, theme, lookahead, shout-out opt-out, listeners, health/caps)
├── components/dj/ThemeControl.jsx      # A
├── components/dj/ListenerList.jsx      # A
├── components/QueueItemDefault.jsx     # M: "DJ" attribution badge for addedByDj
└── components/QueueItemCompact.jsx     # M: same

docs/ADR-002-dj-audio-mixing.md         # A (R13)
.env.sample, README.md                  # M: DJ env group

test/
├── core/audioMixer.test.js             # A: passthrough, duck envelope, clamp, cancel, frame carry
├── core/player-overlay.test.js         # A: cancel on pause/stop/play; legacy path when disabled
├── music/queue.test.js                 # M: insertAt, prioritizeMemberTracks FIFO
├── config/env.test.js                  # M: DJ all-or-none aggregated, format checks
├── persistence/migration.test.js       # M: added_by_dj migration
├── persistence/dj.test.js              # A: settings defaults/CHECKs, opt-outs, usage upsert, grounding reads exclude loop/DJ rows
├── integrations/elevenlabs.test.js     # A: request shape, mono→stereo, 15 s cap, format fallback, error kinds
├── integrations/llm.test.js            # A: request shape, optional key, JSON parse, timeout
├── services/dj/context.test.js         # A: speakableName, member/group facts, allowed/forbidden names
├── services/dj/lineWriter.test.js      # A: validation rejects fabricated names, extra sentences, unknown facts, repeats
├── services/dj/linePlanner.test.js     # A: interval counting, stale line drop, 2 s window, no-listener silence, stale-member drop
├── services/dj/themeEngine.test.js     # A: lookahead top-up, dedupe, resolve-fail replace, no-tracks error, stall reasons
├── services/dj/djService.test.js       # A: breaker, caps, settings validation, single broadcast per mutation
├── http/routes/dj.test.js              # A
├── transports/djParity.test.js         # A: contracts §3 matrix across three transports, same member id on each
└── transports/voiceContext.test.js     # A: VoiceStateUpdate join/leave emits voice:context
```

**Structure Decision**: This follows the existing web-application layout and its layer
ordering. DJ logic lives in a new `services/dj/` folder, since it's the first multi-file
service. External API clients go in `integrations/` beside `spotify.js` and `youtube.js`.
The only `core/` additions are the transport-agnostic audio mixer and queue primitives.

## Complexity Tracking

No constitution violations. One deliberate complexity is recorded here because it is the
feature's largest risk:

| Complexity | Why needed | Simpler alternative rejected because |
|---|---|---|
| Own PCM transcode plus mixer in the playback path (when the DJ is configured) | Clarification Q5 requires speaking over ducked music; `@discordjs/voice` has no mixer, and an `AudioPlayer` plays one resource | Gap-between-tracks needs no mixing but was rejected by the user in Q5. FFmpeg `amix` cannot insert a voice mid-stream without restarting. `inlineVolume` alone cannot layer a second source. A mixer dependency is no smaller than our own code, and gives less control over the envelope and cancel behaviour. |

**Risk controls:**
- The legacy path is kept when the DJ is unconfigured, so the CI smoke test and
  non-DJ operators are untouched.
- The mixer is pure and unit-tested on buffers.
- `getPcmStream` reuses the existing watchdog and idempotent cleanup.
- ADR-002 records the decision.
