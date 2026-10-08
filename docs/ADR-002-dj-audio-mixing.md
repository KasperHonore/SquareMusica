# ADR-002: Mixing the AI DJ voice over the music

- Status: Accepted
- Date: 2026-10-08
- Deciders: maintainers

## Context

Feature 002 (AI DJ Host) needs a spoken line to play _over_ the current track, with
the music ducked underneath it and restored afterwards. The bot cannot do that today.

- `src/core/player.js` builds every resource as
  `createAudioResource(stream, { inputType: streamResult.type })`, and
  `src/integrations/youtube.js` returns `StreamType.Arbitrary`. `@discordjs/voice`
  then runs FFmpeg and Opus encoding internally, so our code never sees PCM.
- There is no `inlineVolume` and no volume feature anywhere in `src/` or `web/src/`.
- An `AudioPlayer` plays exactly one resource, a voice connection subscribes to one
  player at a time, and `@discordjs/voice` has no mixer.

Mixing a second source therefore means owning the decoded PCM ourselves. That changes
how every track reaches Discord whenever the DJ is configured, which is architecturally
significant even though it touches none of the constitution's named boundaries.

## Decision Drivers

- The DJ voice must be layered over music, ducked by about −10 dB, and restored within
  1 s of the line ending (FR-003).
- Onset latency must stay well inside FR-003's 2 s window.
- Operators who never configure the DJ must take no new risk (FR-030).
- No new runtime dependencies (Principle V).
- Pause, stop, skip and queue clear must cancel a line on every transport without
  per-transport code (FR-009, Principle III).

## Options

### Option A — Own the PCM and mix in a Transform (chosen)

```
yt-dlp ──► ffmpeg (-f s16le -ar 48000 -ac 2) ──► DuckingMixer (Transform) ──► createAudioResource(StreamType.Raw)
                                                       ▲
                                     overlay(pcmBuffer) │ DJ line, 48 kHz s16le stereo
```

- `integrations/youtube.js` gains `getPcmStream(url)`. It pipes the existing
  `getStream(url)` output through our own FFmpeg child:
  `ffmpeg -hide_banner -loglevel error -i pipe:0 -f s16le -ar 48000 -ac 2 pipe:1`.
  FFmpeg is resolved from `ffmpeg-static` (already a dependency), falling back to
  `ffmpeg` on `PATH`, exactly as prism-media does. The FFmpeg kill is folded into the
  same idempotent `cleanup`; the yt-dlp startup watchdog and drain semantics are
  unchanged. This moves the FFmpeg process that `Arbitrary` already spawns inside the
  library into our code; it does not add one.
- `core/audioMixer.js` exports `DuckingMixer`, a `Transform` over s16le stereo frames
  that imports only `node:stream`. It passes music through untouched when no overlay is
  set. With an overlay it ramps music gain linearly per sample from 1.0 to 0.3 over
  200 ms, adds the overlay samples and clamps to int16; when the overlay is exhausted it
  ramps back to 1.0 over 300 ms. `cancelOverlay()` drops the remaining overlay and starts
  the release ramp. A partial frame at a chunk boundary is carried into the next chunk.
  `highWaterMark` is 5 frames of 20 ms (about 100 ms), keeping added latency small.
- `MusicPlayer` creates one mixer per track, feeds `StreamType.Raw`, exposes
  `overlay(buffer)` and `cancelOverlay()`, and calls `cancelOverlay()` itself from
  `pause()`, `stop()` and `play()`. An overlay therefore cannot carry over into the
  next track: it is destroyed with the track's resource.

### Option B — FFmpeg `amix` / `sidechaincompress`

Both inputs must exist when FFmpeg starts. Inserting a voice mid-stream means
restarting FFmpeg, which causes a gap or a seek. Rejected.

### Option C — `inlineVolume` only

Can duck the music but cannot layer a second source. Rejected.

### Option D — A second `AudioPlayer` for the voice

A connection subscribes to one player at a time. Rejected.

### Option E — A mixer npm package (`node-audio-mixer`, `@wetalabs/mixer`)

Adds a dependency for about 80 lines of code whose ramp envelope and cancel semantics
we need exact control over. Rejected (Principle V).

## Decision

**Adopt Option A.** It is the only option that layers a second source mid-track
without restarting the pipeline, it adds no dependency and no extra process, and it
keeps cancel semantics inside `core/` where every transport already passes through.

**Dual path.** When the DJ env group is _not_ configured (`isDjConfigured()` is false),
`player.play()` keeps today's `StreamType.Arbitrary` path byte-for-byte and no mixer is
constructed. When it _is_ configured, `src/index.js` calls
`player.setMixingEnabled(true)` once at boot and every track uses the PCM path, whether
commentary is on or off, so enabling the DJ mid-session takes effect at the next track
without switching pipelines.

## Consequences

Positive: the DJ can speak over music with controlled ducking; FR-009 cancellation is
enforced in one place; unconfigured deployments are untouched; CI's smoke test (which
sets no DJ vars) keeps exercising the legacy path.

Negative: when configured, our code owns an FFmpeg child per track and must clean it up
on every terminal path; any regression there would affect all playback, not only DJ
lines.

### Follow-up task list (actionable)

1. **Volume control must multiply into the mixer gain.** The bot has no volume feature,
   so the spec's "volume changes during a line" edge case has nothing to act on. The
   ducking gain is relative to unity. If a volume feature is added later, it must
   multiply into the same `DuckingMixer` gain rather than adding a second gain stage
   (or `inlineVolume`) elsewhere in the pipeline.
2. **Verify parity of the two paths** — quickstart checks that music on the PCM path
   sounds identical to the legacy path before the DJ is enabled in production.
