import React from 'react';
import { AbsoluteFill, interpolate, useCurrentFrame } from 'remotion';
import { colors, discord, radius } from '../theme';
import { fontHeading, fontBody } from '../fonts';
import { SceneFrame } from '../components/SceneFrame';
import { Kicker, RiseIn } from '../components/Kinetic';
import { Discord as DiscordIcon, Check } from '../components/Icons';
import { CardShine } from '../components/Finishing';
import { ease, enter } from '../motion';

export const AUTH_MOMENT = 105;

const CLICK_AT = 45;

/** Discord OAuth gate: one button, and only your server's members get in. */
export const AuthMoment: React.FC = () => {
  const frame = useCurrentFrame();

  const cardIn = enter(frame, 14, 14, ease.overshoot);
  const dip = 1 - 0.05 * (enter(frame, CLICK_AT - 3, 3) - enter(frame, CLICK_AT + 2, 6));
  const success = enter(frame, CLICK_AT + 7, 12, ease.overshoot);
  const flash = interpolate(frame, [CLICK_AT, CLICK_AT + 4, CLICK_AT + 14], [0, 0.3, 0], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });
  const caption = enter(frame, CLICK_AT + 10, 12);

  return (
    <SceneFrame>
      <AbsoluteFill style={{ flexDirection: 'column', alignItems: 'center', paddingTop: 74, gap: 34 }}>
        <div style={{ textAlign: 'center' }}>
          <RiseIn frame={frame} start={0}>
            <Kicker>Private by design</Kicker>
          </RiseIn>
          <RiseIn frame={frame} start={7} style={{ marginTop: 10 }}>
            <div style={{ fontFamily: fontHeading, fontSize: 76, color: colors.textPrimary, lineHeight: 1.05, letterSpacing: '-1px' }}>
              Locked to <span style={{ color: colors.accent }}>your server</span>
            </div>
          </RiseIn>
        </div>

        {/* Login card: OAuth button → verified member */}
        <div
          style={{
            width: 440,
            opacity: cardIn,
            scale: (0.94 + cardIn * 0.06) * dip,
            background: colors.bgRaised,
            borderRadius: radius.xl,
            border: `1px solid ${colors.borderStrong}`,
            boxShadow: `0 40px 110px rgba(0,0,0,0.55), 0 0 ${30 + flash * 80}px rgba(232,200,122,${0.08 + flash})`,
            padding: 26,
            fontFamily: fontBody,
            position: 'relative',
            overflow: 'hidden',
          }}
        >
          {/* OAuth button */}
          <div
            style={{
              opacity: 1 - success,
              scale: 1 - success * 0.06,
              height: 56,
              borderRadius: radius.lg,
              background: discord.blurple,
              color: '#fff',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              gap: 12,
              fontSize: 18,
              fontWeight: 600,
            }}
          >
            <DiscordIcon size={24} color="#fff" />
            Continue with Discord
          </div>

          {/* Verified member row — takes the button's place */}
          <div
            style={{
              position: 'absolute',
              inset: 26,
              height: 56,
              opacity: success,
              translate: `0px ${(1 - success) * 18}px`,
              display: 'flex',
              alignItems: 'center',
              gap: 14,
              padding: '0 16px',
              borderRadius: radius.lg,
              background: 'rgba(126, 200, 122, 0.08)',
              border: '1px solid rgba(126, 200, 122, 0.35)',
            }}
          >
            <div
              style={{
                width: 36,
                height: 36,
                borderRadius: '50%',
                background: 'linear-gradient(135deg, #6a5acd, #8a63d2)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                color: '#fff',
                fontSize: 16,
                fontWeight: 600,
              }}
            >
              K
            </div>
            <div style={{ flex: 1, fontSize: 17, fontWeight: 600, color: colors.textPrimary }}>Kasper</div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 7, color: colors.success, fontSize: 15, fontWeight: 600 }}>
              <Check size={18} color={colors.success} />
              Server member
            </div>
          </div>
          <CardShine at={26} />
        </div>

        <div
          style={{
            opacity: caption,
            translate: `0px ${(1 - caption) * 12}px`,
            fontFamily: fontBody,
            fontSize: 21,
            color: colors.textSecondary,
          }}
        >
          Discord OAuth — only members of your server get in.
        </div>
      </AbsoluteFill>
    </SceneFrame>
  );
};
