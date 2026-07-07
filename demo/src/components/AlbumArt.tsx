/**
 * Deterministic gradient album art. A seed maps to a stable pair of hues so the
 * same track always gets the same cover — no network images, no copyright.
 */
import React from 'react';
import { MusicNote } from './Icons';

const hueFromSeed = (seed: number) => (seed * 47) % 360;

export const coverGradient = (seed: number) => {
  const h1 = hueFromSeed(seed);
  const h2 = (h1 + 40) % 360;
  return `linear-gradient(135deg, hsl(${h1} 55% 42%) 0%, hsl(${h2} 60% 26%) 100%)`;
};

export const AlbumArt: React.FC<{
  seed: number;
  size: number;
  radius?: number;
  note?: boolean;
  style?: React.CSSProperties;
}> = ({ seed, size, radius = 7, note = true, style }) => (
  <div
    style={{
      width: size,
      height: size,
      borderRadius: radius,
      background: coverGradient(seed),
      flexShrink: 0,
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      overflow: 'hidden',
      boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.12)',
      ...style,
    }}
  >
    {note && <MusicNote size={size * 0.42} color="rgba(255,255,255,0.55)" />}
  </div>
);
