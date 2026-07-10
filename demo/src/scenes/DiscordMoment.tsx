import React from 'react';
import { AbsoluteFill, useCurrentFrame } from 'remotion';
import { colors } from '../theme';
import { fontHeading } from '../fonts';
import { SceneFrame } from '../components/SceneFrame';
import { DiscordCard } from '../components/DiscordCard';
import { Kicker, RiseIn } from '../components/Kinetic';
import { CardShine, ExitRamp } from '../components/Finishing';
import { ease, enter } from '../motion';

export const DISCORD_MOMENT = 105;

export const DiscordMoment: React.FC = () => {
  const frame = useCurrentFrame();

  const cardIn = enter(frame, 18, 14, ease.bigPop);
  const embedIn = enter(frame, 34, 15, ease.crisp);

  return (
    <SceneFrame>
      <ExitRamp from={DISCORD_MOMENT - 8}>
        <AbsoluteFill style={{ flexDirection: 'column', alignItems: 'center', paddingTop: 64, gap: 30 }}>
          {/* Headline */}
          <div style={{ textAlign: 'center' }}>
            <RiseIn frame={frame} start={0}>
              <Kicker>In Discord</Kicker>
            </RiseIn>
            <RiseIn frame={frame} start={7} style={{ marginTop: 10 }}>
              <div style={{ fontFamily: fontHeading, fontSize: 76, color: colors.textPrimary, lineHeight: 1.05, letterSpacing: '-1px' }}>
                Just type <span style={{ color: colors.accent }}>/play</span>
              </div>
            </RiseIn>
          </div>

          {/* Discord card punches in */}
          <div style={{ position: 'relative', opacity: cardIn, scale: 0.9 + cardIn * 0.1 }}>
            <DiscordCard width={640} embedIn={embedIn} />
            <CardShine at={34} />
          </div>
        </AbsoluteFill>
      </ExitRamp>
    </SceneFrame>
  );
};
