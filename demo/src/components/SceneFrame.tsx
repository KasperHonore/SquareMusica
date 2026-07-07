import React from 'react';
import { AbsoluteFill, useVideoConfig } from 'remotion';
import { Stage, Vignette, Grain } from './Overlays';
import { Waveform } from './Waveform';

/** Shared scene chrome: dark gold-lit stage, a bottom waveform motif, vignette + grain. */
export const SceneFrame: React.FC<{
  children: React.ReactNode;
  wave?: boolean;
  waveOpacity?: number;
}> = ({ children, wave = true, waveOpacity = 0.4 }) => {
  const { width } = useVideoConfig();
  return (
    <Stage>
      <AbsoluteFill>{children}</AbsoluteFill>
      {wave && (
        <div
          style={{
            position: 'absolute',
            left: 0,
            right: 0,
            bottom: -6,
            display: 'flex',
            justifyContent: 'center',
            opacity: waveOpacity,
            WebkitMaskImage: 'linear-gradient(90deg, transparent, #000 14%, #000 86%, transparent)',
            maskImage: 'linear-gradient(90deg, transparent, #000 14%, #000 86%, transparent)',
          }}
        >
          <Waveform width={width * 0.92} height={76} bars={80} />
        </div>
      )}
      <Vignette strength={0.55} />
      <Grain />
    </Stage>
  );
};
