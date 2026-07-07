/**
 * Icon set ported from web/src/components/icons/index.jsx so the recreated UI
 * uses the exact same glyphs as the real SquareMusica app.
 */
import React from 'react';

type IconProps = { size?: number; color?: string; style?: React.CSSProperties };

const svg = (size: number, color: string, children: React.ReactNode, style?: React.CSSProperties) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill={color}
    style={{ display: 'block', ...style }}
  >
    {children}
  </svg>
);

const strokeSvg = (size: number, color: string, children: React.ReactNode) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={2} style={{ display: 'block' }}>
    {children}
  </svg>
);

export const Play = ({ size = 24, color = 'currentColor', style }: IconProps) =>
  svg(size, color, <path d="M8 5v14l11-7z" />, style);

export const Pause = ({ size = 24, color = 'currentColor', style }: IconProps) =>
  svg(size, color, <path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z" />, style);

export const SkipNext = ({ size = 24, color = 'currentColor', style }: IconProps) =>
  svg(size, color, <path d="M6 18l8.5-6L6 6v12zM16 6v12h2V6h-2z" />, style);

export const SkipPrevious = ({ size = 24, color = 'currentColor', style }: IconProps) =>
  svg(size, color, <path d="M6 6h2v12H6zm3.5 6l8.5 6V6z" />, style);

export const Shuffle = ({ size = 24, color = 'currentColor', style }: IconProps) =>
  svg(
    size,
    color,
    <path d="M10.59 9.17L5.41 4 4 5.41l5.17 5.17 1.42-1.41zM14.5 4l2.04 2.04L4 18.59 5.41 20 17.96 7.46 20 9.5V4h-5.5zm.33 9.41l-1.41 1.41 3.13 3.13L14.5 20H20v-5.5l-2.04 2.04-3.13-3.13z" />,
    style,
  );

export const Loop = ({ size = 24, color = 'currentColor', style }: IconProps) =>
  svg(size, color, <path d="M7 7h10v3l4-4-4-4v3H5v6h2V7zm10 10H7v-3l-4 4 4 4v-3h12v-6h-2v4z" />, style);

export const MusicNote = ({ size = 24, color = 'currentColor', style }: IconProps) =>
  svg(
    size,
    color,
    <path d="M12 3v10.55c-.59-.34-1.27-.55-2-.55-2.21 0-4 1.79-4 4s1.79 4 4 4 4-1.79 4-4V7h4V3h-6z" />,
    style,
  );

export const Plus = ({ size = 24, color = 'currentColor', style }: IconProps) =>
  svg(size, color, <path d="M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z" />, style);

export const DragHandle = ({ size = 24, color = 'currentColor', style }: IconProps) =>
  svg(size, color, <path d="M20 9H4v2h16V9zM4 15h16v-2H4v2z" />, style);

export const Check = ({ size = 24, color = 'currentColor', style }: IconProps) =>
  svg(size, color, <path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z" />, style);

export const Search = ({ size = 24, color = 'currentColor' }: IconProps) =>
  strokeSvg(size, color, (
    <>
      <circle cx="11" cy="11" r="8" />
      <path d="m21 21-4.35-4.35" />
    </>
  ));

export const Grid = ({ size = 24, color = 'currentColor' }: IconProps) =>
  strokeSvg(size, color, (
    <>
      <rect x="3" y="3" width="7" height="7" />
      <rect x="14" y="3" width="7" height="7" />
      <rect x="14" y="14" width="7" height="7" />
      <rect x="3" y="14" width="7" height="7" />
    </>
  ));

export const Clock = ({ size = 24, color = 'currentColor' }: IconProps) =>
  strokeSvg(size, color, (
    <>
      <circle cx="12" cy="12" r="10" />
      <polyline points="12 6 12 12 16 14" />
    </>
  ));

export const Discord = ({ size = 24, color = 'currentColor', style }: IconProps) =>
  svg(
    size,
    color,
    <path d="M20.317 4.37a19.791 19.791 0 0 0-4.885-1.515.074.074 0 0 0-.079.037c-.21.375-.444.864-.608 1.25a18.27 18.27 0 0 0-5.487 0 12.64 12.64 0 0 0-.617-1.25.077.077 0 0 0-.079-.037A19.736 19.736 0 0 0 3.677 4.37a.07.07 0 0 0-.032.027C.533 9.046-.32 13.58.099 18.057a.082.082 0 0 0 .031.057 19.9 19.9 0 0 0 5.993 3.03.078.078 0 0 0 .084-.028 14.09 14.09 0 0 0 1.226-1.994.076.076 0 0 0-.041-.106 13.107 13.107 0 0 1-1.872-.892.077.077 0 0 1-.008-.128 10.2 10.2 0 0 0 .372-.292.074.074 0 0 1 .077-.01c3.928 1.793 8.18 1.793 12.062 0a.074.074 0 0 1 .078.01c.12.098.246.198.373.292a.077.077 0 0 1-.006.127 12.299 12.299 0 0 1-1.873.892.077.077 0 0 0-.041.107c.36.698.772 1.362 1.225 1.993a.076.076 0 0 0 .084.028 19.839 19.839 0 0 0 6.002-3.03.077.077 0 0 0 .032-.054c.5-5.177-.838-9.674-3.549-13.66a.061.061 0 0 0-.031-.03zM8.02 15.33c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.956-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.956 2.418-2.157 2.418zm7.975 0c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.955-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.946 2.418-2.157 2.418z" />,
    style,
  );

export const Cursor = ({ size = 24, color = '#ffffff', style }: IconProps) => (
  <svg width={size} height={size} viewBox="0 0 24 24" style={{ display: 'block', ...style }}>
    <path
      d="M5.5 3.5 L5.5 18.5 L9.5 14.7 L12 20.5 L14.4 19.4 L11.9 13.7 L17.2 13.6 Z"
      fill={color}
      stroke="rgba(0,0,0,0.45)"
      strokeWidth={1}
      strokeLinejoin="round"
    />
  </svg>
);
