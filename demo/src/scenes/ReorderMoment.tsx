import React from 'react';
import { AbsoluteFill, interpolate, useCurrentFrame } from 'remotion';
import { colors } from '../theme';
import { fontHeading } from '../fonts';
import { SceneFrame } from '../components/SceneFrame';
import { QueueCard } from '../components/QueueCard';
import { Kicker, RiseIn } from '../components/Kinetic';
import { ease, enter } from '../motion';

export const REORDER_MOMENT = 120;

export const ReorderMoment: React.FC = () => {
  const frame = useCurrentFrame();

  const cardIn = enter(frame, 14, 14, ease.overshoot);
  // Reorder snaps onto the downbeat at frame 60.
  const p = enter(frame, 46, 16, ease.overshoot);
  const lift = interpolate(frame, [40, 46, 62, 70], [0, 1, 1, 0], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });

  return (
    <SceneFrame>
      <AbsoluteFill style={{ flexDirection: 'column', alignItems: 'center', paddingTop: 52, gap: 26 }}>
        <div style={{ textAlign: 'center' }}>
          <RiseIn frame={frame} start={0}>
            <Kicker>Your queue</Kicker>
          </RiseIn>
          <RiseIn frame={frame} start={7} style={{ marginTop: 10 }}>
            <div style={{ fontFamily: fontHeading, fontSize: 74, color: colors.textPrimary, lineHeight: 1.05, letterSpacing: '-1px' }}>
              <span style={{ color: colors.accent }}>Drag</span> to reorder
            </div>
          </RiseIn>
        </div>

        <div style={{ opacity: cardIn, scale: 0.94 + cardIn * 0.06 }}>
          <QueueCard width={660} p={p} lift={lift} />
        </div>
      </AbsoluteFill>
    </SceneFrame>
  );
};
