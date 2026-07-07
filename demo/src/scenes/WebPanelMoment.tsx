import React from 'react';
import { AbsoluteFill, interpolate, useCurrentFrame } from 'remotion';
import { colors } from '../theme';
import { fontHeading } from '../fonts';
import { SceneFrame } from '../components/SceneFrame';
import { AppMock } from '../components/AppWindow';
import { BrowseCenter } from '../components/DashCenters';
import { Kicker, RiseIn } from '../components/Kinetic';
import { ease, enter } from '../motion';
import { NOW_PLAYING } from '../data';

export const WEB_PANEL = 120;

export const WebPanelMoment: React.FC = () => {
  const frame = useCurrentFrame();

  const inn = enter(frame, 16, 18, ease.overshoot);
  const opacity = enter(frame, 16, 12, ease.crisp);
  const push = interpolate(frame, [30, WEB_PANEL], [1, 1.035]);
  const tilt = interpolate(inn, [0, 1], [7, 0]);
  const ty = interpolate(inn, [0, 1], [70, 0]);
  const s = (0.92 + inn * 0.08) * push;

  return (
    <SceneFrame>
      <AbsoluteFill style={{ flexDirection: 'column', alignItems: 'center', paddingTop: 46 }}>
        <div style={{ textAlign: 'center' }}>
          <RiseIn frame={frame} start={0}>
            <Kicker>The web panel</Kicker>
          </RiseIn>
          <RiseIn frame={frame} start={7} style={{ marginTop: 10 }}>
            <div style={{ fontFamily: fontHeading, fontSize: 72, color: colors.textPrimary, lineHeight: 1.05, letterSpacing: '-1px' }}>
              Control it from <span style={{ color: colors.accent }}>anywhere</span>
            </div>
          </RiseIn>
        </div>

        <div
          style={{
            marginTop: 30,
            opacity,
            transform: `perspective(1400px) rotateX(${tilt}deg) scale(${s}) translateY(${ty}px)`,
            transformOrigin: 'center top',
          }}
        >
          <AppMock width={820} view="search" center={<BrowseCenter />} player={{ track: NOW_PLAYING, playing: true, progress: 32 }} />
        </div>
      </AbsoluteFill>
    </SceneFrame>
  );
};
