import React from 'react';
import { colors, radius } from '../theme';
import { fontBody } from '../fonts';
import { Dashboard, type PlayerState } from './Dashboard';
import type { Track } from '../data';

/** A browser-window chrome frame with a big soft shadow + gold ring. */
export const AppWindow: React.FC<{
  width: number;
  height: number;
  children: React.ReactNode;
  urlLabel?: string;
  /** 0..1 — flares the URL pill gold (receives the /webui hand-off). */
  urlGlow?: number;
}> = ({ width, height, children, urlLabel = 'squaremusica.app', urlGlow = 0 }) => (
  <div
    style={{
      width,
      borderRadius: radius.xl,
      overflow: 'hidden',
      background: colors.bgRaised,
      border: `1px solid ${colors.borderStrong}`,
      boxShadow:
        '0 40px 120px rgba(0,0,0,0.6), 0 0 0 1px rgba(232,200,122,0.10), 0 0 60px rgba(232,200,122,0.10)',
      fontFamily: fontBody,
    }}
  >
    {/* Title bar */}
    <div
      style={{
        height: 34,
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        padding: '0 14px',
        background: colors.bgElevated,
        borderBottom: `1px solid ${colors.border}`,
      }}
    >
      {['#ff5f57', '#febc2e', '#28c840'].map((c) => (
        <div key={c} style={{ width: 11, height: 11, borderRadius: '50%', background: c }} />
      ))}
      <div
        style={{
          margin: '0 auto',
          padding: '3px 16px',
          borderRadius: 9999,
          background: colors.bg,
          border: `1px solid rgba(232, 200, 122, ${urlGlow * 0.7})`,
          color: urlGlow > 0.35 ? colors.accent : colors.textMuted,
          fontSize: 12,
          letterSpacing: 0.2,
          boxShadow: urlGlow > 0.02 ? `0 0 ${urlGlow * 22}px rgba(232, 200, 122, ${urlGlow * 0.6})` : 'none',
          scale: `${1 + urlGlow * 0.08}`,
        }}
      >
        {urlLabel}
      </div>
      <div style={{ width: 33 }} />
    </div>

    {/* Content */}
    <div style={{ width, height, position: 'relative', overflow: 'hidden' }}>{children}</div>
  </div>
);

/** The real Dashboard scaled to fit inside a 16:9 AppWindow. */
export const AppMock: React.FC<{
  width: number;
  view?: 'search' | 'playlists' | 'history';
  activePlaylist?: number;
  player?: PlayerState;
  nowPlaying?: Track;
  center: React.ReactNode;
  voiceConnected?: boolean;
  urlGlow?: number;
}> = ({ width, view = 'search', activePlaylist = -1, player, nowPlaying, center, voiceConnected = true, urlGlow = 0 }) => {
  const height = Math.round((width * 720) / 1280);
  const scale = width / 1280;
  return (
    <AppWindow width={width} height={height} urlGlow={urlGlow}>
      <div style={{ width: 1280, height: 720, position: 'relative', transform: `scale(${scale})`, transformOrigin: 'top left' }}>
        <Dashboard
          center={center}
          activeView={view}
          activePlaylist={activePlaylist}
          player={player}
          nowPlaying={nowPlaying}
          voiceConnected={voiceConnected}
        />
      </div>
    </AppWindow>
  );
};
