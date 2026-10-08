import { describe, it, expect } from 'vitest';
import {
  DuckingMixer,
  DUCK_GAIN,
  ATTACK_FRAMES,
  RELEASE_FRAMES
} from '../../src/core/audioMixer.js';

const BYTES_PER_FRAME = 4;

// Build an s16le stereo buffer with every sample set to `value` (or a per-frame
// function of the frame index).
function pcm(frames, value) {
  const buf = Buffer.alloc(frames * BYTES_PER_FRAME);
  for (let i = 0; i < frames; i++) {
    const v = typeof value === 'function' ? value(i) : value;
    buf.writeInt16LE(v, i * 4);
    buf.writeInt16LE(v, i * 4 + 2);
  }
  return buf;
}

function left(buf, frame) {
  return buf.readInt16LE(frame * 4);
}

function right(buf, frame) {
  return buf.readInt16LE(frame * 4 + 2);
}

// Push chunks through the mixer synchronously and collect everything it emits.
// `between` runs after each chunk index listed in it, so a test can call
// overlay()/cancelOverlay() at a precise point in the stream.
function run(mixer, chunks, between = {}) {
  const out = [];
  mixer.on('data', (d) => out.push(d));
  chunks.forEach((chunk, i) => {
    mixer.write(chunk);
    between[i]?.(mixer);
  });
  mixer.end();
  return new Promise((resolve, reject) => {
    mixer.on('end', () => resolve(Buffer.concat(out)));
    mixer.on('error', reject);
  });
}

