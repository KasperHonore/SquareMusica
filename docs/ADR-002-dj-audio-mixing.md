# ADR-002: Mixing the AI DJ voice over the music

- Status: Accepted
- Date: 2026-10-08
- Deciders: maintainers

## Context

Feature 002 (AI DJ host) needs a short spoken line to play over the opening of a track,
with the music lowered ("ducked") while the voice speaks and restored afterwards.

The bot cannot do this today:

- `src/core/player.js` builds every resource as
  `createAudioResource(stream, { inputType: streamResult.type })`, and
  `src/integrations/youtube.js` `getStream()` returns `StreamType.Arbitrary`.
  `@discordjs/voice` then runs FFmpeg and the Opus encoder internally, so our code never
  sees PCM samples.
- There is no `inlineVolume` and no volume feature anywhere in `src/` or `web/src/`.
- An `AudioPlayer` plays exactly one resource at a time, a voice connection subscribes to
  exactly one player, and `@discordjs/voice` has no mixer.

## Decision Drivers

- The voice must be layered over the music, not played instead of it.
- Ducking must start within FR-003's 2 s window and restore within 1 s.
- Operators who never configure the DJ must take no new risk (FR-030).
- No new runtime dependencies (Constitution V posture).
- Pause, stop, skip and queue clear must silence the DJ on every transport without
  per-transport code (FR-009, Constitution III).

## Options

### Option A: Move the PCM transcode into our code and mix in a Transform

`integrations/youtube.js` gains `getPcmStream(url)`. It pipes the existing `getStream`
output into our own FFmpeg child, resolved from `ffmpeg-static` with a fallback to
`ffmpeg` on `PATH`:

```
ffmpeg -hide_banner -loglevel error -i pipe:0 -f s16le -ar 48000 -ac 2 pipe:1
```

The FFmpeg kill is folded into the same idempotent `cleanup`, and the yt-dlp startup
watchdog and drain semantics are unchanged.

`core/audioMixer.js` exports `DuckingMixer`, a `Transform` over s16le stereo frames
(imports only `node:stream`). It passes music through untouched with no overlay. With an
overlay it ramps the music gain linearly per sample from 1.0 to 0.3 over 200 ms, adds the
overlay samples and clamps to int16; when the overlay is exhausted (or `cancelOverlay()`
is called) it ramps back to 1.0 over 300 ms. A partial frame at a chunk boundary is
carried into the next chunk. `highWaterMark` is 5 frames of 20 ms to keep onset latency
small.

```
yt-dlp ──► ffmpeg (s16le 48k stereo) ──► DuckingMixer ──► createAudioResource(StreamType.Raw)
                                              ▲
                                overlay(pcm)  │  DJ line, 48 kHz s16le stereo
```

`MusicPlayer` creates one mixer per track, exposes `overlay(pcm)` and `cancelOverlay()`,
and calls `cancelOverlay()` itself from `pause()`, `stop()` and `play()`.

### Option B: FFmpeg `amix` / `sidechaincompress`

Both inputs must exist when FFmpeg starts. Inserting a voice mid-stream means restarting
FFmpeg, which causes a gap or a seek. Rejected.

### Option C: `inlineVolume` only

Can duck the music but cannot layer a second source. Rejected.

### Option D: A second AudioPlayer for the voice

A connection subscribes to one player at a time. Rejected.

### Option E: A mixer npm package (`node-audio-mixer`, `@wetalabs/mixer`)

Adds a dependency for about 80 lines of code whose ramp envelope and cancel semantics we
need exact control over. Rejected.

## Decision

**Adopt Option A, behind a dual path.** `player.setMixingEnabled(true)` is called at boot
only when `isDjConfigured()` is true. When the DJ is unconfigured, `player.play()` keeps
the legacy `StreamType.Arbitrary` path byte-for-byte, so those operators run no FFmpeg
child of ours. When it is configured, every track uses the PCM path whether commentary is
on or off, so enabling the DJ mid-session takes effect at the next track without
switching pipelines.

## Consequences

Positive: the voice is mixed in-process with exact control of the ducking envelope; the
overlay lives inside the track's own mixer and cannot leak into the next track; pause,
stop, skip and queue clear cancel it centrally. CPU is unchanged, because `Arbitrary`
already spawned this same FFmpeg inside the library: it has moved, not multiplied.

Negative: two audio paths exist and both must be kept working; the PCM path owns an extra
child process whose lifecycle our `cleanup` must manage.

### Follow-up task list (actionable)

1. **Volume control** — the bot has no volume feature, so the ducking gain is relative to
   unity. A future volume feature MUST multiply into the `DuckingMixer` gain rather than
   add a second gain stage (e.g. `inlineVolume`), or ducking and volume will fight.
2. **Retire the legacy path** — once the PCM path has run in production long enough,
   consider using it unconditionally and deleting the `Arbitrary` branch.
