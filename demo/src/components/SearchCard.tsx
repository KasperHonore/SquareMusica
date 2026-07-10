import React from 'react';
import { useCurrentFrame } from 'remotion';
import { colors, radius } from '../theme';
import { fontBody, fontHeading } from '../fonts';
import { AlbumArt } from './AlbumArt';
import { Search as SearchIcon, Plus, Check, Cursor } from './Icons';
import { ease, enter } from '../motion';
import { SEARCH_RESULTS } from '../data';

const ROW_H = 66;

/**
 * Standalone search panel choreographed for the "type it, click it, queued"
 * moment: typewriter query, results popping on the grid, a cursor gliding to
 * the first Add button, and the queue counter bumping on click.
 */
export const SearchCard: React.FC<{
  width?: number;
  query: string;
  /** Frame the typewriter starts on. */
  typeStart: number;
  /** Frames per typed character. */
  typeSpeed?: number;
  /** Frames each result row pops in on. */
  resultsAt: [number, number, number];
  /** Frame the cursor starts gliding toward the Add button. */
  cursorFrom: number;
  /** Frame of the click — plus flips to check, counter bumps. */
  clickAt: number;
}> = ({ width = 640, query, typeStart, typeSpeed = 3, resultsAt, cursorFrom, clickAt }) => {
  const frame = useCurrentFrame();

  const typed = query.slice(0, Math.max(0, Math.floor((frame - typeStart) / typeSpeed)));
  const caretOn = Math.floor(frame / 16) % 2 === 0;

  // Cursor glide: from below the card up to the first result's Add button.
  const glide = enter(frame, cursorFrom, clickAt - 2 - cursorFrom, ease.inOut);
  const clicked = frame >= clickAt;
  const clickDip = 1 - 0.16 * (enter(frame, clickAt - 3, 3) - enter(frame, clickAt, 5));
  const added = enter(frame, clickAt, 8, ease.bigPop);
  // The counter reacts when the flying dot lands, not on the click itself.
  const landAt = clickAt + 10;
  const landed = frame >= landAt;
  const bump = enter(frame, landAt, 10, ease.bigPop);
  const rowFlash = clicked ? Math.max(0, 1 - (frame - clickAt) / 26) : 0;
  const flight = enter(frame, clickAt + 1, 9, ease.inOut);

  const pad = 24;
  const headerH = 40;
  const inputH = 52;
  // Y center of row 0's Add button, relative to the card.
  const btnY = pad + headerH + 14 + inputH + 14 + ROW_H / 2;
  const btnX = width - pad - 17 - 17; // right padding + half button

  return (
    <div style={{ position: 'relative', width }}>
      <div
        style={{
          width,
          background: colors.bgRaised,
          borderRadius: radius.xl,
          border: `1px solid ${colors.borderStrong}`,
          boxShadow: '0 40px 110px rgba(0,0,0,0.55), 0 0 60px rgba(232,200,122,0.08)',
          padding: pad,
          fontFamily: fontBody,
        }}
      >
        {/* Header: title + live queue counter */}
        <div style={{ height: headerH, display: 'flex', alignItems: 'center', gap: 12 }}>
          <div style={{ fontFamily: fontHeading, fontSize: 30, color: colors.textPrimary }}>Search</div>
          <div
            style={{
              marginLeft: 'auto',
              padding: '6px 14px',
              borderRadius: 9999,
              border: `1px solid ${bump > 0.05 ? 'rgba(232,200,122,0.5)' : colors.borderStrong}`,
              background: bump > 0.05 ? colors.accentMuted : 'rgba(255,255,255,0.03)',
              color: bump > 0.05 ? colors.accent : colors.textSecondary,
              fontSize: 14,
              fontWeight: 600,
              scale: 1 + bump * 0.22 * (1 - enter(frame, landAt + 10, 10)),
              fontVariantNumeric: 'tabular-nums',
            }}
          >
            Queue · {landed ? 6 : 5}
          </div>
        </div>

        {/* Input with typewriter */}
        <div
          style={{
            marginTop: 14,
            height: inputH,
            display: 'flex',
            alignItems: 'center',
            gap: 12,
            padding: '0 16px',
            borderRadius: radius.lg,
            background: colors.bgElevated,
            border: `1px solid ${typed.length > 0 ? 'rgba(232,200,122,0.35)' : colors.border}`,
          }}
        >
          <SearchIcon size={18} color={typed.length > 0 ? colors.accent : colors.textMuted} />
          <div style={{ fontSize: 18, color: typed.length > 0 ? colors.textPrimary : colors.textMuted, display: 'flex', alignItems: 'center' }}>
            {typed.length > 0 ? typed : 'Search for a song, artist, or paste a link…'}
            {frame >= typeStart && (
              <span style={{ width: 2, height: 22, marginLeft: 2, background: colors.accent, opacity: caretOn ? 1 : 0 }} />
            )}
          </div>
        </div>

        {/* Results */}
        <div style={{ marginTop: 14 }}>
          {SEARCH_RESULTS.map((t, i) => {
            const inn = enter(frame, resultsAt[i], 13, ease.overshoot);
            const o = enter(frame, resultsAt[i], 9, ease.crisp);
            const first = i === 0;
            // Skeleton placeholder shimmers while "searching", swaps out as the result lands.
            const skeletonO =
              enter(frame, typeStart + 4 + i * 3, 10, ease.crisp) * (1 - enter(frame, resultsAt[i], 6));
            const shimmer = 0.5 + 0.5 * Math.sin(frame * 0.28 - i * 1.4);
            return (
              <div key={t.title} style={{ position: 'relative', height: ROW_H }}>
                <div
                  style={{
                    position: 'absolute',
                    inset: 0,
                    display: 'flex',
                    alignItems: 'center',
                    gap: 14,
                    padding: '0 12px',
                    opacity: skeletonO * (0.55 + shimmer * 0.3),
                  }}
                >
                  <div style={{ width: 46, height: 46, borderRadius: 8, background: colors.bgElevated }} />
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
                    <div style={{ width: 150 - i * 22, height: 11, borderRadius: 6, background: colors.bgElevated }} />
                    <div style={{ width: 92, height: 9, borderRadius: 6, background: colors.bgElevated, opacity: 0.7 }} />
                  </div>
                </div>
              <div
                style={{
                  position: 'absolute',
                  inset: 0,
                  display: 'flex',
                  alignItems: 'center',
                  gap: 14,
                  padding: '0 12px',
                  borderRadius: radius.lg,
                  opacity: o,
                  translate: `0px ${(1 - inn) * 18}px`,
                  background: first && rowFlash > 0 ? `rgba(232,200,122,${0.05 + rowFlash * 0.08})` : 'transparent',
                }}
              >
                <AlbumArt seed={t.seed} size={46} radius={8} note={false} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 17, fontWeight: 500, color: colors.textPrimary }}>{t.title}</div>
                  <div style={{ fontSize: 14, color: colors.textMuted }}>{t.artist}</div>
                </div>
                <div style={{ fontSize: 14, color: colors.textMuted, fontVariantNumeric: 'tabular-nums' }}>{t.duration}</div>
                {/* Add button — flips to a gold check on click for row 0 */}
                <div
                  style={{
                    width: 34,
                    height: 34,
                    borderRadius: '50%',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    border: `1px solid ${first && clicked ? colors.accent : colors.borderStrong}`,
                    background: first && clicked ? colors.accent : 'transparent',
                    scale: first ? clickDip * (1 + added * 0.12 * (1 - enter(frame, clickAt + 10, 8))) : 1,
                    boxShadow: first && clicked ? `0 0 ${14 * rowFlash + 6}px rgba(232,200,122,0.5)` : 'none',
                  }}
                >
                  {first && clicked ? (
                    <Check size={18} color={colors.textInverse} />
                  ) : (
                    <Plus size={18} color={colors.textSecondary} />
                  )}
                </div>
              </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* Gliding cursor */}
      <div
        style={{
          position: 'absolute',
          left: 0,
          top: 0,
          translate: `${btnX + 4 + (1 - glide) * 120}px ${btnY + 4 + (1 - glide) * 210}px`,
          scale: clickDip,
          opacity: enter(frame, cursorFrom, 8) * (1 - enter(frame, clickAt + 16, 12)),
          zIndex: 20,
          filter: 'drop-shadow(0 4px 10px rgba(0,0,0,0.6))',
        }}
      >
        <Cursor size={30} />
      </div>

      {/* Gold dot — the track arcs from the Add button into the queue counter */}
      {flight > 0.001 && flight < 0.999 && (
        <div
          style={{
            position: 'absolute',
            left: -6,
            top: -6,
            translate: `${btnX + (width - pad - 48 - btnX) * flight}px ${
              btnY + (pad + headerH / 2 - btnY) * flight - Math.sin(flight * Math.PI) * 46
            }px`,
            width: 12,
            height: 12,
            borderRadius: '50%',
            background: colors.accent,
            boxShadow: '0 0 16px rgba(232,200,122,0.9)',
            zIndex: 30,
          }}
        />
      )}
    </div>
  );
};
