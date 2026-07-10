import React from 'react';
import { AbsoluteFill, Sequence, interpolate, useCurrentFrame } from 'remotion';
import { LightLeak } from '@remotion/light-leaks';
import { colors } from '../theme';
import { fontHeading, fontBody } from '../fonts';
import { SceneFrame } from '../components/SceneFrame';
import { AppMock } from '../components/AppWindow';
import { BrowseCenter } from '../components/DashCenters';
import { SearchCard } from '../components/SearchCard';
import { QueueCard, type QueueRowState } from '../components/QueueCard';
import { TransportCard } from '../components/TransportCard';
import { Kicker, RiseIn } from '../components/Kinetic';
import { CardShine, ExitRamp, Fringe, WarmFlash } from '../components/Finishing';
import { ease, enter } from '../motion';
import { NOW_PLAYING, QUEUE } from '../data';

/**
 * The whole web act as ONE continuous camera move:
 * browser reveal → a gold dot swallows the lens (push-in) → a station world
 * where the camera whip-pans between Search, Queue and Transport, each action
 * still snapping on the 120 BPM grid.
 */
export const WEB_ACT = 585;

// Timeline landmarks (scene frames)
const PUSH_START = 90;
const PUSH_END = 114;
const PAN1 = [240, 254] as const;
const PAN2 = [420, 434] as const;
const QUEUE_BASE = 255;
const TRANSPORT_BASE = 435;
const STATION_GAP = 1500;

/* ------------------------------- Reveal ---------------------------------- */

const Reveal: React.FC = () => {
  const frame = useCurrentFrame();

  const inn = enter(frame, 16, 18, ease.overshoot);
  const opacity = enter(frame, 16, 12, ease.crisp);
  const push = interpolate(frame, [30, PUSH_START], [1, 1.03], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });
  const tilt = interpolate(inn, [0, 1], [7, 0]);
  const ty = interpolate(inn, [0, 1], [70, 0]);
  const s = (0.92 + inn * 0.08) * push;
  // The URL pill flares gold — catching the /webui pill from the previous scene.
  const urlGlow = interpolate(frame, [2, 9, 26], [0, 1, 0], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });

  // Camera pushes into the window center as the dot swells.
  const zoom = 1 + enter(frame, PUSH_START, PUSH_END - PUSH_START, ease.rampIn) * 1.8;

  return (
    <AbsoluteFill style={{ scale: `${zoom}`, transformOrigin: '50% 56%' }}>
      <AbsoluteFill style={{ flexDirection: 'column', alignItems: 'center', paddingTop: 46 }}>
        <div style={{ textAlign: 'center' }}>
          <RiseIn frame={frame} start={0}>
            <Kicker>The web panel</Kicker>
          </RiseIn>
          <RiseIn frame={frame} start={7} style={{ marginTop: 10 }}>
            <div style={{ fontFamily: fontHeading, fontSize: 72, color: colors.textPrimary, lineHeight: 1.05, letterSpacing: '-1px' }}>
              Control it from <span style={{ color: colors.accent }}>anywhere</span>
            </div>
          </RiseIn>
        </div>

        <div
          style={{
            marginTop: 30,
            opacity,
            transform: `perspective(1400px) rotateX(${tilt}deg) scale(${s}) translateY(${ty}px)`,
            transformOrigin: 'center top',
          }}
        >
          <AppMock width={820} view="search" center={<BrowseCenter />} player={{ track: NOW_PLAYING, playing: true, progress: 32 }} urlGlow={urlGlow} />
        </div>
      </AbsoluteFill>
    </AbsoluteFill>
  );
};

