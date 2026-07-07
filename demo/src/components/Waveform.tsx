import React from 'react';
import { useCurrentFrame } from 'remotion';
import { colors } from '../theme';
import { beatPulse } from '../motion';

/**
 * Synthetic gold waveform — the connective motif that runs through the whole
 * video and jumps on every beat. Deterministic function of frame (no real audio
 * needed); swap for @remotion/media-utils visualizeAudio() if a track is added.
 */
export const Waveform: React.FC<{
  width: number;
  height?: number;
  bars?: number;
  intensity?: number;
  color?: string;
  glow?: boolean;
}> = ({ width, height = 120, bars = 72, intensity = 1, color = colors.accent, glow = true }) => {
  const frame = useCurrentFrame();
  const pulse = beatPulse(frame, undefined, 2.5);
  const gap = 3;
  const barW = Math.max(2, width / bars - gap);

  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap, width, height }}>
      {Array.from({ length: bars }).map((_, i) => {
        // Envelope taller toward the middle; layered sines make it read as audio.
        const env = 0.35 + 0.65 * Math.sin((i / (bars - 1)) * Math.PI);
        const wobble =
          0.5 +
          0.5 * Math.sin(i * 0.45 + frame * 0.22) * Math.sin(i * 0.13 - frame * 0.09);
        const amp = Math.max(0.05, env * (0.28 + wobble * 0.5) * (0.55 + pulse * 0.9) * intensity);
        const h = Math.min(1, amp) * height;
        return (
          <div
            key={i}
            style={{
              width: barW,
              height: h,
              borderRadius: barW,
              background: color,
              boxShadow: glow ? `0 0 ${6 + pulse * 14}px rgba(232,200,122,${0.25 + pulse * 0.4})` : 'none',
            }}
          />
        );
      })}
    </div>
  );
};
