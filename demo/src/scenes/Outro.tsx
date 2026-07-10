import React from 'react';
import { AbsoluteFill, interpolate, useCurrentFrame } from 'remotion';
import { colors } from '../theme';
import { fontHeading, fontBody } from '../fonts';
import { SceneFrame } from '../components/SceneFrame';
import { Waveform } from '../components/Waveform';
import { BeatGlow } from '../components/Overlays';
import { Fringe, WarmFlash } from '../components/Finishing';
import { ease, enter } from '../motion';

export const OUTRO = 120;

const FEATURES = [
  'YouTube + Spotify',
  '14 slash commands',
  'Drag & drop queue',
  'Loop · shuffle · history',
  'Real-time sync',
  'Discord OAuth',
];

export const Outro: React.FC = () => {
  const frame = useCurrentFrame();

  const slam = enter(frame, 14, 12, ease.bigPop);
  const wordScale = interpolate(slam, [0, 1], [1.28, 1]);
  const wordOpacity = enter(frame, 14, 7);
  const tag = enter(frame, 30, 14);
  const cta = enter(frame, 70, 16);

  // Waveform collapses toward a single gold dot.
  const collapse = enter(frame, 60, 22, ease.inOut);
  const waveW = interpolate(collapse, [0, 1], [760, 0]);
  const dot = enter(frame, 74, 12, ease.overshoot);

  return (
    <SceneFrame wave={false}>
      <BeatGlow y="46%" base={0.1} amp={0.55} />

      {/* Collapsing waveform + dot, low third */}
      <AbsoluteFill style={{ alignItems: 'center', justifyContent: 'flex-end', paddingBottom: 104 }}>
        <div style={{ position: 'relative', display: 'flex', alignItems: 'center', justifyContent: 'center', height: 140 }}>
          <div style={{ opacity: (1 - collapse) * 0.9 }}>
            <Waveform width={Math.max(2, waveW)} height={140} bars={64} />
          </div>
          <div
            style={{
              position: 'absolute',
              width: 16,
              height: 16,
              borderRadius: '50%',
              background: colors.accent,
              scale: `${dot}`,
              boxShadow: '0 0 26px rgba(232,200,122,0.8)',
            }}
          />
        </div>
      </AbsoluteFill>

      {/* Lockup */}
      <AbsoluteFill style={{ alignItems: 'center', justifyContent: 'center', flexDirection: 'column' }}>
        <Fringe at={14} amp={4}>
          <div
            style={{
              fontFamily: fontHeading,
              fontSize: 108,
              color: colors.textPrimary,
              letterSpacing: '-2px',
              lineHeight: 1,
              opacity: wordOpacity,
              scale: wordScale,
            }}
          >
            SquareMusica<span style={{ color: colors.accent }}>.</span>
          </div>
        </Fringe>
        <div style={{ marginTop: 18, fontFamily: fontBody, fontSize: 24, color: colors.textSecondary, opacity: tag, translate: `0px ${(1 - tag) * 10}px` }}>
          A Discord music bot you can actually see.
        </div>

        {/* Feature chips */}
        <div style={{ marginTop: 30, display: 'flex', gap: 12, flexWrap: 'wrap', justifyContent: 'center', maxWidth: 820 }}>
          {FEATURES.map((f, i) => {
            const o = enter(frame, 40 + i * 4, 12);
            return (
              <div
                key={f}
                style={{
                  opacity: o,
                  translate: `0px ${(1 - o) * 12}px`,
                  padding: '9px 17px',
                  borderRadius: 9999,
                  border: `1px solid ${colors.borderStrong}`,
                  background: 'rgba(255,255,255,0.03)',
                  color: colors.textPrimary,
                  fontFamily: fontBody,
                  fontSize: 15,
                }}
              >
                {f}
              </div>
            );
          })}
        </div>

        <div style={{ marginTop: 30, fontFamily: fontBody, fontSize: 15, color: colors.textMuted, opacity: cta, display: 'flex', alignItems: 'center', gap: 10 }}>
          <span style={{ color: colors.accent }}>◆</span> Free &amp; open source · MIT License
        </div>
      </AbsoluteFill>

      <WarmFlash at={14} peak={0.45} />
    </SceneFrame>
  );
};
