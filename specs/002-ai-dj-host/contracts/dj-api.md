# Contract: AI DJ: transports, state, and model I/O

**Feature**: [../spec.md](../spec.md) | **Data model**: [../data-model.md](../data-model.md)

All three transports call the same `djService` methods (research R12) and map its coded
errors to their own reply format. This keeps playback and queue semantics identical
(Principle III); only authentication, throttling and reply format differ.

---

## 1. State object: `DjState`

Broadcast as socket event `dj:state`, included as `dj` in `initial:state`, and returned
by `GET /api/dj`.

```jsonc
{
  "available": true,              // false when DJ env group not configured (FR-030); all else omitted then
  "enabled": false,               // FR-013 default
  "interval": 3,                  // 1..10 (FR-012)
  "lookahead": 5,                 // 5 | 10 (FR-023)
  "health": "ok",                 // "ok" | "degraded" (breaker open, R9)
  "caps": {
    "lines":        { "used": 12, "limit": 150, "reached": false },
    "themedTracks": { "used": 0,  "limit": 100, "reached": false },
    "resetsAt": "2026-10-07T00:00:00+02:00"   // next local midnight in TZ
  },
  "theme": null                   // or ThemeState
}
```

`ThemeState`:

```jsonc
{ "theme": "90s eurodance for a Friday night", "startedBy": { "id": "123", "name": "Kasper" },
  "startedAt": "2026-10-06T19:02:11Z", "status": "running",   // "running" | "stalled"
  "reason": null }  // null | NO_LISTENERS | NOT_IN_VOICE | CAP_REACHED | SERVICE_UNAVAILABLE | THEME_EXHAUSTED
```

Per-user shout-out preference is **not** in the broadcast state (it is per-member), and is
keyed by the member's **Discord user id** on every transport (research R12). It is
fetched with `GET /api/dj/shoutouts/me` and returned in the reply to a change. Every change,
from any transport, is also pushed as `dj:shoutouts { enabled }` to that member's sockets
only (room `user:<discord_id>`), so their open dashboards converge without polling.

Queue entries in `queue:update` gain `addedByDj: true` on picks. The web client shows
"DJ" instead of a member name for those.

---

## 2. Error codes (shared)

| Code | Meaning | HTTP | Discord reply (ephemeral) | Socket |
|---|---|---|---|---|
| `DJ_UNAVAILABLE` | DJ env not configured | 503 | "The DJ isn't set up on this server." | `error {code,message}` |
| `INVALID_INTERVAL` | not an integer 1–10 | 400 | "Interval must be a whole number from 1 to 10." | same |
| `INVALID_LOOKAHEAD` | not 5 or 10 | 400 | "Lookahead must be 5 or 10." | same |
| `INVALID_THEME` | empty or > 200 characters after trim | 400 | "Theme must be 1–200 characters." | same |
| `NOT_IN_VOICE` | bot not in a voice channel (theme start) | 409 | existing "not in voice" text | same |
| `NO_TRACKS_FOR_THEME` | first batch produced zero playable tracks (FR-029) | 422 | "I couldn't find any tracks for that theme." | same |
| `SERVICE_UNAVAILABLE` | LLM unreachable or breaker open at theme start | 503 | "The DJ's music brain is unavailable right now, try again soon." | same |
| `CAP_REACHED` | themed-track cap reached at theme start | 429 | "The DJ has hit today's limit; it resets at HH:MM." | same |

On any error, the previous state is unchanged (US2 scenario 3).

---

## 3. Operation matrix (parity)

| Operation | `djService` call | Discord | HTTP (all `authMiddleware` + `mutationLimiter` on mutations) | Socket (client → server) |
|---|---|---|---|---|
| Read state | `getState()` | `/dj status` | `GET /api/dj` → `DjState` | (pushed via `dj:state`) |
| Enable / disable | `setSettings({enabled})` | `/dj on`, `/dj off` | `PATCH /api/dj` `{ "enabled": true }` | `dj:settings` `{ enabled }` |
| Set interval | `setSettings({interval})` | `/dj interval every:<1-10>` | `PATCH /api/dj` `{ "interval": 4 }` | `dj:settings` `{ interval }` |
| Set lookahead | `setSettings({lookahead})` | `/dj theme ... lookahead:<5\|10>` or `/dj lookahead size:<5\|10>` | `PATCH /api/dj` `{ "lookahead": 10 }` | `dj:settings` `{ lookahead }` |
| Start / change theme | `startTheme({theme, lookahead?}, actor, origin)` | `/dj theme description:<text> [lookahead]` | `POST /api/dj/theme` `{ "theme": "...", "lookahead": 5 }` → 200 `DjState` | `dj:theme:start` `{ theme, lookahead? }` |
| Stop theme | `stopTheme(actor)` | `/dj theme-stop` | `DELETE /api/dj/theme` → 200 `DjState` | `dj:theme:stop` |
| Own shout-outs | `getShoutouts(uid)` / `setShoutouts(uid, enabled)` | `/dj shoutouts enabled:<true\|false>` (reply states the current value) | `GET /api/dj/shoutouts/me` → `{ "enabled": true }`; `PUT /api/dj/shoutouts/me` `{ "enabled": false }` | `dj:shoutouts` `{ enabled }` → ack `{ enabled }` |

