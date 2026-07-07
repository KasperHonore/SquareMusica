import React from 'react';
import { colors } from '../theme';
import { fontBody } from '../fonts';
import { BEAT, ease, enter } from '../motion';

/** Rises + fades into its layout slot over one beat. */
export const RiseIn: React.FC<{
  frame: number;
  start: number;
  dur?: number;
  y?: number;
  children: React.ReactNode;
  style?: React.CSSProperties;
}> = ({ frame, start, dur = BEAT, y = 26, children, style }) => {
  const o = enter(frame, start, dur, ease.crisp);
  const t = enter(frame, start, dur, ease.overshoot);
  return (
    <div style={{ opacity: o, translate: `0px ${(1 - t) * y}px`, ...style }}>{children}</div>
  );
};

/** Small uppercase accent label. */
export const Kicker: React.FC<{ children: React.ReactNode; color?: string }> = ({
  children,
  color = colors.accent,
}) => (
  <div
    style={{
      fontFamily: fontBody,
      fontSize: 22,
      fontWeight: 600,
      textTransform: 'uppercase',
      letterSpacing: 4,
      color,
    }}
  >
    {children}
  </div>
);

/** Splits a phrase into words that rise in, one per fraction of a beat. */
export const WordsRise: React.FC<{
  text: string;
  frame: number;
  start: number;
  stagger?: number;
  style?: React.CSSProperties;
}> = ({ text, frame, start, stagger = 4, style }) => (
  <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0 0.28em', justifyContent: 'center', ...style }}>
    {text.split(' ').map((word, i) => {
      const o = enter(frame, start + i * stagger, BEAT, ease.crisp);
      const t = enter(frame, start + i * stagger, BEAT, ease.overshoot);
      return (
        <span key={i} style={{ display: 'inline-block', opacity: o, translate: `0px ${(1 - t) * 30}px` }}>
          {word}
        </span>
      );
    })}
  </div>
);
