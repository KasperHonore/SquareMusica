# ADR-002: Mixing the AI DJ voice over the music

- Status: Accepted
- Date: 2026-10-06
- Deciders: maintainers

## Context

Feature 002 (AI DJ Host) needs the DJ to talk over the opening seconds of a track while
the music keeps playing, quieter, underneath (FR-003). The bot cannot do that today.

- `src/core/player.js` builds every resource as
  `createAudioResource(stream, { inputType: streamResult.type })`, and
  `src/integrations/youtube.js` returns `StreamType.Arbitrary`. `@discordjs/voice` then
  runs FFmpeg and Opus encoding internally, so our code never sees PCM.
- There is no `inlineVolume` and no volume feature anywhere in `src/` or `web/src/`.
- An `AudioPlayer` plays exactly one resource, a voice connection subscribes to exactly
  one player, and `@discordjs/voice` has no mixer.

So a second audio source cannot be layered on top of the music without changing how
every track reaches Discord. That makes this an architectural decision, even though it
touches none of the constitution's named boundaries.

## Decision Drivers

- The voice must start within FR-003's 2 s window and the music must return to full
  level within 1 s after the voice ends.
- Track start must never wait on the DJ (FR-008), and no DJ failure may reach playback
  (SC-008).
- Operators who never configure the DJ (FR-030) should take on no new risk.
- No new runtime dependencies (Principle V).

## Options

### Option A — Own the PCM transcode and mix in a Transform

Move the FFmpeg transcode out of `@discordjs/voice` and into our code, then pass the
PCM through a small mixing `Transform` before handing it to the library as
`StreamType.Raw`.

### Option B — FFmpeg `amix` / `sidechaincompress`

Let FFmpeg mix the two inputs. Both inputs must exist when FFmpeg starts, so inserting a
voice mid-track means restarting FFmpeg, which causes a gap or a seek.

### Option C — `inlineVolume` only

Can duck the music but cannot layer a second source.

### Option D — A second AudioPlayer for the voice

A connection subscribes to one player at a time, so the two cannot play together.

### Option E — A mixer npm package (`node-audio-mixer`, `@wetalabs/mixer`)

Adds a dependency for roughly 80 lines of code whose envelope and cancel semantics we
need exact control over.

## Decision

**Adopt Option A**, and only when the DJ is configured.

```
yt-dlp ──► ffmpeg (-f s16le -ar 48000 -ac 2) ──► DuckingMixer (Transform) ──► createAudioResource(StreamType.Raw)
                                                       ▲
                                     overlay(pcmBuffer) │ DJ line, 48 kHz s16le stereo
```

- `src/integrations/youtube.js` gains `getPcmStream(url)`. It wraps the existing
  `getStream(url)` output in our own FFmpeg child:
  `ffmpeg -hide_banner -loglevel error -i pipe:0 -f s16le -ar 48000 -ac 2 pipe:1`.
  FFmpeg is resolved from `ffmpeg-static` (already a dependency), falling back to
  `ffmpeg` on `PATH`, the same way prism-media resolves it. The FFmpeg kill is folded
  into the same idempotent `cleanup`, and the startup watchdog and drain semantics are
  unchanged. CPU is unchanged too: `Arbitrary` already spawns exactly this FFmpeg inside
  the library, so it moves rather than multiplies.
- `src/core/audioMixer.js` exports `DuckingMixer`, a `Transform` over s16le stereo
  frames that imports nothing but `node:stream`. With no overlay it passes music through
  untouched. `overlay(buffer)` ramps the music gain linearly from 1.0 to 0.3 over 200 ms,
  adds the overlay samples and clamps to int16; when the overlay runs out the gain ramps
  back to 1.0 over 300 ms. `cancelOverlay()` drops the rest of the overlay and starts the
  release ramp. A partial frame at a chunk boundary is carried into the next chunk. Its
  `highWaterMark` is 5 frames of 20 ms, so it adds about 100 ms of read-ahead.
- `MusicPlayer` creates one mixer per track and exposes `overlay(pcm)`,
  `cancelOverlay()` and `setMixingEnabled(bool)`. It calls `cancelOverlay()` itself
  from `pause()`, `stop()` and `play()`, so cutting the DJ off works the same from every
  transport. Because the overlay lives in the track's own mixer, it can never carry over
  into the next track.
- **Dual path.** `setMixingEnabled(true)` is called once at boot only when
  `isDjConfigured()` is true. When the DJ is not configured, `player.play()` keeps
  today's `StreamType.Arbitrary` path byte for byte. When it is configured, every track
  uses the PCM path whether commentary is on or off, so turning the DJ on mid-session
  takes effect at the next track without switching pipelines.

## Consequences

Positive: the DJ can speak over music with ducking, using no new dependency and no new
binary; operators who leave the DJ unconfigured run exactly the code they run today;
cutting the voice off on pause, stop, skip or queue clear is enforced in one place.

Negative: when the DJ is configured, the transcode is our code's responsibility rather
than the library's, so a regression there affects every track. The PCM path is covered
by `test/core/audioMixer.test.js` and `test/core/player-overlay.test.js`, and
quickstart checks it plays identically to the legacy path.

### Follow-up task list (actionable)

1. **Volume control must multiply into the mixer gain.** The bot has no volume feature,
   so the ducking gain is relative to unity. A future volume feature must multiply its
   level into `DuckingMixer`'s gain rather than add a separate `inlineVolume` stage, or
   the duck level and the volume will fight. Effort: low. Risk: low.
