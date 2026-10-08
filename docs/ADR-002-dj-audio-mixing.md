# ADR-002: DJ Audio Mixing (PCM pipeline and ducking mixer)

- Status: Accepted
- Date: 2026-10-08
- Deciders: maintainers

## Context

Feature 002 (AI DJ Host) needs the bot to speak a short line over the opening of a
track while the music is lowered ("ducked") and then restored. The bot cannot do this
today:

- `src/core/player.js` builds every resource as
  `createAudioResource(stream, { inputType: streamResult.type })`, and
  `src/integrations/youtube.js` returns `StreamType.Arbitrary`. `@discordjs/voice` then
  runs FFmpeg and Opus encoding internally, so our code never sees PCM.
- There is no `inlineVolume` and no volume feature anywhere in `src/` or `web/src/`.
- An `AudioPlayer` plays exactly one resource, a voice connection subscribes to one
  player at a time, and `@discordjs/voice` has no mixer.

Mixing a second source over the music therefore requires our own code to own the PCM.
This changes how every track reaches Discord whenever the DJ is configured, which is
architecturally significant even though it touches none of the constitution's named
boundaries (research R1, R2, R13).

## Decision Drivers

- The voice must layer over the music, not replace it, and the music must duck and
  restore smoothly (FR-003: duck within 2 s, restore within 1 s).
- Operators who never configure the DJ must take no new risk (FR-030).
- A skip, pause, stop or queue clear must silence the DJ immediately on every transport
  (FR-009, Constitution III).
- No new runtime dependencies (Constitution V posture).

## Options

### Option A — Move the PCM transcode into our code and mix in a Transform

`integrations/youtube.js` gains `getPcmStream(url)`, which wraps the existing
`getStream` output in our own FFmpeg child:

```
ffmpeg -hide_banner -loglevel error -i pipe:0 -f s16le -ar 48000 -ac 2 pipe:1
```

FFmpeg is resolved from `ffmpeg-static` (already a dependency), falling back to `ffmpeg`
on `PATH`. The child is folded into the same idempotent `cleanup`, and the existing
startup watchdog and drain semantics are unchanged.

`core/audioMixer.js` exports `DuckingMixer`, a `Transform` over s16le stereo frames that
imports only `node:stream`:

```
yt-dlp ──► ffmpeg (s16le 48k stereo) ──► DuckingMixer ──► createAudioResource(StreamType.Raw)
                                              ▲
                            overlay(pcmBuffer) │ DJ line, 48 kHz s16le stereo
```

- Music passes through untouched when no overlay is set.
- `overlay(buffer)` ramps music gain linearly 1.0 → 0.3 over 200 ms, adds the overlay
  samples and clamps to int16; when the overlay is exhausted gain ramps back to 1.0 over
  300 ms. `cancelOverlay()` drops the rest of the overlay and starts the release ramp.
- A partial frame at a chunk boundary is carried into the next chunk.
- `highWaterMark` is 5 frames of 20 ms (≈100 ms) to keep ducking onset latency small.

`MusicPlayer` builds one mixer per track, exposes `overlay()`/`cancelOverlay()`, and
calls `cancelOverlay()` itself from `pause()`, `stop()` and `play()`. The overlay lives
inside the track's own mixer, so it can never carry over into the following track.

### Option B — FFmpeg `amix` / `sidechaincompress`

Both inputs must exist when FFmpeg starts. Inserting a voice mid-stream means restarting
FFmpeg, which causes a gap or a seek.

### Option C — `inlineVolume` only

Can duck the music but cannot layer a second source.

### Option D — A second `AudioPlayer` for the voice

A connection subscribes to one player at a time.

### Option E — A mixer npm package (`node-audio-mixer`, `@wetalabs/mixer`)

Adds a dependency for about 80 lines of code whose envelope and cancel semantics we need
exact control over.

## Decision

**Adopt Option A.** It is the only option that layers a voice mid-track without a gap,
needs no new binary or dependency, and keeps cancel semantics inside the player where
every transport already goes.

**Dual path.** When the DJ is *not* configured, `player.play()` keeps today's
`StreamType.Arbitrary` path byte-for-byte; our FFmpeg child is never spawned. When it is
configured (`player.setMixingEnabled(true)` at boot), every track uses the PCM path
whether commentary is on or off, so enabling the DJ mid-session takes effect at the next
track without switching pipelines.

## Consequences

Positive: the DJ can speak over music with smooth ducking; FR-009 holds for every
transport without per-transport code; CPU is unchanged, because `Arbitrary` already
spawns this FFmpeg inside the library — we move it rather than add one.

Negative: when configured, a small amount of audio-path code (FFmpeg child lifecycle,
frame alignment) is ours to maintain instead of the library's.

### Follow-up task list (actionable)

1. **Volume feature must multiply into the mixer gain.** The bot has no volume control
   today, so the ducking gain is relative to unity. Any future volume feature must apply
   its gain inside `DuckingMixer` (multiplied with the duck gain), not via a separate
   `inlineVolume` stage, or ducking and volume will fight. Not work for feature 002.
