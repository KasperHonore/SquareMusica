import React from 'react';
import { colors, radius } from '../theme';
import { fontBody, fontHeading } from '../fonts';
import { AlbumArt } from './AlbumArt';
import { Eq } from './Eq';
import { DragHandle, Shuffle, Loop } from './Icons';
import type { Track } from '../data';

const ROW_H = 68;

export type QueueRowState = {
  track: Track;
  /** Vertical slot (fractional while a row is in motion). */
  slot: number;
  /** 0..1 drag emphasis — x nudge, scale, shadow. */
  lift?: number;
  /** 0..1 removal progress — slides right and fades. */
  gone?: number;
  now?: boolean;
  dragged?: boolean;
};

/**
 * Legible standalone queue panel. The scene owns the choreography and hands
 * each row a resolved slot/lift/gone state, so the same card can play out
 * drag-to-reorder, shuffle scrambles, and removals.
 */
export const QueueCard: React.FC<{
  width?: number;
  rows: QueueRowState[];
  countLabel: string;
  /** Dashed drop-target slot while dragging (null = hidden). */
  dropSlot?: number | null;
  /** 0..1 — lights up the header shuffle icon. */
  shuffleHot?: number;
  /** Visible rows (fractional) — animates the card height on removal. */
  heightRows?: number;
}> = ({ width = 640, rows, countLabel, dropSlot = null, shuffleHot = 0, heightRows }) => (
  <div
    style={{
      width,
      background: colors.bgRaised,
      borderRadius: radius.xl,
      border: `1px solid ${colors.borderStrong}`,
      boxShadow: '0 40px 110px rgba(0,0,0,0.55), 0 0 60px rgba(232,200,122,0.08)',
      padding: 28,
      fontFamily: fontBody,
    }}
  >
    <div style={{ display: 'flex', alignItems: 'baseline', gap: 12, marginBottom: 18 }}>
      <div style={{ fontFamily: fontHeading, fontSize: 32, color: colors.textPrimary }}>Queue</div>
      <div style={{ fontSize: 15, color: colors.textMuted }}>{countLabel}</div>
      <div style={{ marginLeft: 'auto', display: 'flex', gap: 14, alignItems: 'center' }}>
        <div
          style={{
            display: 'flex',
            scale: 1 + shuffleHot * 0.25,
            filter: shuffleHot > 0.01 ? `drop-shadow(0 0 ${6 + shuffleHot * 10}px rgba(232,200,122,${shuffleHot * 0.8}))` : 'none',
          }}
        >
          <Shuffle size={19} color={shuffleHot > 0.4 ? colors.accent : colors.textSecondary} />
        </div>
        <Loop size={19} color={colors.accent} />
      </div>
    </div>

    <div style={{ position: 'relative', height: (heightRows ?? rows.length) * ROW_H, overflow: 'visible' }}>
      {/* drop target */}
      {dropSlot !== null && (
        <div
          style={{
            position: 'absolute',
            top: dropSlot * ROW_H,
            left: 0,
            right: 0,
            height: ROW_H,
            borderRadius: radius.lg,
            border: `1.5px dashed ${colors.accent}`,
            background: colors.accentSubtle,
          }}
        />
      )}
      {rows.map(({ track, slot, lift = 0, gone = 0, now = false, dragged = false }) => (
        <div
          key={track.title}
          style={{
            position: 'absolute',
            left: 0,
            right: 0,
            height: ROW_H,
            translate: `${lift * 8 + gone * 110}px ${slot * ROW_H}px`,
            scale: dragged ? 1 + lift * 0.03 : 1,
            opacity: 1 - gone,
            zIndex: dragged ? 10 : 1,
          }}
        >
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 16,
              height: ROW_H - 10,
              margin: '5px 0',
              padding: '0 16px',
              borderRadius: radius.lg,
              background: dragged ? colors.bgSurface3 : now ? colors.accentSubtle : gone > 0.02 ? 'rgba(232,122,122,0.07)' : 'transparent',
              border: `1px solid ${dragged ? colors.borderStrong : gone > 0.02 ? 'rgba(232,122,122,0.35)' : 'transparent'}`,
              boxShadow: dragged ? `0 ${10 + lift * 16}px ${22 + lift * 18}px rgba(0,0,0,${0.32 + lift * 0.25})` : 'none',
            }}
          >
            <div style={{ width: 22, display: 'flex', justifyContent: 'center' }}>
              {now ? <Eq height={16} /> : <DragHandle size={20} color={dragged ? colors.accent : colors.textMuted} />}
            </div>
            <AlbumArt seed={track.seed} size={46} radius={8} note={false} />
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 17, fontWeight: 500, color: now ? colors.accent : colors.textPrimary }}>{track.title}</div>
              <div style={{ fontSize: 14, color: colors.textMuted }}>{track.artist}</div>
            </div>
            <div style={{ fontSize: 14, color: colors.textMuted, fontVariantNumeric: 'tabular-nums' }}>{track.duration}</div>
          </div>
        </div>
      ))}
    </div>
  </div>
);
