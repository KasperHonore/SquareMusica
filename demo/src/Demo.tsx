import React from 'react';
import { AbsoluteFill, Sequence } from 'remotion';
import { TransitionSeries, linearTiming } from '@remotion/transitions';
import { slide } from '@remotion/transitions/slide';
import { colors, DESIGN, DESIGN_SCALE } from './theme';
import { ease } from './motion';
import { ColdOpen, COLD_OPEN } from './scenes/ColdOpen';
import { DiscordMoment, DISCORD_MOMENT } from './scenes/DiscordMoment';
import { CommandsMoment, COMMANDS_MOMENT } from './scenes/CommandsMoment';
import { WebAct, WEB_ACT } from './scenes/WebAct';
import { PlaylistMoment, PLAYLIST_MOMENT } from './scenes/PlaylistMoment';
import { InSyncMoment, IN_SYNC } from './scenes/InSyncMoment';
import { AuthMoment, AUTH_MOMENT } from './scenes/AuthMoment';
import { QuietBeat, QUIET_BEAT } from './scenes/QuietBeat';
import { Outro, OUTRO } from './scenes/Outro';

const T = 9; // whip-slide transition length
const WHIPS = 1;

export const DEMO_DURATION =
  COLD_OPEN +
  DISCORD_MOMENT +
  COMMANDS_MOMENT +
  WEB_ACT +
  PLAYLIST_MOMENT +
  IN_SYNC +
  AUTH_MOMENT +
  QUIET_BEAT +
  OUTRO -
  T * WHIPS;

// GIF excerpt of the WebAct: mid-search hold → click → pan → the queue moves.
const GIF_WEBACT_FROM = 180;
const GIF_WEBACT_LEN = 240;

export const DEMO_GIF_DURATION =
  COLD_OPEN + COMMANDS_MOMENT + GIF_WEBACT_LEN + OUTRO;

const whip = () => linearTiming({ durationInFrames: T, easing: ease.whip });

/**
 * Scenes are authored at 1280x720; this wrapper raster-scales them to the
 * 1920x1080 composition so text and SVG stay vector-crisp at render time.
 */
const DesignScale: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <AbsoluteFill style={{ backgroundColor: colors.bg }}>
    <div
      style={{
        position: 'absolute',
        top: 0,
        left: 0,
        width: DESIGN.width,
        height: DESIGN.height,
        scale: `${DESIGN_SCALE}`,
        transformOrigin: 'top left',
      }}
    >
      {children}
    </div>
  </AbsoluteFill>
);

/**
 * Full marketing cut (~45s), three acts on the 120 BPM grid:
 *   Discord — /play, the 14-command wall, /webui flying into the lens
 *   Web     — one continuous camera: reveal → search → queue → transport, then playlists
 *   Trust   — real-time sync, OAuth guild lock, a bar of silence, the slam
 */
export const Demo: React.FC = () => (
  <DesignScale>
    <TransitionSeries>
      <TransitionSeries.Sequence durationInFrames={COLD_OPEN}>
        <ColdOpen />
      </TransitionSeries.Sequence>

      <TransitionSeries.Transition presentation={slide({ direction: 'from-right' })} timing={whip()} />

      <TransitionSeries.Sequence durationInFrames={DISCORD_MOMENT}>
        <DiscordMoment />
      </TransitionSeries.Sequence>

      {/* hard cut on the beat */}
      <TransitionSeries.Sequence durationInFrames={COMMANDS_MOMENT}>
        <CommandsMoment />
      </TransitionSeries.Sequence>

      {/* /webui flies into the lens; the URL pill catches it on the other side */}
      <TransitionSeries.Sequence durationInFrames={WEB_ACT}>
        <WebAct />
      </TransitionSeries.Sequence>

      {/* hard cut on the beat */}
      <TransitionSeries.Sequence durationInFrames={PLAYLIST_MOMENT}>
        <PlaylistMoment />
      </TransitionSeries.Sequence>

      {/* hard cut under a light leak */}
      <TransitionSeries.Sequence durationInFrames={IN_SYNC}>
        <InSyncMoment />
      </TransitionSeries.Sequence>

      {/* hard cut on the beat */}
      <TransitionSeries.Sequence durationInFrames={AUTH_MOMENT}>
        <AuthMoment />
      </TransitionSeries.Sequence>

      {/* everything drops out */}
      <TransitionSeries.Sequence durationInFrames={QUIET_BEAT}>
        <QuietBeat />
      </TransitionSeries.Sequence>

      {/* the slam */}
      <TransitionSeries.Sequence durationInFrames={OUTRO}>
        <Outro />
      </TransitionSeries.Sequence>
    </TransitionSeries>
  </DesignScale>
);

/** Condensed cut for the inline README GIF — hero, commands, web-act excerpt, outro. */
export const DemoGif: React.FC = () => (
  <DesignScale>
    <Sequence durationInFrames={COLD_OPEN}>
      <ColdOpen />
    </Sequence>
    <Sequence from={COLD_OPEN} durationInFrames={COMMANDS_MOMENT}>
      <CommandsMoment />
    </Sequence>
    <Sequence from={COLD_OPEN + COMMANDS_MOMENT} durationInFrames={GIF_WEBACT_LEN}>
      {/* Trim into the WebAct mid-scene: negative offset skips its first frames */}
      <Sequence from={-GIF_WEBACT_FROM}>
        <WebAct />
      </Sequence>
    </Sequence>
    <Sequence from={COLD_OPEN + COMMANDS_MOMENT + GIF_WEBACT_LEN} durationInFrames={OUTRO}>
      <Outro />
    </Sequence>
  </DesignScale>
);