describe('DuckingMixer (R1, contracts §4)', () => {
  it('uses the contract constants: duck to 0.3, 200 ms attack, 300 ms release', () => {
    expect(DUCK_GAIN).toBe(0.3);
    expect(ATTACK_FRAMES).toBe(9600);
    expect(RELEASE_FRAMES).toBe(14400);
  });

  it('sets highWaterMark to 5 frames of 20 ms', () => {
    const mixer = new DuckingMixer();
    expect(mixer.readableHighWaterMark).toBe(5 * 3840);
    expect(mixer.writableHighWaterMark).toBe(5 * 3840);
  });

  it('passes music through byte-identical when there is no overlay', async () => {
    const music = Buffer.alloc(10_000);
    for (let i = 0; i < music.length; i++) music[i] = (i * 37) % 256;
    const out = await run(new DuckingMixer(), [
      music.subarray(0, 3001),
      music.subarray(3001, 7000),
      music.subarray(7000)
    ]);
    expect(out.equals(music)).toBe(true);
  });

  it('ramps the music gain 1.0 → 0.3 over 9600 frames and adds the overlay', async () => {
    const frames = ATTACK_FRAMES + 2000;
    const mixer = new DuckingMixer();
    mixer.overlay(pcm(frames, 100));
    const out = await run(mixer, [pcm(frames, 10_000)]);

    expect(out.length).toBe(frames * 4);
    // The first frame is already slightly ducked and carries the overlay.
    expect(left(out, 0)).toBeLessThan(10_100);
    expect(left(out, 0)).toBeGreaterThan(10_000);
    // Halfway through the attack the gain is about 0.65.
    expect(left(out, ATTACK_FRAMES / 2 - 1)).toBeCloseTo(6_500 + 100, -1);
    // At the end of the attack and after, gain sits at 0.3.
    expect(left(out, ATTACK_FRAMES - 1)).toBe(3_100);
    expect(left(out, frames - 1)).toBe(3_100);
    expect(right(out, frames - 1)).toBe(3_100);
    // Monotonic decrease through the attack.
    for (let i = 1; i < ATTACK_FRAMES; i += 97) {
      expect(left(out, i)).toBeLessThanOrEqual(left(out, i - 1));
    }
  });

  it('clamps sums to int16', async () => {
    const mixer = new DuckingMixer();
    const overlay = pcm(10, (i) => (i % 2 ? -32_000 : 32_000));
    mixer.overlay(overlay);
    const out = await run(mixer, [pcm(10, (i) => (i % 2 ? -32_000 : 32_000))]);
    for (let i = 0; i < 10; i++) {
      expect(left(out, i)).toBe(i % 2 ? -32_768 : 32_767);
    }
  });

  it('ramps back 0.3 → 1.0 over 14400 frames once the overlay is exhausted', async () => {
    const overlayFrames = ATTACK_FRAMES + 100;
    const frames = overlayFrames + RELEASE_FRAMES + 500;
    const mixer = new DuckingMixer();
    mixer.overlay(pcm(overlayFrames, 0));
    const out = await run(mixer, [pcm(frames, 10_000)]);

    expect(left(out, overlayFrames - 1)).toBe(3_000);
    // Release is in progress: strictly between ducked and unity.
    const mid = overlayFrames + RELEASE_FRAMES / 2;
    expect(left(out, mid)).toBeGreaterThan(6_000);
    expect(left(out, mid)).toBeLessThan(7_000);
    expect(left(out, overlayFrames + RELEASE_FRAMES - 1)).toBe(10_000);
    expect(left(out, frames - 1)).toBe(10_000);
  });

  it('returns to byte-identical passthrough after the release completes', async () => {
    const overlayFrames = 10;
    const mixer = new DuckingMixer();
    mixer.overlay(pcm(overlayFrames, 0));
    const tailMusic = pcm(1000, (i) => (i * 13) % 2000);
    const out = await run(mixer, [pcm(overlayFrames + RELEASE_FRAMES + 50, 500), tailMusic]);
    expect(out.subarray(out.length - tailMusic.length).equals(tailMusic)).toBe(true);
  });

  it('cancelOverlay() drops the remaining overlay and starts the release ramp', async () => {
    const mixer = new DuckingMixer();
    mixer.overlay(pcm(ATTACK_FRAMES * 4, 1_000));
    const out = await run(mixer, [pcm(ATTACK_FRAMES, 10_000), pcm(RELEASE_FRAMES + 10, 10_000)], {
      0: (m) => m.cancelOverlay()
    });

    expect(left(out, ATTACK_FRAMES - 1)).toBe(4_000);
    // No overlay after the cancel: first post-cancel frame is music only, just above 0.3.
    const first = left(out, ATTACK_FRAMES);
    expect(first).toBeGreaterThanOrEqual(3_000);
    expect(first).toBeLessThan(3_100);
    expect(left(out, ATTACK_FRAMES + RELEASE_FRAMES - 1)).toBe(10_000);
  });

  it('cancelOverlay() is idempotent and harmless with no overlay', async () => {
    const mixer = new DuckingMixer();
    mixer.cancelOverlay();
    mixer.cancelOverlay();
    const music = pcm(100, 1234);
    const out = await run(mixer, [music]);
    expect(out.equals(music)).toBe(true);
  });

  it('overlay() replaces an overlay already in progress', async () => {
    const mixer = new DuckingMixer();
    mixer.overlay(pcm(1000, 500));
    const out = await run(mixer, [pcm(10, 0), pcm(10, 0)], {
      0: (m) => m.overlay(pcm(1000, 77))
    });
    expect(left(out, 9)).toBe(500);
    expect(left(out, 10)).toBe(77);
  });

  it('carries a partial frame across chunks with no sample loss', async () => {
    const mixer = new DuckingMixer();
    mixer.overlay(pcm(4, 0));
    const music = pcm(4, (i) => 1000 * (i + 1));
    // Split at 3 bytes, then mid-frame again.
    const out = await run(mixer, [music.subarray(0, 3), music.subarray(3, 9), music.subarray(9)]);
    expect(out.length).toBe(music.length);
    // Frames are ducked a little but each still reflects its own source sample,
    // proving no byte was dropped or shifted.
    for (let i = 0; i < 4; i++) {
      const expected = 1000 * (i + 1);
      expect(left(out, i)).toBeLessThanOrEqual(expected);
      expect(left(out, i)).toBeGreaterThan(expected * 0.99);
      expect(right(out, i)).toBe(left(out, i));
    }
  });
});
