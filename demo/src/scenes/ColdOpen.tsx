import React from 'react';
import { AbsoluteFill, interpolate, useCurrentFrame } from 'remotion';
import { colors } from '../theme';
import { fontHeading, fontBody } from '../fonts';
import { SceneFrame } from '../components/SceneFrame';
import { Waveform } from '../components/Waveform';
import { BeatGlow } from '../components/Overlays';
import { Fringe, WarmFlash } from '../components/Finishing';
import { ease, enter } from '../motion';

export const COLD_OPEN = 90;

export const ColdOpen: React.FC = () => {
  const frame = useCurrentFrame();

  const waveGrow = enter(frame, 0, 26, ease.crisp);
  const slam = enter(frame, 30, 12, ease.bigPop);
  const wordScale = interpolate(slam, [0, 1], [1.4, 1]);
  const wordOpacity = enter(frame, 30, 7, ease.crisp);
  const tag = enter(frame, 40, 15);
  const push = interpolate(frame, [30, COLD_OPEN], [1, 1.04]);

  return (
    <SceneFrame wave={false}>
      <BeatGlow y="48%" base={0.12} amp={0.6} />

      {/* Building waveform, low third */}
      <AbsoluteFill style={{ alignItems: 'center', justifyContent: 'flex-end', paddingBottom: 96 }}>
        <div style={{ opacity: waveGrow * 0.95, scale: `1 ${0.4 + waveGrow * 0.6}` }}>
          <Waveform width={780} height={168} bars={68} />
        </div>
      </AbsoluteFill>

      {/* Wordmark lockup */}
      <AbsoluteFill style={{ alignItems: 'center', justifyContent: 'center', flexDirection: 'column', scale: push }}>
        <Fringe at={30} amp={4}>
          <div
            style={{
              fontFamily: fontHeading,
              fontSize: 120,
              color: colors.textPrimary,
              letterSpacing: '-2px',
              lineHeight: 1,
              opacity: wordOpacity,
              scale: wordScale,
              textShadow: '0 8px 60px rgba(0,0,0,0.6)',
            }}
          >
            SquareMusica<span style={{ color: colors.accent }}>.</span>
          </div>
        </Fringe>
        <div
          style={{
            marginTop: 20,
            fontFamily: fontBody,
            fontSize: 27,
            color: colors.textSecondary,
            opacity: tag,
            translate: `0px ${(1 - tag) * 12}px`,
          }}
        >
          A Discord music bot you can actually see.
        </div>
      </AbsoluteFill>

      {/* Slam flash */}
      <WarmFlash at={30} peak={0.55} />
    </SceneFrame>
  );
};
