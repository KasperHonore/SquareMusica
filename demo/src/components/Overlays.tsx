import React from 'react';
import { AbsoluteFill, useCurrentFrame } from 'remotion';
import { colors } from '../theme';
import { beatPulse } from '../motion';

const NOISE =
  "url(\"data:image/svg+xml,%3Csvg viewBox='0 0 256 256' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='4' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)'/%3E%3C/svg%3E\")";

/** Subtle film grain that jitters every frame so it never looks static. */
export const Grain: React.FC<{ opacity?: number }> = ({ opacity = 0.06 }) => {
  const frame = useCurrentFrame();
  const dx = (frame * 37) % 200;
  const dy = (frame * 53) % 200;
  return (
    <AbsoluteFill
      style={{
        opacity,
        backgroundImage: NOISE,
        backgroundSize: '256px 256px',
        backgroundPosition: `${dx}px ${dy}px`,
        mixBlendMode: 'overlay',
        pointerEvents: 'none',
      }}
    />
  );
};

/** Cinematic edge darkening — warm blacks, so the grade never goes cold. */
export const Vignette: React.FC<{ strength?: number }> = ({ strength = 0.5 }) => (
  <AbsoluteFill
    style={{
      background: `radial-gradient(ellipse at center, transparent 52%, rgba(14, 9, 3, ${strength}) 100%)`,
      pointerEvents: 'none',
    }}
  />
);

/** Gold radial bloom that flares on every beat. */
export const BeatGlow: React.FC<{ x?: string; y?: string; size?: number; base?: number; amp?: number }> = ({
  x = '50%',
  y = '50%',
  size = 900,
  base = 0.1,
  amp = 0.5,
}) => {
  const frame = useCurrentFrame();
  const glow = base + beatPulse(frame, undefined, 2.2) * amp;
  return (
    <AbsoluteFill
      style={{
        background: `radial-gradient(circle at ${x} ${y}, rgba(232,200,122,${glow}) 0%, transparent ${size / 20}%)`,
        mixBlendMode: 'screen',
        pointerEvents: 'none',
      }}
    />
  );
};

/** Full-bleed dark base with the signature gold radial atmosphere. */
export const Stage: React.FC<{ children?: React.ReactNode }> = ({ children }) => (
  <AbsoluteFill style={{ backgroundColor: colors.bg }}>
    <AbsoluteFill
      style={{
        background:
          'radial-gradient(ellipse at 50% 42%, rgba(232,200,122,0.08) 0%, transparent 55%)',
      }}
    />
    {children}
  </AbsoluteFill>
);
