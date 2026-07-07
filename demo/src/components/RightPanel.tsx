import React from 'react';
import { useCurrentFrame, useVideoConfig } from 'remotion';
import { colors, radius } from '../theme';
import { fontHeading, fontBody } from '../fonts';
import { AlbumArt } from './AlbumArt';
import { Eq } from './Eq';
import { QUEUE, type Track } from '../data';

export const RightPanel: React.FC<{ track: Track; playing?: boolean; upNext?: Track[] }> = ({
  track,
  playing = true,
  upNext = QUEUE.slice(1, 3),
}) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const glow = 20 + (playing ? 12 * (0.5 + 0.5 * Math.sin((frame / fps) * 2.2)) : 0);

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        height: '100%',
        padding: 20,
        gap: 18,
        backgroundColor: colors.bgRaised,
        borderLeft: `1px solid ${colors.border}`,
        fontFamily: fontBody,
      }}
    >
      <div
        style={{
          fontSize: 10,
          fontWeight: 600,
          textTransform: 'uppercase',
          letterSpacing: 1.2,
          color: colors.textMuted,
        }}
      >
        Now Playing
      </div>

      {/* Album art with pulsing gold glow */}
      <div style={{ display: 'flex', justifyContent: 'center' }}>
        <AlbumArt
          seed={track.seed}
          size={236}
          radius={radius.xl}
          style={{ boxShadow: `0 0 ${glow}px rgba(232,200,122,0.25), inset 0 1px 0 rgba(255,255,255,0.12)` }}
        />
      </div>

      {/* Title + artist */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <div style={{ fontFamily: fontHeading, fontSize: 24, color: colors.textPrimary, lineHeight: 1.1 }}>
            {track.title}
          </div>
          {playing && <Eq height={14} />}
        </div>
        <div style={{ fontSize: 13, color: colors.textSecondary }}>{track.artist}</div>
      </div>

      {/* Up next */}
      <div style={{ marginTop: 4, display: 'flex', flexDirection: 'column', gap: 10 }}>
        <div
          style={{
            fontSize: 10,
            fontWeight: 600,
            textTransform: 'uppercase',
            letterSpacing: 1.2,
            color: colors.textMuted,
          }}
        >
          Up Next
        </div>
        {upNext.map((t) => (
          <div key={t.title} style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <AlbumArt seed={t.seed} size={36} radius={6} note={false} />
            <div style={{ minWidth: 0, flex: 1 }}>
              <div
                style={{
                  fontSize: 13,
                  color: colors.textPrimary,
                  whiteSpace: 'nowrap',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                }}
              >
                {t.title}
              </div>
              <div style={{ fontSize: 11, color: colors.textMuted }}>{t.artist}</div>
            </div>
            <div style={{ fontSize: 11, color: colors.textMuted, fontVariantNumeric: 'tabular-nums' }}>
              {t.duration}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
};