/** Gold dot that appears over the window, then swells until it swallows the frame. */
const DotSwallow: React.FC = () => {
  const frame = useCurrentFrame();
  const dotIn = enter(frame, PUSH_START - 6, 8, ease.bigPop);
  const swell = enter(frame, PUSH_START + 2, PUSH_END - PUSH_START, ease.rampIn);
  const fade = enter(frame, PUSH_END - 2, 14, ease.crisp);
  if (frame < PUSH_START - 6 || fade >= 1) return null;
  return (
    <AbsoluteFill style={{ alignItems: 'center', justifyContent: 'center', pointerEvents: 'none' }}>
      <div
        style={{
          width: 60,
          height: 60,
          borderRadius: '50%',
          background: 'radial-gradient(circle, #fff3d8 0%, #e8c87a 34%, rgba(232,200,122,0.5) 52%, rgba(232,200,122,0) 70%)',
          mixBlendMode: 'screen',
          scale: `${dotIn * (0.25 + swell * 40)}`,
          opacity: (0.95 + swell * 0.05) * (1 - fade),
        }}
      />
    </AbsoluteFill>
  );
};

/* ------------------------------- Stations -------------------------------- */

const SearchStation: React.FC = () => {
  const frame = useCurrentFrame();
  return (
    <AbsoluteFill style={{ flexDirection: 'column', alignItems: 'center', paddingTop: 50, gap: 26 }}>
      <div style={{ textAlign: 'center' }}>
        <RiseIn frame={frame} start={114}>
          <Kicker>Search &amp; add</Kicker>
        </RiseIn>
        <RiseIn frame={frame} start={121} style={{ marginTop: 10 }}>
          <div style={{ fontFamily: fontHeading, fontSize: 72, color: colors.textPrimary, lineHeight: 1.05, letterSpacing: '-1px' }}>
            Type it. Click it. <span style={{ color: colors.accent }}>Queued.</span>
          </div>
        </RiseIn>
      </div>

      <div style={{ position: 'relative' }}>
        <SearchCard
          width={640}
          query="sunset"
          typeStart={132}
          resultsAt={[158, 165, 172]}
          cursorFrom={174}
          clickAt={195}
        />
        <CardShine at={118} />
      </div>
    </AbsoluteFill>
  );
};

// Queue choreography: slot of each track before/after each move.
const START = [0, 1, 2, 3, 4];
const AFTER_DRAG = [0, 2, 3, 1, 4];
const AFTER_SHUFFLE = [0, 4, 2, 3, 1];
const DRAG_INDEX = 3;
const REMOVE_INDEX = 2;

const Q_ACTIONS: Array<{ at: number; label: string }> = [
  { at: QUEUE_BASE + 28, label: 'Drag to reorder' },
  { at: QUEUE_BASE + 78, label: '/shuffle' },
  { at: QUEUE_BASE + 116, label: '/remove 3' },
];

const ActionChip: React.FC<{ frame: number }> = ({ frame }) => (
  <div style={{ position: 'relative', height: 40, width: 300, display: 'flex', justifyContent: 'center' }}>
    {Q_ACTIONS.map(({ at, label }, i) => {
      const inn = enter(frame, at, 11, ease.bigPop);
      const next = Q_ACTIONS[i + 1];
      const out = next ? enter(frame, next.at, 8, ease.crisp) : 0;
      return (
        <div
          key={label}
          style={{
            position: 'absolute',
            opacity: enter(frame, at, 7) * (1 - out),
            scale: (1.35 - 0.35 * inn) * (1 - out * 0.12),
            padding: '9px 20px',
            borderRadius: 9999,
            background: colors.accentMuted,
            border: '1px solid rgba(232, 200, 122, 0.45)',
            color: colors.accent,
            fontFamily: fontBody,
            fontSize: 19,
            fontWeight: 600,
            whiteSpace: 'nowrap',
          }}
        >
          {label}
        </div>
      );
    })}
  </div>
);

