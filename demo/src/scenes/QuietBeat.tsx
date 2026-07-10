import React from 'react';
import { AbsoluteFill, useCurrentFrame } from 'remotion';
import { colors } from '../theme';
import { Stage, Vignette, Grain } from '../components/Overlays';
import { beatPulse, enter } from '../motion';

export const QUIET_BEAT = 60;

/**
 * One bar of silence before the final slam: everything drops out except the
 * gold dot, breathing on the beat. The stillness is the point.
 */
export const QuietBeat: React.FC = () => {
  const frame = useCurrentFrame();
  const inn = enter(frame, 0, 12);
  const pulse = beatPulse(frame, undefined, 1.8);

  return (
    <Stage>
      <AbsoluteFill style={{ alignItems: 'center', justifyContent: 'center' }}>
        <div
          style={{
            width: 16,
            height: 16,
            borderRadius: '50%',
            background: colors.accent,
            opacity: inn,
            scale: `${0.9 + pulse * 0.3}`,
            boxShadow: `0 0 ${18 + pulse * 34}px rgba(232, 200, 122, ${0.4 + pulse * 0.45})`,
          }}
        />
      </AbsoluteFill>
      <Vignette strength={0.8} />
      <Grain opacity={0.045} />
    </Stage>
  );
};
