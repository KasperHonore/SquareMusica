/**
 * Frame-driven equalizer bars (the app animates these with CSS; here they are
 * deterministic functions of the current frame so renders are reproducible).
 */
import React from 'react';
import { useCurrentFrame, useVideoConfig } from 'remotion';
import { colors } from '../theme';

export const Eq: React.FC<{ bars?: number; height?: number; color?: string; playing?: boolean }> = ({
  bars = 4,
  height = 14,
  color = colors.accent,
  playing = true,
}) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const t = frame / fps;

  return (
    <div style={{ display: 'inline-flex', alignItems: 'flex-end', gap: 2.5, height }}>
      {Array.from({ length: bars }).map((_, i) => {
        const phase = i * 0.9;
        const wave = playing ? 0.35 + 0.65 * Math.abs(Math.sin(t * 6 + phase)) : 0.3;
        return (
          <div
            key={i}
            style={{
              width: 2.5,
              height: `${wave * 100}%`,
              background: color,
              borderRadius: 2,
              transition: 'none',
            }}
          />
        );
      })}
    </div>
  );
};