const QueueStation: React.FC = () => {
  const frame = useCurrentFrame();
  const b = QUEUE_BASE;

  const dragP = enter(frame, b + 44, 16, ease.overshoot);
  const lift = interpolate(frame, [b + 36, b + 44, b + 60, b + 68], [0, 1, 1, 0], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });
  const shufP = enter(frame, b + 90, 14, ease.overshoot);
  const removeP = enter(frame, b + 128, 15, ease.crisp);
  const closeUp = enter(frame, b + 134, 15, ease.overshoot);

  const rows: QueueRowState[] = QUEUE.map((track, i) => {
    let slot =
      START[i] +
      (AFTER_DRAG[i] - START[i]) * dragP +
      (AFTER_SHUFFLE[i] - AFTER_DRAG[i]) * shufP;
    if (i !== REMOVE_INDEX && AFTER_SHUFFLE[i] > AFTER_SHUFFLE[REMOVE_INDEX]) {
      slot -= closeUp;
    }
    return {
      track,
      slot,
      now: i === 0,
      dragged: i === DRAG_INDEX && lift > 0.01,
      lift: i === DRAG_INDEX ? lift : 0,
      gone: i === REMOVE_INDEX ? removeP : 0,
    };
  });

  const dropVisible = dragP > 0.02 && dragP < 0.97 ? AFTER_DRAG[DRAG_INDEX] : null;
  const shuffleHot = interpolate(frame, [b + 84, b + 90, b + 108, b + 118], [0, 1, 1, 0], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });

  return (
    <AbsoluteFill style={{ flexDirection: 'column', alignItems: 'center', paddingTop: 34, gap: 12 }}>
      <div style={{ textAlign: 'center' }}>
        <RiseIn frame={frame} start={b + 2}>
          <Kicker>Queue management</Kicker>
        </RiseIn>
        <RiseIn frame={frame} start={b + 9} style={{ marginTop: 10 }}>
          <div style={{ fontFamily: fontHeading, fontSize: 72, color: colors.textPrimary, lineHeight: 1.05, letterSpacing: '-1px' }}>
            Your queue, <span style={{ color: colors.accent }}>your rules</span>
          </div>
        </RiseIn>
      </div>

      <ActionChip frame={frame} />

      <div style={{ position: 'relative' }}>
        <QueueCard
          width={640}
          rows={rows}
          countLabel={removeP > 0.5 ? '4 tracks' : '5 tracks'}
          dropSlot={dropVisible}
          shuffleHot={shuffleHot}
          heightRows={QUEUE.length - closeUp}
        />
        <CardShine at={b + 4} />
      </div>
    </AbsoluteFill>
  );
};

const T_PAUSE = TRANSPORT_BASE + 30;
const T_RESUME = TRANSPORT_BASE + 60;
const T_SKIP = TRANSPORT_BASE + 90;
const T_LOOP = TRANSPORT_BASE + 120;

/** Full-frame ghost word that slams with its action, then fades to a watermark. */
const GiantWord: React.FC<{ text: string; at: number; until?: number }> = ({ text, at, until }) => {
  const frame = useCurrentFrame();
  const slam = enter(frame, at, 7, ease.bigPop);
  // Holds near-peak for a readable second before settling into a watermark.
  const o = interpolate(frame, [at, at + 5, at + 30, at + 48], [0, 0.55, 0.4, 0.12], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });
  const gone = until === undefined ? 0 : enter(frame, until, 6, ease.crisp);
  if (frame < at) return null;
  return (
    <div
      style={{
        position: 'absolute',
        left: -220,
        width: 1720,
        top: 46,
        textAlign: 'center',
        fontFamily: fontHeading,
        fontSize: 268,
        lineHeight: 1,
        letterSpacing: '-6px',
        color: colors.textPrimary,
        opacity: o * (1 - gone),
        scale: `${1.18 - slam * 0.18}`,
        whiteSpace: 'nowrap',
        pointerEvents: 'none',
      }}
    >
      {text}
    </div>
  );
};

