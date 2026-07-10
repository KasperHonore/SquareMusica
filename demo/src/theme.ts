/**
 * Wave design tokens — ported verbatim from the SquareMusica web app
 * (web/src/index.css). Keeping these identical is what makes the recreated
 * UI read as the real product.
 */
export const colors = {
  bg: '#0d0d0f',
  bgRaised: '#141418',
  bgElevated: '#1c1c22',
  bgSurface3: '#242430',
  bgOverlay: 'rgba(0, 0, 0, 0.7)',

  textPrimary: '#f0ede8',
  textSecondary: '#8e8a9a',
  textMuted: '#5a5668',
  textInverse: '#0d0d0f',

  accent: '#e8c87a',
  accentHover: '#f0d68a',
  accentMuted: 'rgba(232, 200, 122, 0.1)',
  accentSubtle: 'rgba(232, 200, 122, 0.06)',

  border: 'rgba(255, 255, 255, 0.07)',
  borderStrong: 'rgba(255, 255, 255, 0.12)',

  success: '#7ec87a',
  warning: '#e8c87a',
  error: '#e87a7a',
  danger: '#e87a7a',
  info: '#7ac4e8',
} as const;

export const radius = {
  sm: 6,
  md: 8,
  lg: 10,
  xl: 14,
  '2xl': 20,
  full: 9999,
} as const;

// Discord brand surfaces (for the recreated channel scene).
export const discord = {
  bg: '#313338',
  bgSecondary: '#2b2d31',
  bgTertiary: '#1e1f22',
  input: '#383a40',
  blurple: '#5865f2',
  text: '#dbdee1',
  textMuted: '#949ba4',
  green: '#23a55a',
  embedBar: '#e8c87a',
  mention: 'rgba(88, 101, 242, 0.3)',
} as const;

// Video canvas geometry. Scenes are authored in DESIGN space (1280x720) and a
// single scale wrapper in Demo.tsx raster-scales them to the render resolution
// — transforms rasterize at output res, so text/SVG stay vector-crisp.
export const VIDEO = {
  width: 1920,
  height: 1080,
  fps: 30,
} as const;

export const DESIGN = {
  width: 1280,
  height: 720,
} as const;

export const DESIGN_SCALE = VIDEO.width / DESIGN.width;
