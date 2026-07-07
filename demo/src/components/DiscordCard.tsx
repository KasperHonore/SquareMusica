import React from 'react';
import { useCurrentFrame } from 'remotion';
import { colors, discord, radius } from '../theme';
import { fontBody, fontHeading } from '../fonts';
import { AlbumArt } from './AlbumArt';
import { beatPulse } from '../motion';
import { NOW_PLAYING } from '../data';

/** Compact Discord message + "Now Playing" embed, framed on the stage. */
export const DiscordCard: React.FC<{ width?: number; embedIn?: number }> = ({ width = 620, embedIn = 1 }) => {
  const frame = useCurrentFrame();
  const pulse = beatPulse(frame, undefined, 2.2);
  const t = NOW_PLAYING;

  return (
    <div
      style={{
        width,
        background: discord.bg,
        borderRadius: radius.xl,
        border: `1px solid rgba(0,0,0,0.4)`,
        boxShadow: '0 40px 100px rgba(0,0,0,0.55)',
        padding: 26,
        fontFamily: fontBody,
      }}
    >
      {/* Command message */}
      <div style={{ display: 'flex', gap: 14 }}>
        <div style={{ width: 44, height: 44, borderRadius: '50%', background: 'linear-gradient(135deg,#6a5acd,#8a63d2)', flexShrink: 0 }} />
        <div>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
            <span style={{ color: '#f2c66d', fontWeight: 600, fontSize: 17 }}>Kasper</span>
            <span style={{ color: discord.textMuted, fontSize: 13 }}>used</span>
            <span style={{ color: '#c9cdfb', fontSize: 13, background: 'rgba(88,101,242,0.18)', padding: '1px 7px', borderRadius: 5 }}>
              /play
            </span>
          </div>
          <div style={{ color: discord.text, fontSize: 17, marginTop: 4 }}>
            <span style={{ background: discord.mention, borderRadius: 4, padding: '1px 5px', color: '#c9cdfb' }}>/play</span>{' '}
            query: <span style={{ color: '#fff' }}>{t.title}</span>
          </div>
        </div>
      </div>

      {/* Bot embed */}
      <div style={{ display: 'flex', gap: 14, marginTop: 18, opacity: embedIn, translate: `0px ${(1 - embedIn) * 16}px` }}>
        <div style={{ width: 44, height: 44, borderRadius: '50%', background: `linear-gradient(135deg, ${colors.accent}, #b98f3f)`, flexShrink: 0 }} />
        <div style={{ flex: 1 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
            <span style={{ color: '#f0ede8', fontWeight: 600, fontSize: 17 }}>SquareMusica</span>
            <span style={{ fontSize: 11, fontWeight: 700, color: '#fff', background: discord.blurple, padding: '1px 6px', borderRadius: 4 }}>APP</span>
          </div>
          <div
            style={{
              background: '#2b2d31',
              borderLeft: `4px solid ${colors.accent}`,
              borderRadius: 8,
              padding: 20,
              display: 'flex',
              gap: 18,
            }}
          >
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ color: colors.accent, fontSize: 13, fontWeight: 700, textTransform: 'uppercase', letterSpacing: 0.8, marginBottom: 8 }}>
                🎵 Now Playing
              </div>
              <div style={{ color: '#fff', fontFamily: fontHeading, fontSize: 30, lineHeight: 1.05 }}>{t.title}</div>
              <div style={{ color: discord.textMuted, fontSize: 16, marginTop: 5 }}>
                {t.artist} · {t.duration}
              </div>
              <div style={{ display: 'flex', gap: 22, marginTop: 14 }}>
                <div>
                  <div style={{ color: '#fff', fontSize: 12, fontWeight: 700 }}>Requested by</div>
                  <div style={{ color: discord.textMuted, fontSize: 14 }}>Kasper</div>
                </div>
                <div>
                  <div style={{ color: '#fff', fontSize: 12, fontWeight: 700 }}>Position</div>
                  <div style={{ color: discord.textMuted, fontSize: 14 }}>#1 · playing now</div>
                </div>
              </div>
            </div>
            <AlbumArt
              seed={t.seed}
              size={112}
              radius={10}
              style={{ boxShadow: `0 0 ${18 + pulse * 26}px rgba(232,200,122,${0.2 + pulse * 0.4})` }}
            />
          </div>
        </div>
      </div>
    </div>
  );
};
