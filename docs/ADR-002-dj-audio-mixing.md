# ADR-002: DJ Audio Mixing (PCM Transcode + Ducking Mixer)

- Status: Accepted
- Date: 2026-10-08
- Deciders: maintainers

## Context

Feature 002 (AI DJ Host) needs a spoken DJ line to play over the opening of a track,
with the music lowered ("ducked") while the voice plays and restored afterwards.

The bot cannot do this today:

- `src/core/player.js` builds every resource as
  `createAudioResource(stream, { inputType: streamResult.type })`, and
  `src/integrations/youtube.js` returns `StreamType.Arbitrary`. `@discordjs/voice` then
  runs FFmpeg and the Opus encoder internally, so our code never sees PCM samples.
- There is no `inlineVolume` and no volume feature anywhere in `src/` or `web/src/`.
- An `AudioPlayer` plays exactly one resource, and `@discordjs/voice` has no mixer.

So mixing a second source over the music needs the PCM to be under our control.

## Decision Drivers

- The voice must start mid-track at an arbitrary moment, without a gap or a seek in the
  music.
- Ducking needs an exact envelope (attack, release, cancel), and cancel must be
  immediate when a member skips, pauses, stops or clears the queue (FR-009).
- Operators who never configure the DJ must take on no new risk.
- Constitution V: no new runtime dependencies for something we can write in ~80 lines.

## Options

### Option A: Own the PCM transcode and mix in a Transform (chosen)

Move the FFmpeg transcode into our code and add a small mixing Transform in front of a
`StreamType.Raw` resource.

### Option B: FFmpeg `amix` / `sidechaincompress`

Both inputs must exist when FFmpeg starts. Inserting a voice mid-stream means restarting
FFmpeg, which causes a gap or a seek.

### Option C: `inlineVolume` only

Can duck the music but cannot layer a second source.

### Option D: A second `AudioPlayer` for the voice

A voice connection subscribes to one player at a time.

### Option E: A mixer npm package (`node-audio-mixer`, `@wetalabs/mixer`)

Adds a dependency for about 80 lines of code whose envelope and cancel semantics we need
exact control over.

## Decision

**Adopt Option A.** When the DJ is configured, the music path becomes:

```
yt-dlp ──► ffmpeg (-f s16le -ar 48000 -ac 2) ──► DuckingMixer (Transform) ──► createAudioResource(StreamType.Raw)
                                                       ▲
                                     overlay(pcmBuffer) │ DJ line, 48 kHz s16le stereo
```

- `src/integrations/youtube.js` gains `getPcmStream(url)`. It calls the existing
  `getStream(url)` and pipes its output into our own FFmpeg child:
  `ffmpeg -hide_banner -loglevel error -i pipe:0 -f s16le -ar 48000 -ac 2 pipe:1`.
  FFmpeg is resolved from `ffmpeg-static` (already a dependency), falling back to
  `ffmpeg` on `PATH`, the same way prism-media resolves it. Killing the FFmpeg child is
  folded into the same idempotent `cleanup`. The startup watchdog and drain semantics
  are unchanged. The result has `type: StreamType.Raw`.
- `src/core/audioMixer.js` exports `DuckingMixer`, a `Transform` over s16le stereo
  frames that imports only `node:stream`:
  - Music passes through untouched when no overlay is set.
  - `overlay(buffer)` sets (or replaces) the overlay. Music gain ramps linearly per
    sample from 1.0 to 0.3 over 200 ms, overlay samples are added, and the sum is
    clamped to int16.
  - When the overlay is exhausted, gain ramps back to 1.0 over 300 ms.
  - `cancelOverlay()` drops the remaining overlay and starts the release ramp.
  - A partial frame left at a chunk boundary is carried into the next chunk.
  - `highWaterMark` is 5 frames of 20 ms (5 × 3840 B), keeping onset latency small.
- `MusicPlayer` creates one mixer per track, exposes `overlay(pcm)` and
  `cancelOverlay()`, and calls `cancelOverlay()` from `pause()`, `stop()` and `play()`.
  The overlay lives inside the track's own mixer, so it can never carry over into the
  following track.

**Dual path.** When the DJ is *not* configured, `player.play()` keeps the legacy
`StreamType.Arbitrary` path byte-for-byte. When it is configured, every track uses the
PCM path whether commentary is on or off, so enabling the DJ mid-session takes effect
at the next line without switching pipelines.

## Consequences

Positive: the DJ can speak over any track with a precise, cancellable duck; no new
dependency; no CPU change, because `Arbitrary` already spawned this same FFmpeg inside
the library (we moved it rather than added one); unconfigured deployments are
unaffected.

Negative: when configured, the transcode is our code to maintain (process lifetime,
cleanup, watchdog), and a bug in the mixer affects every track's audio.

### Follow-up

1. **Volume.** The bot has no volume control, so the ducking gain is relative to unity.
   If a volume feature is added later, it must multiply into the mixer's gain rather
   than adding a separate `inlineVolume` stage, or ducking and volume will fight.
