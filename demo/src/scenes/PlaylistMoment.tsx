import React from 'react';
import { AbsoluteFill, interpolate, useCurrentFrame } from 'remotion';
import { colors, radius } from '../theme';
import { fontHeading, fontBody } from '../fonts';
import { SceneFrame } from '../components/SceneFrame';
import { AlbumArt } from '../components/AlbumArt';
import { Kicker, RiseIn } from '../components/Kinetic';
import { CardShine } from '../components/Finishing';
import { ease, enter } from '../motion';
import { IMPORT_PLAYLIST, IMPORT_TRACKS } from '../data';

export const PLAYLIST_MOMENT = 120;

/**
 * The one deliberately asymmetric scene: message rail on the left, the
 * cascade card oversized and bleeding off the right edge of frame.
 */
export const PlaylistMoment: React.FC = () => {
  const frame = useCurrentFrame();

  const paste = enter(frame, 22, 12, ease.bigPop);
  const pasteO = enter(frame, 22, 7, ease.crisp);
  const flash = interpolate(frame, [22, 26, 36], [0, 0.35, 0], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });

  const cardIn = enter(frame, 30, 16, ease.overshoot);
  const counter = enter(frame, 72, 12, ease.bigPop);
  const count = Math.round(interpolate(frame, [72, 88], [0, IMPORT_PLAYLIST.total], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
    easing: ease.crisp,
  }));
  const caption = enter(frame, 54, 14);

  return (
    <SceneFrame>
      {/* Left rail: the message */}
      <div
        style={{
          position: 'absolute',
          left: 90,
          top: 0,
          bottom: 40,
          width: 520,
          display: 'flex',
          flexDirection: 'column',
          justifyContent: 'center',
          gap: 24,
        }}
      >
        <div>
          <RiseIn frame={frame} start={0}>
            <Kicker>Playlists</Kicker>
          </RiseIn>
          <RiseIn frame={frame} start={7} style={{ marginTop: 12 }}>
            <div style={{ fontFamily: fontHeading, fontSize: 78, color: colors.textPrimary, lineHeight: 1.04, letterSpacing: '-1px' }}>
              Paste a<br />
              <span style={{ color: colors.accent }}>whole playlist</span>
            </div>
          </RiseIn>
        </div>

        {/* Pasted link pill */}
        <div
          style={{
            opacity: pasteO,
            scale: 1.35 - 0.35 * paste,
            transformOrigin: 'left center',
            display: 'flex',
            alignItems: 'center',
            gap: 12,
            padding: '13px 22px',
            borderRadius: 9999,
            background: colors.bgElevated,
            border: `1px solid ${colors.borderStrong}`,
            fontFamily: fontBody,
            fontSize: 17,
            color: colors.textSecondary,
            alignSelf: 'flex-start',
            boxShadow: `0 12px 40px rgba(0,0,0,0.45), 0 0 ${flash * 60}px rgba(232,200,122,${flash})`,
            whiteSpace: 'nowrap',
          }}
        >
          <span style={{ width: 10, height: 10, borderRadius: '50%', background: '#1db954', flexShrink: 0 }} />
          {IMPORT_PLAYLIST.url}
        </div>

        <div
          style={{
            opacity: caption,
            translate: `0px ${(1 - caption) * 12}px`,
            fontFamily: fontBody,
            fontSize: 20,
            color: colors.textSecondary,
            lineHeight: 1.45,
          }}
        >
          Spotify or YouTube — every track resolved automatically.
        </div>
      </div>

      {/* Right: cascade card, oversized, bleeding off-frame */}
      <div
        style={{
          position: 'absolute',
          right: -130,
          top: '50%',
          width: 640,
          translate: `${(1 - cardIn) * 90}px -50%`,
          opacity: cardIn,
        }}
      >
        <div
          style={{
            position: 'relative',
            background: colors.bgRaised,
            borderRadius: radius.xl,
            border: `1px solid ${colors.borderStrong}`,
            boxShadow: '0 40px 110px rgba(0,0,0,0.55), 0 0 60px rgba(232,200,122,0.08)',
            padding: '22px 26px',
            fontFamily: fontBody,
            display: 'flex',
            flexDirection: 'column',
          }}
        >
          {IMPORT_TRACKS.map((t, i) => {
            const at = 42 + i * 6;
            const inn = enter(frame, at, 13, ease.overshoot);
            const o = enter(frame, at, 8, ease.crisp);
            return (
              <div
                key={t.title}
                style={{
                  height: 62,
                  display: 'flex',
                  alignItems: 'center',
                  gap: 14,
                  opacity: o,
                  translate: `0px ${(1 - inn) * -20}px`,
                }}
              >
                <AlbumArt seed={t.seed} size={44} radius={7} note={false} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 17, fontWeight: 500, color: colors.textPrimary }}>{t.title}</div>
                  <div style={{ fontSize: 14, color: colors.textMuted }}>{t.artist}</div>
                </div>
                <div style={{ fontSize: 14, color: colors.textMuted, fontVariantNumeric: 'tabular-nums' }}>{t.duration}</div>
              </div>
            );
          })}
          {/* Footer: counter stays on the visible left edge — the card bleeds off-frame right */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 16, marginTop: 10, height: 42 }}>
            <div
              style={{
                opacity: enter(frame, 72, 7),
                scale: 1.3 - 0.3 * counter,
                padding: '8px 18px',
                borderRadius: 9999,
                background: colors.accentMuted,
                border: '1px solid rgba(232, 200, 122, 0.5)',
                color: colors.accent,
                fontSize: 16,
                fontWeight: 600,
                fontVariantNumeric: 'tabular-nums',
              }}
            >
              {count} tracks queued
            </div>
            <div style={{ fontSize: 15, color: colors.textMuted, opacity: enter(frame, 62, 10) }}>
              + {IMPORT_PLAYLIST.total - IMPORT_TRACKS.length} more
            </div>
          </div>
          <CardShine at={38} />
        </div>
      </div>
    </SceneFrame>
  );
};