Rules:
- `PATCH /api/dj` accepts any subset of `{enabled, interval, lookahead}`. The whole body
  is validated before anything is written, so it's all or nothing.
- Every successful mutation causes exactly one `dj:state` broadcast (FR-015, SC-004).
- Socket handlers use the per-user throttle (`isThrottled`) with a new key `dj` at 1000 ms.
- Theme start when a session already exists means *change theme* (US4 scenario 7).
- Discord's `/dj` is one command with subcommands. Like all slash commands it must be
  added to `register.js` **and** `commands/index.js`, then `npm run register` is run.
- Discord replies to settings changes publicly (non-ephemeral), like `/loop`, and replies
  to shout-out changes ephemerally, since they're personal.

Parity test: `test/transports/djParity.test.js` drives each row through all three
transports against a mocked `djService` and asserts the same call and arguments, and the
same error code mapping.

---

## 4. Player seam (internal, consumed by djService)

`core/player.js` additions:

| Member | Contract |
|---|---|
| `overlay(pcm: Buffer): boolean` | Mixes `pcm` (48 kHz s16le stereo) over the current track with ducking. Returns `false` if nothing is playing, the player is paused, or the mixer is disabled (DJ unconfigured). Replaces any overlay already in progress. |
| `cancelOverlay(): void` | Drops the remaining overlay and ramps music back to unity. Idempotent. Called internally by `pause()`, `stop()` and `play()`. |
| `setMixingEnabled(bool)` | Set once at boot from `isDjConfigured()`. Selects the PCM+mixer path or the legacy `Arbitrary` path for subsequent `play()` calls. |

`DuckingMixer` (`core/audioMixer.js`):
- Duck gain 0.3.
- Attack 200 ms, release 300 ms.
- Linear per-sample ramp, int16 clamp.
- Frame alignment carries a partial frame across chunks.
- `highWaterMark` 5 frames.

---

## 5. Model I/O

### 5a. Line generation (LLM, `json_object`)

*System prompt (paraphrased contract, not final copy):* "You are the SquareMusica radio DJ.
Write ONE or TWO short, upbeat sentences to say over the start of the next song. Use ONLY
the facts provided. Only name people listed under allowedNames. Never invent play counts,
dates or connections. Spell numbers as words. No emoji. Return JSON
`{"line": string, "factIds": string[]}`."

*User payload:*

```json
{ "next": {"id":"t2","title":"...","artist":"...","queuedBy":"Kasper"},
  "previous": {"id":"t1","title":"...","artist":"..."},
  "theme": null,
  "allowedNames": ["Kasper"],
  "facts": [{"id":"f1","text":"Kasper has played this track 7 times."}],
  "recentLines": ["..."] }
```

`facts` only ever contains `track`, `member`, `group` and `theme` kinds; there is no
session-recap input (FR-004).

Acceptance before TTS: see research R6 validation steps 1–4. Any failure means the line is
dropped and the failure counts toward the breaker.

### 5b. Themed picks (LLM, `json_object`)

*User payload:*

```json
{ "theme": "...", "count": 9, "allowRepeats": false,
  "candidates": [{"id":"c1","title":"...","artist":"..." /* or null */}],
  "avoid": ["artist - title", "..."] }
```

*Response:* `{"picks":[{"candidateId":"c1"} | {"artist":"...","title":"..."}]}`.
- Candidate `artist` comes from `history.artist` and is `null` for rows recorded before
  that column existed.
- Unknown `candidateId` entries are ignored.
- Picks in `avoid` are ignored unless `allowRepeats`.
- New picks are resolved through `resolveSpotifyTrack`, and unresolvable ones are dropped
  (FR-026).

### 5c. TTS (ElevenLabs)

`POST /v1/text-to-speech/{ELEVENLABS_VOICE_ID}?output_format=pcm_48000`, header
`xi-api-key`, body `{ "text": line, "model_id": ELEVENLABS_MODEL_ID }`.
- The response is mono s16le, converted to stereo.
- It's rejected if longer than 15 s (FR-002).
- Fallback format `pcm_24000` with 2× upsample (R3).
