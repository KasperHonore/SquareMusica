import React from 'react';
import { AbsoluteFill } from 'remotion';
import { colors } from '../theme';
import { fontBody } from '../fonts';
import { Sidebar } from './Sidebar';
import { RightPanel } from './RightPanel';
import { MiniPlayer } from './MiniPlayer';
import { NOW_PLAYING, type Track } from '../data';

export type PlayerState = {
  track?: Track | null;
  playing?: boolean;
  progress?: number;
  loop?: 'off' | 'queue' | 'track';
};

export const Dashboard: React.FC<{
  center: React.ReactNode;
  activeView?: 'search' | 'playlists' | 'history';
  activePlaylist?: number;
  nowPlaying?: Track;
  player?: PlayerState;
  voiceConnected?: boolean;
}> = ({
  center,
  activeView = 'search',
  activePlaylist = -1,
  nowPlaying = NOW_PLAYING,
  player = {},
  voiceConnected = true,
}) => {
  const {
    track = nowPlaying,
    playing = true,
    progress = 0,
    loop = 'off',
  } = player;

  return (
    <AbsoluteFill style={{ backgroundColor: colors.bg, fontFamily: fontBody }}>
      <div
        style={{
          height: '100%',
          display: 'grid',
          gridTemplateRows: '1fr 72px',
          gridTemplateColumns: '220px 1fr 300px',
        }}
      >
        <div style={{ gridColumn: '1 / 2', gridRow: '1 / 2', overflow: 'hidden' }}>
          <Sidebar activeView={activeView} activePlaylist={activePlaylist} />
        </div>
        <div style={{ gridColumn: '2 / 3', gridRow: '1 / 2', overflow: 'hidden', minWidth: 0 }}>{center}</div>
        <div style={{ gridColumn: '3 / 4', gridRow: '1 / 2', overflow: 'hidden' }}>
          <RightPanel track={track ?? nowPlaying} playing={playing} />
        </div>
        <div style={{ gridColumn: '1 / 4', gridRow: '2 / 3' }}>
          <MiniPlayer
            track={track}
            playing={playing}
            progress={progress}
            loop={loop}
            voiceConnected={voiceConnected}
          />
        </div>
      </div>
    </AbsoluteFill>
  );
};