const TransportStation: React.FC = () => {
  const frame = useCurrentFrame();
  return (
    <AbsoluteFill>
      {/* Oversized action words, cropped by the frame edges */}
      <GiantWord text="PAUSE" at={T_PAUSE} until={T_SKIP} />
      <GiantWord text="SKIP" at={T_SKIP} until={T_LOOP} />
      <GiantWord text="LOOP" at={T_LOOP} />

      <AbsoluteFill style={{ flexDirection: 'column', alignItems: 'center', paddingTop: 74, gap: 210 }}>
        <RiseIn frame={frame} start={TRANSPORT_BASE + 4}>
          <Kicker>Playback</Kicker>
        </RiseIn>
        <div style={{ position: 'relative' }}>
          <Fringe at={T_SKIP} amp={2.5}>
            <TransportCard width={620} pauseAt={T_PAUSE} resumeAt={T_RESUME} skipAt={T_SKIP} loopAt={T_LOOP} />
          </Fringe>
          <CardShine at={TRANSPORT_BASE + 6} />
        </div>
      </AbsoluteFill>
    </AbsoluteFill>
  );
};

/* -------------------------------- Camera --------------------------------- */

export const WebAct: React.FC = () => {
  const frame = useCurrentFrame();

  const pan1 = enter(frame, PAN1[0], PAN1[1] - PAN1[0], ease.whip);
  const pan2 = enter(frame, PAN2[0], PAN2[1] - PAN2[0], ease.whip);
  const camX = (pan1 + pan2) * STATION_GAP;

  // Motion energy during pans: a scale dip + a horizontal smear.
  const d1 = interpolate(frame, [PAN1[0], (PAN1[0] + PAN1[1]) / 2, PAN1[1] + 2], [0, 1, 0], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });
  const d2 = interpolate(frame, [PAN2[0], (PAN2[0] + PAN2[1]) / 2, PAN2[1] + 2], [0, 1, 0], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });
  const panEnergy = d1 + d2;

  // The station world fades in beneath the swallowing dot, arriving from a zoom.
  const worldO = enter(frame, PUSH_END - 12, 12, ease.crisp);
  const arrive = interpolate(frame, [PUSH_END - 12, PUSH_END + 6], [1.14, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp', easing: ease.crisp });

  return (
    <SceneFrame>
      <ExitRamp from={WEB_ACT - 8}>
        {/* Station world */}
        <AbsoluteFill style={{ opacity: worldO, scale: `${arrive * (1 - panEnergy * 0.045)}` }}>
          <div
            style={{
              position: 'absolute',
              inset: 0,
              translate: `${-camX}px 0px`,
              scale: `${1 + panEnergy * 0.1} 1`,
              filter: panEnergy > 0.05 ? `blur(${panEnergy * 2.5}px)` : 'none',
            }}
          >
            <div style={{ position: 'absolute', left: 0, top: 0, width: 1280, height: 720 }}>
              <SearchStation />
            </div>
            <div style={{ position: 'absolute', left: STATION_GAP, top: 0, width: 1280, height: 720 }}>
              <QueueStation />
            </div>
            <div style={{ position: 'absolute', left: STATION_GAP * 2, top: 0, width: 1280, height: 720 }}>
              <TransportStation />
            </div>
          </div>
        </AbsoluteFill>

        {/* Browser reveal layer — camera pushes through it */}
        {frame < PUSH_END + 4 && (
          <AbsoluteFill style={{ opacity: 1 - enter(frame, PUSH_END - 8, 10, ease.crisp) }}>
            <Reveal />
          </AbsoluteFill>
        )}
      </ExitRamp>

      {/* The gold dot that swallows the lens, and the light events */}
      <DotSwallow />
      <WarmFlash at={PUSH_END - 6} peak={0.35} rise={4} fall={14} />
      <Sequence durationInFrames={26}>
        <AbsoluteFill style={{ opacity: 0.3, mixBlendMode: 'screen', pointerEvents: 'none' }}>
          <LightLeak durationInFrames={26} seed={4} />
        </AbsoluteFill>
      </Sequence>
    </SceneFrame>
  );
};
