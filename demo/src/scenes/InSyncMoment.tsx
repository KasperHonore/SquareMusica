import React from 'react';
import { AbsoluteFill, Sequence, useCurrentFrame } from 'remotion';
import { LightLeak } from '@remotion/light-leaks';
import { colors, discord, radius } from '../theme';
import { fontHeading, fontBody } from '../fonts';
import { SceneFrame } from '../components/SceneFrame';
import { AlbumArt } from '../components/AlbumArt';
import { Eq } from '../components/Eq';
import { Kicker, RiseIn } from '../components/Kinetic';
import { ExitRamp } from '../components/Finishing';
import { BEAT, beatPulse, ease, enter } from '../motion';
import { NOW_PLAYING } from '../data';

export const IN_SYNC = 90;

const Chip: React.FC<{ label: string; discordStyle?: boolean; pulse: number }> = ({ label, discordStyle, pulse }) => (
  <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 12, scale: 1 + pulse * 0.03 }}>
    <div
      style={{
        width: 360,
        padding: 18,
        borderRadius: radius.xl,
        background: discordStyle ? discord.bg : colors.bgRaised,
        border: `1px solid ${discordStyle ? 'rgba(0,0,0,0.4)' : colors.borderStrong}`,
        boxShadow: `0 20px 60px rgba(0,0,0,0.5)${discordStyle ? '' : `, 0 0 ${18 + pulse * 24}px rgba(232,200,122,${0.12 + pulse * 0.25})`}`,
        display: 'flex',
        alignItems: 'center',
        gap: 16,
      }}
    >
      <AlbumArt seed={NOW_PLAYING.seed} size={58} radius={9} style={{ boxShadow: `0 0 ${10 + pulse * 20}px rgba(232,200,122,${0.15 + pulse * 0.4})` }} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: 1, color: discordStyle ? discord.textMuted : colors.textMuted }}>
          Now Playing
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 3 }}>
          <div style={{ fontSize: 18, fontWeight: 600, color: discordStyle ? '#fff' : colors.textPrimary, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
            {NOW_PLAYING.title}
          </div>
          <Eq height={14} playing />
        </div>
        <div style={{ fontSize: 13, color: discordStyle ? discord.textMuted : colors.textSecondary }}>{NOW_PLAYING.artist}</div>
      </div>
    </div>
    <div style={{ fontFamily: fontBody, fontSize: 14, fontWeight: 600, color: colors.textSecondary, letterSpacing: 0.4 }}>{label}</div>
  </div>
);

export const InSyncMoment: React.FC = () => {
  const frame = useCurrentFrame();
  const pulse = beatPulse(frame, undefined, 2.2);
  const chipsIn = enter(frame, 15, 14, ease.overshoot);
  const phase = ((frame % BEAT) + BEAT) % BEAT / BEAT;

  return (
    <SceneFrame>
      <ExitRamp from={IN_SYNC - 8}>
      <AbsoluteFill style={{ flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 52, paddingBottom: 40 }}>
        <div style={{ textAlign: 'center' }}>
          <RiseIn frame={frame} start={0}>
            <Kicker>Real-time</Kicker>
          </RiseIn>
          <RiseIn frame={frame} start={7} style={{ marginTop: 10 }}>
            <div style={{ fontFamily: fontHeading, fontSize: 72, color: colors.textPrimary, lineHeight: 1.05, letterSpacing: '-1px' }}>
              Everyone stays <span style={{ color: colors.accent }}>in sync</span>
            </div>
          </RiseIn>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 8, opacity: chipsIn, translate: `0px ${(1 - chipsIn) * 20}px` }}>
          <Chip label="Discord" discordStyle pulse={pulse} />
          {/* Connector with a beat pulse travelling across */}
          <div style={{ position: 'relative', width: 120, height: 4, background: 'rgba(232,200,122,0.25)', borderRadius: 4 }}>
            <div style={{ position: 'absolute', top: -3, left: `${phase * 100}%`, width: 10, height: 10, borderRadius: '50%', background: colors.accent, translate: '-50% 0', boxShadow: '0 0 12px rgba(232,200,122,0.8)' }} />
          </div>
          <Chip label="Web panel" pulse={pulse} />
        </div>
      </AbsoluteFill>
      </ExitRamp>
      <Sequence durationInFrames={26}>
        <AbsoluteFill style={{ opacity: 0.3, mixBlendMode: 'screen', pointerEvents: 'none' }}>
          <LightLeak durationInFrames={26} seed={7} />
        </AbsoluteFill>
      </Sequence>
    </SceneFrame>
  );
};
