import React from 'react';
import { AbsoluteFill, useCurrentFrame } from 'remotion';
import { colors } from '../theme';
import { fontHeading, fontBody } from '../fonts';
import { SceneFrame } from '../components/SceneFrame';
import { Kicker, RiseIn } from '../components/Kinetic';
import { Fringe, WarmFlash } from '../components/Finishing';
import { beatPulse, ease, enter } from '../motion';

export const COMMANDS_MOMENT = 150;

const ZOOM_AT = 138; // /webui flies into the camera over the last 12 frames

const CMDS = [
  '/join', '/play', '/pause', '/resume', '/skip', '/stop', '/queue',
  '/nowplaying', '/remove', '/shuffle', '/clear', '/loop', '/leave',
];

/** Discord-mention style pill that stamps in on its frame. */
const Pill: React.FC<{ cmd: string; at: number; index: number }> = ({ cmd, at, index }) => {
  const frame = useCurrentFrame();
  const s = enter(frame, at, 11, ease.bigPop);
  const o = enter(frame, at, 7, ease.crisp);
  const rot = ((index * 53) % 9 - 4) * (1 - s);
  return (
    <div
      style={{
        opacity: o,
        scale: 1.5 - 0.5 * s,
        rotate: `${rot}deg`,
        padding: '10px 18px',
        borderRadius: 9,
        background: 'rgba(88, 101, 242, 0.16)',
        border: '1px solid rgba(88, 101, 242, 0.35)',
        color: '#c9cdfb',
        fontFamily: fontBody,
        fontSize: 22,
        fontWeight: 500,
        whiteSpace: 'nowrap',
      }}
    >
      {cmd}
    </div>
  );
};

/** Rapid-fire slash command wall, capped by /webui zooming into the camera. */
export const CommandsMoment: React.FC = () => {
  const frame = useCurrentFrame();

  const webuiIn = enter(frame, 90, 12, ease.bigPop);
  const webuiO = enter(frame, 90, 7, ease.crisp);
  const captionIn = enter(frame, 96, 8, ease.crisp);
  const pulse = beatPulse(frame, undefined, 2.2) * webuiO;

  // Match cut: the pill accelerates into the lens; the rest of the scene falls away.
  const zoom = enter(frame, ZOOM_AT, COMMANDS_MOMENT - ZOOM_AT, ease.rampIn);
  const ghostDrift = frame * 0.1;

  return (
    <SceneFrame>
      {/* Oversized ghost numeral, drifting slowly behind everything */}
      <AbsoluteFill style={{ alignItems: 'center', justifyContent: 'center', opacity: 1 - zoom }}>
        <div
          style={{
            fontFamily: fontHeading,
            fontSize: 560,
            lineHeight: 1,
            color: 'rgba(240, 237, 232, 0.05)',
            letterSpacing: '-12px',
            translate: `0px ${18 - ghostDrift}px`,
            scale: `${1 + enter(frame, 0, 60, ease.crisp) * 0.03}`,
          }}
        >
          14
        </div>
      </AbsoluteFill>

      <AbsoluteFill style={{ flexDirection: 'column', alignItems: 'center', paddingTop: 58, gap: 34 }}>
        {/* Headline */}
        <div style={{ textAlign: 'center', opacity: 1 - zoom * 0.8 }}>
          <RiseIn frame={frame} start={0}>
            <Kicker>14 commands</Kicker>
          </RiseIn>
          <RiseIn frame={frame} start={7} style={{ marginTop: 10 }}>
            <div style={{ fontFamily: fontHeading, fontSize: 68, color: colors.textPrimary, lineHeight: 1.05, letterSpacing: '-1px' }}>
              Every control, one <span style={{ color: colors.accent }}>slash</span> away
            </div>
          </RiseIn>
        </div>

        {/* Command wall — one stamp per eighth note */}
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 14, justifyContent: 'center', maxWidth: 900, opacity: 1 - zoom * 0.9 }}>
          {CMDS.map((cmd, i) => (
            <Pill key={cmd} cmd={cmd} at={22 + i * 5} index={i} />
          ))}
        </div>

        {/* /webui hero pill — lands on the downbeat, then flies into the camera */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
          {/* Zoom is scoped to the pill and aims at frame center, so it flies at the lens */}
          <div
            style={{
              scale: `${1 + zoom * 7}`,
              translate: `${zoom * 150}px ${zoom * -165}px`,
              filter: zoom > 0.02 ? `blur(${zoom * 5}px)` : 'none',
            }}
          >
            <Fringe at={ZOOM_AT} amp={5} dur={COMMANDS_MOMENT - ZOOM_AT}>
              <div
                style={{
                  opacity: webuiO,
                  scale: 1.6 - 0.6 * webuiIn,
                  padding: '14px 30px',
                  borderRadius: 12,
                  background: colors.accentMuted,
                  border: '1px solid rgba(232, 200, 122, 0.5)',
                  color: colors.accent,
                  fontFamily: fontBody,
                  fontSize: 28,
                  fontWeight: 600,
                  boxShadow: `0 0 ${20 + pulse * 30}px rgba(232, 200, 122, ${0.2 + pulse * 0.35})`,
                }}
              >
                /webui
              </div>
            </Fringe>
          </div>
          <div
            style={{
              opacity: Math.max(0, captionIn * (1 - zoom * 3)),
              translate: `${(1 - captionIn) * -14}px 0px`,
              fontFamily: fontBody,
              fontSize: 21,
              color: colors.textSecondary,
            }}
          >
            → opens the control panel
          </div>
        </div>
      </AbsoluteFill>

      <WarmFlash at={COMMANDS_MOMENT - 4} peak={0.5} rise={4} fall={8} />
    </SceneFrame>
  );
};
