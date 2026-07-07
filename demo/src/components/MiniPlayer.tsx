import React from 'react';
import { colors, radius } from '../theme';
import { fontBody } from '../fonts';
import { AlbumArt } from './AlbumArt';
import { Play, Pause, SkipNext, SkipPrevious, Loop } from './Icons';
import type { Track } from '../data';

const CtrlBtn: React.FC<{ children: React.ReactNode; active?: boolean }> = ({ children, active }) => (
  <div
    style={{
      padding: 7,
      borderRadius: radius.md,
      color: active ? colors.accent : colors.textSecondary,
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
    }}
  >
    {children}
  </div>
);

export const MiniPlayer: React.FC<{
  track?: Track | null;
  playing?: boolean;
  progress?: number; // 0..100
  loop?: 'off' | 'queue' | 'track';
  voiceConnected?: boolean;
  channelName?: string;
}> = ({ track, playing = true, progress = 0, loop = 'off', voiceConnected = true, channelName = 'general' }) => (
  <div
    style={{
      height: 72,
      backgroundColor: colors.bgRaised,
      borderTop: `1px solid ${colors.border}`,
      display: 'flex',
      alignItems: 'center',
      padding: '0 20px',
      gap: 12,
      fontFamily: fontBody,
    }}
  >
    {/* Left: art + track info */}
    <div style={{ display: 'flex', alignItems: 'center', gap: 10, width: 220, flexShrink: 0 }}>
      {track ? (
        <AlbumArt seed={track.seed} size={40} note={false} />
      ) : (
        <div style={{ width: 40, height: 40, borderRadius: 7, background: colors.bgSurface3 }} />
      )}
      <div style={{ minWidth: 0 }}>
        <div
          style={{
            fontSize: 13,
            fontWeight: 500,
            color: colors.textPrimary,
            whiteSpace: 'nowrap',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
          }}
        >
          {track?.title ?? '—'}
        </div>
        <div style={{ fontSize: 11, color: colors.textMuted }}>{track?.artist ?? 'Not playing'}</div>
      </div>
    </div>

    {/* Center: controls + progress */}
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 5 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 2 }}>
        <CtrlBtn active={loop !== 'off'}>
          <Loop size={15} />
        </CtrlBtn>
        <CtrlBtn>
          <SkipPrevious size={18} />
        </CtrlBtn>
        <div
          style={{
            width: 40,
            height: 40,
            borderRadius: '50%',
            background: colors.accent,
            color: colors.textInverse,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          {playing ? <Pause size={18} /> : <Play size={18} />}
        </div>
        <CtrlBtn>
          <SkipNext size={18} />
        </CtrlBtn>
      </div>
      <div style={{ width: '100%', maxWidth: 400, height: 2, background: colors.bgElevated, borderRadius: 2 }}>
        <div
          style={{
            width: `${Math.min(progress, 100)}%`,
            height: '100%',
            background: colors.textSecondary,
            borderRadius: 2,
          }}
        />
      </div>
    </div>

    {/* Right: voice pill */}
    <div
      style={{
        display: 'flex',
        borderRadius: radius.lg,
        border: `1px solid ${colors.border}`,
        overflow: 'hidden',
        backgroundColor: voiceConnected ? 'rgba(126,200,122,0.08)' : colors.bgElevated,
        flexShrink: 0,
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          padding: '6px 10px',
          fontSize: 11,
          color: voiceConnected ? colors.textSecondary : colors.textMuted,
          whiteSpace: 'nowrap',
        }}
      >
        <span
          style={{
            width: 6,
            height: 6,
            borderRadius: '50%',
            background: voiceConnected ? colors.success : colors.textMuted,
          }}
        />
        {voiceConnected ? `#${channelName}` : 'Not connected'}
      </div>
      <div style={{ width: 1, background: colors.border }} />
      <div
        style={{
          padding: '6px 12px',
          fontSize: 11,
          fontWeight: 500,
          color: voiceConnected ? colors.danger : colors.accent,
          whiteSpace: 'nowrap',
        }}
      >
        {voiceConnected ? 'Leave' : 'Join'}
      </div>
    </div>
  </div>
);
