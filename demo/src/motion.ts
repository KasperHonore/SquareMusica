import { Easing, interpolate } from 'remotion';

/**
 * Rhythm + motion language for the "on the beat" demo.
 * 30 fps, 120 BPM  ->  1 beat = 15 frames, 1 bar (4 beats) = 60 frames.
 * Every entrance/hit is choreographed onto this grid so the video reads as
 * musical even as a silent GIF.
 */
export const FPS = 30;
export const BEAT = 15;
export const BAR = BEAT * 4;

export const beats = (n: number) => Math.round(n * BEAT);
export const bars = (n: number) => Math.round(n * BAR);

/** Punchy, web-stolen easing curves. */
export const ease = {
  crisp: Easing.bezier(0.16, 1, 0.3, 1), // strong ease-out, no overshoot
  overshoot: Easing.bezier(0.34, 1.56, 0.64, 1), // pops a little past then settles
  bigPop: Easing.bezier(0.3, 1.9, 0.5, 1), // aggressive overshoot for beat hits
  inOut: Easing.bezier(0.45, 0, 0.55, 1), // balanced, for slow camera moves
  whip: Easing.bezier(0.75, 0, 0.2, 1), // fast in, fast out — snappy slide
  rampIn: Easing.bezier(0.6, 0, 0.95, 0.4), // accelerates into a cut, never settles
} as const;

/** 0→1 over [start, start+dur] with easing, clamped. */
export const enter = (frame: number, start: number, dur: number, easing = ease.crisp) =>
  interpolate(frame, [start, start + dur], [0, 1], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
    easing,
  });

/** Sharp spike on every downbeat that decays to 0 — drives glow/scale thumps. */
export const beatPulse = (frame: number, beatFrames = BEAT, power = 3) => {
  const phase = ((frame % beatFrames) + beatFrames) % beatFrames;
  return Math.pow(1 - phase / beatFrames, power);
};

/** Heavier pulse once per bar (emphasise the 1). */
export const barPulse = (frame: number, power = 4) => {
  const phase = ((frame % BAR) + BAR) % BAR;
  return Math.pow(1 - phase / BAR, power);
};

/** Index of the current beat since frame 0. */
export const beatIndex = (frame: number) => Math.floor(frame / BEAT);
