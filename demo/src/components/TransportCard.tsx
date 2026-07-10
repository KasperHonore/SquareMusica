import React from 'react';
import { interpolate, useCurrentFrame } from 'remotion';
import { colors, radius } from '../theme';
import { fontBody } from '../fonts';
import { AlbumArt } from './AlbumArt';
import { Eq } from './Eq';
import { Play, Pause, SkipNext, SkipPrevious, Loop, Shuffle } from './Icons';
import { ease, enter } from '../motion';
import { QUEUE, type Track } from '../data';

const fmt = (s: number) => {
  const m = Math.floor(s / 60);
  const ss = Math.floor(s % 60);
  return `${m}:${String(ss).padStart(2, '0')}`;
};

const durSeconds = (t: Track) => {
  const [m, s] = t.duration.split(':').map(Number);
  return m * 60 + s;
};

/** Quick 0→1→0 press pulse around `at`. */
const press = (frame: number, at: number) => enter(frame, at, 5, ease.bigPop) - enter(frame, at + 7, 9);

const IconBtn: React.FC<{ children: React.ReactNode; pop?: number; hot?: boolean }> = ({ children, pop = 0, hot }) => (
  <div
    style={{
      width: 44,
      height: 44,
      borderRadius: '50%',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      color: hot ? colors.accent : colors.textSecondary,
      background: pop > 0.03 ? 'rgba(255,255,255,0.06)' : 'transparent',
      scale: 1 + pop * 0.22,
      filter: hot ? 'drop-shadow(0 0 8px rgba(232,200,122,0.6))' : 'none',
    }}
  >
    {children}
  </div>
);

/**
 * Oversized player transport that acts out pause → resume → skip → loop,
 * each on a downbeat. All state is derived from the event frames.
 */
export const TransportCard: React.FC<{
  width?: number;
  pauseAt: number;
  resumeAt: number;
  skipAt: number;
  loopAt: number;
}> = ({ width = 600, pauseAt, resumeAt, skipAt, loopAt }) => {
  const frame = useCurrentFrame();

  const playing = frame < pauseAt || frame >= resumeAt;
  const skipped = frame >= skipAt;
  const track = skipped ? QUEUE[1] : QUEUE[0];

  // Track info crossfade on skip.
  const swap = enter(frame, skipAt, 11, ease.crisp);
  const infoX = skipped ? (1 - swap) * 34 : 0;
  const infoO = skipped ? swap : 1;

  // Elapsed seconds: advances, freezes while paused, resets on skip.
  const before = interpolate(frame, [0, pauseAt, resumeAt, skipAt], [88, 97, 97, 106], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });
  const after = (frame - skipAt) * 0.28;
  const elapsed = skipped ? after : before;
  const total = durSeconds(track);
  const frac = Math.min(1, elapsed / total);

  const pausePop = press(frame, pauseAt) + press(frame, resumeAt);
  const nextPop = press(frame, skipAt);
  const loopPop = press(frame, loopAt);
  const loopOn = frame >= loopAt;
  const chipIn = enter(frame, loopAt, 10, ease.bigPop);

  return (
    <div
      style={{
        width,
        background: colors.bgRaised,
        borderRadius: radius.xl,
        border: `1px solid ${colors.borderStrong}`,
        boxShadow: '0 40px 110px rgba(0,0,0,0.55), 0 0 60px rgba(232,200,122,0.08)',
        padding: '26px 30px',
        fontFamily: fontBody,
        display: 'flex',
        flexDirection: 'column',
        gap: 20,
      }}
    >
      {/* Track info */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 16, height: 64 }}>
        <div style={{ opacity: infoO, scale: skipped ? 0.94 + swap * 0.06 : 1 }}>
          <AlbumArt seed={track.seed} size={62} radius={10} />
        </div>
        <div style={{ flex: 1, minWidth: 0, opacity: infoO, translate: `${infoX}px 0px` }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <div style={{ fontSize: 21, fontWeight: 600, color: colors.textPrimary, whiteSpace: 'nowrap' }}>{track.title}</div>
            <Eq height={15} playing={playing} />
          </div>
          <div style={{ fontSize: 15, color: colors.textSecondary, marginTop: 2 }}>{track.artist}</div>
        </div>
        {/* Loop mode chip — reserved slot, pops on the loop beat */}
        <div
          style={{
            padding: '7px 14px',
            borderRadius: 9999,
            border: `1px solid ${loopOn ? 'rgba(232,200,122,0.5)' : 'transparent'}`,
            background: loopOn ? colors.accentMuted : 'transparent',
            color: colors.accent,
            fontSize: 14,
            fontWeight: 600,
            opacity: chipIn,
            scale: 0.7 + chipIn * 0.3,
            whiteSpace: 'nowrap',
          }}
        >
          Loop · queue
        </div>
      </div>

      {/* Transport */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 18 }}>
        <IconBtn pop={loopPop} hot={loopOn}>
          <Loop size={21} />
        </IconBtn>
        <IconBtn>
          <SkipPrevious size={26} />
        </IconBtn>
        <div
          style={{
            width: 64,
            height: 64,
            borderRadius: '50%',
            background: colors.accent,
            color: colors.textInverse,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            scale: 1 + pausePop * 0.16,
            boxShadow: `0 0 ${16 + pausePop * 26}px rgba(232,200,122,${0.25 + pausePop * 0.4})`,
          }}
        >
          {playing ? <Pause size={28} /> : <Play size={28} style={{ marginLeft: 3 }} />}
        </div>
        <IconBtn pop={nextPop} hot={nextPop > 0.15}>
          <SkipNext size={26} />
        </IconBtn>
        <IconBtn>
          <Shuffle size={20} />
        </IconBtn>
      </div>

      {/* Progress */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
        <div style={{ fontSize: 13, color: colors.textMuted, fontVariantNumeric: 'tabular-nums', width: 40 }}>{fmt(elapsed)}</div>
        <div style={{ flex: 1, height: 4, background: colors.bgElevated, borderRadius: 4, overflow: 'hidden' }}>
          <div
            style={{
              width: `${frac * 100}%`,
              height: '100%',
              background: playing ? colors.accent : colors.textMuted,
              borderRadius: 4,
            }}
          />
        </div>
        <div style={{ fontSize: 13, color: colors.textMuted, fontVariantNumeric: 'tabular-nums', width: 40, textAlign: 'right' }}>
          {track.duration}
        </div>
      </div>
    </div>
  );
};
