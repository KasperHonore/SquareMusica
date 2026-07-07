import React from 'react';
import { colors, radius } from '../theme';
import { fontHeading } from '../fonts';
import { Search as SearchIcon } from './Icons';
import { coverGradient } from './AlbumArt';
import { PLAYLISTS } from '../data';

/** Static browse landing used inside the scaled AppMock. */
export const BrowseCenter: React.FC = () => (
  <div style={{ padding: '30px 34px', height: '100%', display: 'flex', flexDirection: 'column', gap: 24 }}>
    <div style={{ fontFamily: fontHeading, fontSize: 40, color: colors.textPrimary }}>Good evening</div>
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 12,
        padding: '15px 18px',
        borderRadius: radius.lg,
        background: colors.bgElevated,
        border: `1px solid ${colors.border}`,
        color: colors.textMuted,
        maxWidth: 560,
      }}
    >
      <SearchIcon size={18} color={colors.textMuted} />
      <span style={{ fontSize: 16 }}>Search for a song, artist, or paste a link…</span>
    </div>
    <div style={{ fontSize: 12, fontWeight: 600, textTransform: 'uppercase', letterSpacing: 1.4, color: colors.textMuted }}>
      Made for you
    </div>
    <div style={{ display: 'flex', gap: 20 }}>
      {PLAYLISTS.map((p) => (
        <div key={p.name} style={{ width: 168 }}>
          <div
            style={{
              width: 168,
              height: 168,
              borderRadius: radius.lg,
              overflow: 'hidden',
              display: 'grid',
              gridTemplateColumns: '1fr 1fr',
              gridTemplateRows: '1fr 1fr',
            }}
          >
            {p.seeds.map((s, i) => (
              <div key={i} style={{ background: coverGradient(s) }} />
            ))}
          </div>
          <div style={{ marginTop: 12, fontSize: 16, color: colors.textPrimary, fontWeight: 500 }}>{p.name}</div>
          <div style={{ fontSize: 13, color: colors.textMuted }}>{p.count} tracks</div>
        </div>
      ))}
    </div>
  </div>
);
