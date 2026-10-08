import { describe, it, expect } from 'vitest';
import { DuckingMixer } from '../../src/core/audioMixer.js';

// 48 kHz s16le stereo: 4 bytes per frame.
const RATE = 48000;
const ATTACK_FRAMES = (RATE * 200) / 1000; // 9600
const RELEASE_FRAMES = (RATE * 300) / 1000; // 14400

/** Build a stereo buffer where every sample (both channels) has the same value. */
function constant(frames, value) {
  const buf = Buffer.alloc(frames * 4);
  for (let i = 0; i < frames * 2; i++) buf.writeInt16LE(value, i * 2);
  return buf;
}

/** Build a stereo buffer with a deterministic varying pattern. */
function pattern(frames) {
  const buf = Buffer.alloc(frames * 4);
  for (let i = 0; i < frames * 2; i++) buf.writeInt16LE(((i * 37) % 2000) - 1000, i * 2);
  return buf;
}

/**
 * Push chunks through the mixer and collect everything it emits for them.
 * Waits until both sides of the Transform have drained, so successive calls on
 * the same mixer see consecutive, non-overlapping output.
 */
async function run(mixer, chunks) {
  const out = [];
  const onData = (c) => out.push(c);
  mixer.on('data', onData);
  for (const c of chunks) mixer.write(c);
  for (let i = 0; i < 1000; i++) {
    await new Promise((r) => setImmediate(r));
    if (mixer.writableLength === 0 && mixer.readableLength === 0) break;
  }
  mixer.off('data', onData);
  return Buffer.concat(out);
}

/** Left-channel sample at a frame index. */
const left = (buf, frame) => buf.readInt16LE(frame * 4);
const right = (buf, frame) => buf.readInt16LE(frame * 4 + 2);

describe('DuckingMixer', () => {
  it('passes music through byte-identical with no overlay', async () => {
    const mixer = new DuckingMixer();
    const input = pattern(2000);
    const output = await run(mixer, [input.subarray(0, 3000), input.subarray(3000)]);
    expect(output.equals(input)).toBe(true);
  });

  it('uses a 5-frame (5 × 3840 B) highWaterMark', async () => {
    const mixer = new DuckingMixer();
    expect(mixer.readableHighWaterMark).toBe(5 * 3840);
    expect(mixer.writableHighWaterMark).toBe(5 * 3840);
  });

  it('ramps music gain 1.0 → 0.3 over 200 ms and adds overlay samples', async () => {
    const mixer = new DuckingMixer();
    const frames = ATTACK_FRAMES + 2000;
    const overlay = constant(frames, 100);
    mixer.overlay(overlay);
    const output = await run(mixer, [constant(frames, 10000)]);

    // First frame: full gain plus overlay.
    expect(left(output, 0)).toBe(10000 + 100);
    expect(right(output, 0)).toBe(10000 + 100);
    // Halfway through the attack: gain ≈ 0.65.
    expect(left(output, ATTACK_FRAMES / 2)).toBeCloseTo(10000 * 0.65 + 100, -1);
    // Strictly decreasing during the attack.
    expect(left(output, 1000)).toBeLessThan(left(output, 500));
    // After the attack: gain held at 0.3.
    expect(left(output, ATTACK_FRAMES)).toBe(3000 + 100);
    expect(left(output, ATTACK_FRAMES + 1500)).toBe(3000 + 100);
  });

  it('clamps sums to int16', async () => {
    const mixer = new DuckingMixer();
    mixer.overlay(constant(10, 30000));
    const up = await run(mixer, [constant(10, 30000)]);
    expect(left(up, 0)).toBe(32767);

    const mixer2 = new DuckingMixer();
    mixer2.overlay(constant(10, -30000));
    const down = await run(mixer2, [constant(10, -30000)]);
    expect(left(down, 0)).toBe(-32768);
  });

  it('ramps 0.3 → 1.0 over 300 ms after the overlay is exhausted', async () => {
    const mixer = new DuckingMixer();
    const overlayFrames = ATTACK_FRAMES + 1000;
    mixer.overlay(constant(overlayFrames, 0));
    const total = overlayFrames + RELEASE_FRAMES + 1000;
    const output = await run(mixer, [constant(total, 10000)]);

    // Still ducked right at the end of the overlay.
    expect(left(output, overlayFrames - 1)).toBe(3000);
    // Mid-release: ≈ 0.65.
    expect(left(output, overlayFrames + RELEASE_FRAMES / 2)).toBeCloseTo(6500, -1);
    // Release complete: unity gain, samples unchanged.
    expect(left(output, overlayFrames + RELEASE_FRAMES)).toBe(10000);
    expect(left(output, total - 1)).toBe(10000);
  });

  it('returns to byte-identical passthrough once fully released', async () => {
    const mixer = new DuckingMixer();
    mixer.overlay(constant(100, 50));
    await run(mixer, [constant(100 + RELEASE_FRAMES + 10, 0)]);
    const tail = pattern(500);
    expect((await run(mixer, [tail])).equals(tail)).toBe(true);
  });

  it('cancelOverlay() drops the remaining overlay and starts the release', async () => {
    const mixer = new DuckingMixer();
    mixer.overlay(constant(ATTACK_FRAMES * 4, 100));
    const first = await run(mixer, [constant(ATTACK_FRAMES, 10000)]);
    expect(left(first, ATTACK_FRAMES - 1)).toBeGreaterThan(3000);

    mixer.cancelOverlay();
    const second = await run(mixer, [constant(RELEASE_FRAMES + 100, 10000)]);

    // No overlay added any more; gain climbs back to unity.
    expect(left(second, 0)).toBeLessThan(3300);
    expect(left(second, RELEASE_FRAMES / 2)).toBeGreaterThan(left(second, 0));
    expect(left(second, RELEASE_FRAMES + 50)).toBe(10000);
  });

  it('cancelOverlay() is idempotent with no overlay', async () => {
    const mixer = new DuckingMixer();
    mixer.cancelOverlay();
    mixer.cancelOverlay();
    const input = pattern(100);
    expect((await run(mixer, [input])).equals(input)).toBe(true);
  });

  it('overlay() replaces an in-progress overlay', async () => {
    const mixer = new DuckingMixer();
    mixer.overlay(constant(1000, 100));
    await run(mixer, [constant(10, 0)]);
    mixer.overlay(constant(1000, 200));
    const out = await run(mixer, [constant(10, 0)]);
    expect(left(out, 0)).toBe(200);
  });

  it('carries a partial frame across chunks with no sample loss', async () => {
    const input = pattern(1000);
    const splits = [3, 5, 1, 2, 4001 - 11];
    const chunks = [];
    let pos = 0;
    for (const n of splits) {
      chunks.push(input.subarray(pos, pos + n));
      pos += n;
    }
    chunks.push(input.subarray(pos));

    const passthrough = await run(new DuckingMixer(), chunks);
    expect(passthrough.equals(input)).toBe(true);

    // Same with an overlay active: output must match a single-chunk run.
    const a = new DuckingMixer();
    a.overlay(constant(1000, 7));
    const b = new DuckingMixer();
    b.overlay(constant(1000, 7));
    const fromChunks = await run(a, chunks);
    const whole = await run(b, [input]);
    expect(fromChunks.equals(whole)).toBe(true);
  });
});
