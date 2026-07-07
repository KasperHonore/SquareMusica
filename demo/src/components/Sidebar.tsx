import React from 'react';
import { colors, radius } from '../theme';
import { fontHeading, fontBody } from '../fonts';
import { Search, Grid, Clock } from './Icons';
import { coverGradient } from './AlbumArt';
import { PLAYLISTS, type Playlist } from '../data';

const MosaicThumb: React.FC<{ seeds: Playlist['seeds']; size?: number }> = ({ seeds, size = 28 }) => (
  <div
    style={{
      width: size,
      height: size,
      borderRadius: 6,
      overflow: 'hidden',
      display: 'grid',
      gridTemplateColumns: '1fr 1fr',
      gridTemplateRows: '1fr 1fr',
      flexShrink: 0,
    }}
  >
    {seeds.map((s, i) => (
      <div key={i} style={{ background: coverGradient(s) }} />
    ))}
  </div>
);

const NavItem: React.FC<{ icon: React.ReactNode; label: string; active?: boolean }> = ({
  icon,
  label,
  active,
}) => (
  <div
    style={{
      display: 'flex',
      alignItems: 'center',
      gap: 10,
      padding: '9px 10px',
      borderRadius: radius.md,
      color: active ? colors.accent : colors.textSecondary,
      backgroundColor: active ? colors.accentMuted : 'transparent',
      fontSize: 14,
      fontFamily: fontBody,
    }}
  >
    <span style={{ display: 'flex', flexShrink: 0 }}>{icon}</span>
    {label}
  </div>
);

export const Sidebar: React.FC<{
  activeView?: 'search' | 'playlists' | 'history';
  activePlaylist?: number;
  userName?: string;
}> = ({ activeView = 'search', activePlaylist = -1, userName = 'Kasper' }) => (
  <div
    style={{
      display: 'flex',
      flexDirection: 'column',
      height: '100%',
      padding: '24px 16px',
      gap: 22,
      backgroundColor: colors.bgRaised,
      borderRight: `1px solid ${colors.border}`,
      fontFamily: fontBody,
    }}
  >
    {/* Bot identity */}
    <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '0 8px' }}>
      <div
        style={{
          width: 28,
          height: 28,
          borderRadius: '50%',
          background: `linear-gradient(135deg, ${colors.accent}, #b98f3f)`,
          flexShrink: 0,
        }}
      />
      <span style={{ fontFamily: fontHeading, fontSize: 20, letterSpacing: '-0.3px', color: colors.textPrimary }}>
        SquareMusica<span style={{ color: colors.accent }}>.</span>
      </span>
    </div>

    {/* Navigation */}
    <nav style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
      <NavItem icon={<Search size={15} />} label="Search" active={activeView === 'search'} />
      <NavItem icon={<Grid size={15} />} label="Playlists" active={activeView === 'playlists'} />
      <NavItem icon={<Clock size={15} />} label="History" active={activeView === 'history'} />
    </nav>

    {/* Playlists */}
    <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div
        style={{
          fontSize: 10,
          fontWeight: 600,
          textTransform: 'uppercase',
          letterSpacing: 1.2,
          color: colors.textMuted,
          padding: '0 8px',
        }}
      >
        My Playlists
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
        {PLAYLISTS.map((p, i) => (
          <div
            key={p.name}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 10,
              padding: '6px 8px',
              borderRadius: radius.md,
              backgroundColor: activePlaylist === i ? colors.accentSubtle : 'transparent',
            }}
          >
            <MosaicThumb seeds={p.seeds} />
            <div style={{ minWidth: 0, flex: 1 }}>
              <div
                style={{
                  fontSize: 13,
                  color: activePlaylist === i ? colors.textPrimary : colors.textSecondary,
                  whiteSpace: 'nowrap',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                }}
              >
                {p.name}
              </div>
              <div style={{ fontSize: 11, color: colors.textMuted }}>{p.count} tracks</div>
            </div>
          </div>
        ))}
      </div>
    </div>

    {/* User footer */}
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        padding: 10,
        backgroundColor: colors.bgElevated,
        borderRadius: radius.lg,
        border: `1px solid ${colors.border}`,
      }}
    >
      <div
        style={{
          width: 32,
          height: 32,
          borderRadius: '50%',
          background: 'linear-gradient(135deg,#6a5acd,#8a63d2)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          color: '#fff',
          fontSize: 14,
          fontWeight: 600,
          flexShrink: 0,
        }}
      >
        {userName.charAt(0)}
      </div>
      <div style={{ fontSize: 12, fontWeight: 500, flex: 1, color: colors.textPrimary }}>{userName}</div>
      <svg width={14} height={14} viewBox="0 0 24 24" fill="none" stroke={colors.textMuted} strokeWidth={2}>
        <path d="M9 21H5a2 2 0 01-2-2V5a2 2 0 012-2h4" />
        <polyline points="16 17 21 12 16 7" />
        <line x1="21" y1="12" x2="9" y2="12" />
      </svg>
    </div>
  </div>
);
