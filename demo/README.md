# SquareMusica demo (Remotion)

The animated demo at the top of the main [README](../README.md) is generated
with [Remotion](https://www.remotion.dev/) — the whole UI is recreated in React
using the app's real Wave design tokens (`../web/src/index.css`), so it stays in
sync with how SquareMusica actually looks. No screen recording, Discord token, or
running bot is required.

## Preview live

```bash
cd demo
npm install
npm run studio      # opens Remotion Studio at http://localhost:3000
```

Scrub the timeline, tweak a scene, and see changes instantly.

## Re-render the video

```bash
npm run render      # -> out/demo.mp4   (full ~45s marketing cut, 1920x1080)
npm run render:gif  # -> out/demo.gif   (condensed cut for the README)
```

Scenes are authored at 1280x720 and raster-scaled 1.5x by the `DesignScale`
wrapper in `Demo.tsx`, so text stays vector-crisp at 1080p.

The optimized GIF committed to `../docs/demo.gif` is produced from the `DemoGif`
render with ffmpeg's two-pass palette + gifsicle. Floyd–Steinberg dithering keeps
the large gold glow gradients from banding:

```bash
npx remotion render DemoGif out/demo_gif_src.mp4
ffmpeg -y -i out/demo_gif_src.mp4 -vf "fps=15,scale=900:-1:flags=lanczos,palettegen=stats_mode=diff:max_colors=220" out/pal.png
ffmpeg -y -i out/demo_gif_src.mp4 -i out/pal.png -lavfi "fps=15,scale=900:-1:flags=lanczos[x];[x][1:v]paletteuse=dither=floyd_steinberg" out/demo.gif
npx gifsicle -O3 --lossy=60 out/demo.gif -o ../docs/demo.gif
```

To get a **native inline video player** on GitHub (with audio support, higher
fidelity than a GIF), drag `out/demo.mp4` into a new GitHub issue/PR comment and
paste the resulting `user-attachments` URL into the README.

## Design direction — "on the beat"

The video is choreographed to a **120 BPM grid** (`src/motion.ts`: 1 beat = 15
frames): every entrance, hard cut, and glow flare lands on a beat, so it reads as
musical even as a silent GIF. Scenes are **video-first** — one bold headline per
beat, the real UI shown as a camera-framed browser mockup (`AppWindow`), a gold
`Waveform` motif running throughout, plus grain + vignette + beat-reactive glow.
Cuts use `@remotion/transitions` (whip slides + on-beat hard cuts), never a
fade-to-black. To add a real soundtrack later, drop a track in `public/` and
swap the synthetic waveform for `visualizeAudio()` from `@remotion/media-utils`.

## Structure

```
src/
  Root.tsx            # registers the Demo + DemoGif compositions
  Demo.tsx            # sequences scenes with TransitionSeries
  motion.ts           # beat grid + easing presets (ease.bigPop, whip, ...)
  theme.ts            # Wave design tokens (ported from web/src/index.css)
  fonts.ts            # Instrument Serif + DM Sans via @remotion/google-fonts
  data.ts             # demo tracks / playlists (fictional, copyright-clean)
  components/         # SceneFrame, AppWindow, Waveform, Overlays, Kinetic,
                      # Finishing (shine/fringe/flash/ramp), Dashboard shell,
                      # DiscordCard, QueueCard, SearchCard, TransportCard, ...
  scenes/             # three acts: Discord -> web -> trust
    ColdOpen          # beat-drop wordmark + waveform (warm flash + RGB fringe)
    DiscordMoment     # "Just type /play" + bot embed
    CommandsMoment    # 14-command wall over a ghost "14"; /webui flies into the lens
    WebAct            # ONE continuous camera: browser reveal -> a gold dot swallows
                      # the frame -> whip-pans between Search, Queue and Transport
                      # stations (giant PAUSE/SKIP/LOOP type behind the transport)
    PlaylistMoment    # asymmetric: message rail left, cascade card bleeding off right
    InSyncMoment      # "Everyone stays in sync" — Discord + web pulse together
    AuthMoment        # Discord OAuth gate — locked to your server
    QuietBeat         # one bar of silence: just the gold dot breathing
    Outro             # wordmark slam, feature chips, waveform collapses to the dot
```

Finishing pass: warm-black vignette + gold grade in `SceneFrame`, card shines on
landing, chromatic fringe on slams, `@remotion/light-leaks` at act changes, and
speed-ramped exits into hard cuts.

Requires Node 22+. Remotion downloads a headless Chrome on first render.
`out/` is git-ignored; the shipped assets live in `../docs/`.
