import React from 'react';
import { AbsoluteFill } from 'remotion';
import { TransitionSeries, linearTiming } from '@remotion/transitions';
import { slide } from '@remotion/transitions/slide';
import { colors } from './theme';
import { ease } from './motion';
import { ColdOpen, COLD_OPEN } from './scenes/ColdOpen';
import { DiscordMoment, DISCORD_MOMENT } from './scenes/DiscordMoment';
import { WebPanelMoment, WEB_PANEL } from './scenes/WebPanelMoment';
import { ReorderMoment, REORDER_MOMENT } from './scenes/ReorderMoment';
import { InSyncMoment, IN_SYNC } from './scenes/InSyncMoment';
import { Outro, OUTRO } from './scenes/Outro';

const T = 9; // whip-slide transition length

export const DEMO_DURATION =
  COLD_OPEN + DISCORD_MOMENT + WEB_PANEL + REORDER_MOMENT + IN_SYNC + OUTRO - T - T;

export const DEMO_GIF_DURATION = COLD_OPEN + WEB_PANEL + REORDER_MOMENT + OUTRO;

const whip = () => linearTiming({ durationInFrames: T, easing: ease.whip });

export const Demo: React.FC = () => (
  <AbsoluteFill style={{ backgroundColor: colors.bg }}>
    <TransitionSeries>
      <TransitionSeries.Sequence durationInFrames={COLD_OPEN}>
        <ColdOpen />
      </TransitionSeries.Sequence>

      <TransitionSeries.Transition presentation={slide({ direction: 'from-right' })} timing={whip()} />

      <TransitionSeries.Sequence durationInFrames={DISCORD_MOMENT}>
        <DiscordMoment />
      </TransitionSeries.Sequence>

      {/* hard cut on the beat */}
      <TransitionSeries.Sequence durationInFrames={WEB_PANEL}>
        <WebPanelMoment />
      </TransitionSeries.Sequence>

      {/* hard cut on the beat */}
      <TransitionSeries.Sequence durationInFrames={REORDER_MOMENT}>
        <ReorderMoment />
      </TransitionSeries.Sequence>

      <TransitionSeries.Transition presentation={slide({ direction: 'from-bottom' })} timing={whip()} />

      <TransitionSeries.Sequence durationInFrames={IN_SYNC}>
        <InSyncMoment />
      </TransitionSeries.Sequence>

      {/* hard cut on the beat */}
      <TransitionSeries.Sequence durationInFrames={OUTRO}>
        <Outro />
      </TransitionSeries.Sequence>
    </TransitionSeries>
  </AbsoluteFill>
);

/** Condensed cut for the inline README GIF — hero, web panel, reorder, outro. */
export const DemoGif: React.FC = () => (
  <AbsoluteFill style={{ backgroundColor: colors.bg }}>
    <TransitionSeries>
      <TransitionSeries.Sequence durationInFrames={COLD_OPEN}>
        <ColdOpen />
      </TransitionSeries.Sequence>
      <TransitionSeries.Sequence durationInFrames={WEB_PANEL}>
        <WebPanelMoment />
      </TransitionSeries.Sequence>
      <TransitionSeries.Sequence durationInFrames={REORDER_MOMENT}>
        <ReorderMoment />
      </TransitionSeries.Sequence>
      <TransitionSeries.Sequence durationInFrames={OUTRO}>
        <Outro />
      </TransitionSeries.Sequence>
    </TransitionSeries>
  </AbsoluteFill>
);
