/**
 * Fictional-but-plausible demo content. No real YouTube thumbnails are used —
 * album art is generated as deterministic gradients (see AlbumArt.tsx) so the
 * whole demo is self-contained and copyright-clean.
 */
export type Track = {
  title: string;
  artist: string;
  duration: string; // mm:ss
  seed: number; // drives the generated cover gradient
};

export const QUEUE: Track[] = [
  { title: 'Midnight Drive', artist: 'Neon Coast', duration: '3:42', seed: 12 },
  { title: 'Lofi Rain', artist: 'Sleepy Beats', duration: '2:58', seed: 47 },
  { title: 'Golden Hour', artist: 'Sundial', duration: '4:11', seed: 91 },
  { title: 'Weightless', artist: 'Marconi Union', duration: '3:20', seed: 5 },
  { title: 'Paper Planes', artist: 'Field Day', duration: '3:05', seed: 63 },
];

export const SEARCH_RESULTS: Track[] = [
  { title: 'Sunset Boulevard', artist: 'Coastlines', duration: '3:51', seed: 22 },
  { title: 'City Lights', artist: 'Après', duration: '4:02', seed: 38 },
  { title: 'Dreaming', artist: 'Smino', duration: '3:33', seed: 74 },
];

export type Playlist = {
  name: string;
  count: number;
  seeds: [number, number, number, number];
};

export const PLAYLISTS: Playlist[] = [
  { name: 'Focus Flow', count: 24, seeds: [12, 47, 91, 5] },
  { name: 'Late Night', count: 18, seeds: [63, 22, 38, 74] },
  { name: 'Throwbacks', count: 42, seeds: [7, 31, 55, 88] },
];

export const NOW_PLAYING: Track = QUEUE[0];

/** Tracks that cascade in during the playlist-import scene. */
export const IMPORT_TRACKS: Track[] = [
  { title: 'Night Swim', artist: 'Velvet Coast', duration: '3:12', seed: 29 },
  { title: 'Rooftop Rain', artist: 'Kyoto Club', duration: '4:05', seed: 83 },
  { title: 'Afterglow', artist: 'Nova Era', duration: '3:47', seed: 51 },
  { title: 'Slow Motion', artist: 'Delta Wave', duration: '2:59', seed: 17 },
];

export const IMPORT_PLAYLIST = {
  url: 'open.spotify.com/playlist/late-night-drive',
  total: 24,
} as const;
