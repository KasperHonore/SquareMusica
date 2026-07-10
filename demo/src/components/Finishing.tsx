import React from 'react';
import { AbsoluteFill, interpolate, useCurrentFrame } from 'remotion';
import { ease, enter } from '../motion';

/**
 * Finishing-pass primitives: momentary light events and cut energy.
 * All of these are deliberately brief — they exist for a handful of frames
 * around a slam or a cut, never as a constant effect.
 */

/** Specular sweep across a card face right after it lands. Parent needs position: relative. */
export const CardShine: React.FC<{ at: number; dur?: number; radius?: number }> = ({
  at,
  dur = 16,
  radius = 14,
}) => {
  const frame = useCurrentFrame();
  const p = enter(frame, at, dur, ease.inOut);
  if (p <= 0.001 || p >= 0.999) return null;
  return (
    <div style={{ position: 'absolute', inset: 0, borderRadius: radius, overflow: 'hidden', pointerEvents: 'none' }}>
      <div
        style={{
          position: 'absolute',
          top: '-45%',
          bottom: '-45%',
          width: '32%',
          left: `${-45 + p * 190}%`,
          rotate: '16deg',
          background:
            'linear-gradient(90deg, transparent, rgba(255,244,214,0.12), rgba(255,255,255,0.05), transparent)',
        }}
      />
    </div>
  );
};

/** RGB-split fringe that spikes at `at` and decays — wrap only the slamming element. */
export const Fringe: React.FC<{ at: number; amp?: number; dur?: number; children: React.ReactNode }> = ({
  at,
  amp = 3,
  dur = 9,
  children,
}) => {
  const frame = useCurrentFrame();
  const k = frame >= at ? Math.max(0, 1 - (frame - at) / dur) : 0;
  const px = k * k * amp;
  return (
    <div
      style={{
        filter:
          px > 0.08
            ? `drop-shadow(${px}px 0 0 rgba(255,70,90,0.5)) drop-shadow(${-px}px 0 0 rgba(90,220,255,0.45))`
            : 'none',
      }}
    >
      {children}
    </div>
  );
};

/** Gold-tinted flash (screen blend) — warmer than a pure white pop. */
export const WarmFlash: React.FC<{ at: number; peak?: number; rise?: number; fall?: number }> = ({
  at,
  peak = 0.5,
  rise = 4,
  fall = 12,
}) => {
  const frame = useCurrentFrame();
  const o = interpolate(frame, [at, at + rise, at + rise + fall], [0, peak, 0], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });
  return (
    <AbsoluteFill style={{ background: '#ffe9c4', opacity: o, mixBlendMode: 'screen', pointerEvents: 'none' }} />
  );
};

/** Speed-ramp into a hard cut: the frame accelerates and smears over the last few frames. */
export const ExitRamp: React.FC<{ from: number; dur?: number; children: React.ReactNode }> = ({
  from,
  dur = 8,
  children,
}) => {
  const frame = useCurrentFrame();
  const p = enter(frame, from, dur, ease.rampIn);
  return (
    <AbsoluteFill
      style={{
        scale: `${1 + p * 0.07}`,
        filter: p > 0.02 ? `blur(${p * 3}px)` : 'none',
      }}
    >
      {children}
    </AbsoluteFill>
  );
};
