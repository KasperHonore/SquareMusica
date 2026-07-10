import React from 'react';
import { AbsoluteFill } from 'remotion';
import { DESIGN } from '../theme';
import { Stage, Vignette, Grain } from './Overlays';
import { Waveform } from './Waveform';

/** Shared scene chrome: dark gold-lit stage, a bottom waveform motif, warm grade, vignette + grain. */
export const SceneFrame: React.FC<{
  children: React.ReactNode;
  wave?: boolean;
  waveOpacity?: number;
}> = ({ children, wave = true, waveOpacity = 0.4 }) => (
  <Stage>
    <AbsoluteFill style={{ filter: 'contrast(1.03) saturate(1.06)' }}>{children}</AbsoluteFill>
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
        <Waveform width={DESIGN.width * 0.92} height={76} bars={80} />
      </div>
    )}
    {/* Warm grade: faint gold lift at the top, screen-blended */}
    <AbsoluteFill
      style={{
        background: 'linear-gradient(180deg, rgba(232,200,122,0.05), transparent 32%)',
        mixBlendMode: 'screen',
        pointerEvents: 'none',
      }}
    />
    <Vignette strength={0.55} />
    <Grain />
  </Stage>
);
