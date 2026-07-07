import React from 'react';
import { colors, radius } from '../theme';
import { fontBody, fontHeading } from '../fonts';
import { AlbumArt } from './AlbumArt';
import { Eq } from './Eq';
import { DragHandle, Shuffle, Loop } from './Icons';
import { QUEUE } from '../data';

const ROW_H = 68;
const TARGET_SLOT: Record<number, number> = { 0: 0, 1: 2, 2: 3, 3: 1, 4: 4 };
const DRAG_INDEX = 3;

/** Standalone, legible queue panel with a drag-to-reorder driven by `p` (0..1). */
export const QueueCard: React.FC<{ width?: number; p: number; lift: number }> = ({ width = 640, p, lift }) => (
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
      <div style={{ fontSize: 15, color: colors.textMuted }}>{QUEUE.length} tracks</div>
      <div style={{ marginLeft: 'auto', display: 'flex', gap: 14, color: colors.textSecondary }}>
        <Shuffle size={19} color={colors.textSecondary} />
        <Loop size={19} color={colors.accent} />
      </div>
    </div>

    <div style={{ position: 'relative', height: QUEUE.length * ROW_H }}>
      {/* drop target */}
      <div
        style={{
          position: 'absolute',
          top: 1 * ROW_H,
          left: 0,
          right: 0,
          height: ROW_H,
          borderRadius: radius.lg,
          border: p > 0.05 && p < 0.98 ? `1.5px dashed ${colors.accent}` : '1.5px solid transparent',
          background: p > 0.05 && p < 0.98 ? colors.accentSubtle : 'transparent',
        }}
      />
      {QUEUE.map((track, i) => {
        const slot = i + (TARGET_SLOT[i] - i) * p;
        const dragged = i === DRAG_INDEX;
        const now = i === 0;
        return (
          <div
            key={track.title}
            style={{
              position: 'absolute',
              left: 0,
              right: 0,
              height: ROW_H,
              translate: `${dragged ? lift * 8 : 0}px ${slot * ROW_H}px`,
              scale: dragged ? 1 + lift * 0.03 : 1,
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
                background: dragged ? colors.bgSurface3 : now ? colors.accentSubtle : 'transparent',
                border: `1px solid ${dragged ? colors.borderStrong : 'transparent'}`,
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
        );
      })}
    </div>
  </div>
);
