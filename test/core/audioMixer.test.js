import { describe, it, expect } from 'vitest';
import { DuckingMixer } from '../../src/core/audioMixer.js';

// s16le stereo at 48 kHz: 4 bytes per frame, 48 frames per ms.
const FRAME = 4;
const ATTACK_FRAMES = 9600; // 200 ms
const RELEASE_FRAMES = 14400; // 300 ms

function constantPcm(frames, value) {
  const buf = Buffer.alloc(frames * FRAME);
  for (let i = 0; i < frames * 2; i++) buf.writeInt16LE(value, i * 2);
  return buf;
}

function rampPcm(frames) {
  const buf = Buffer.alloc(frames * FRAME);
  for (let i = 0; i < frames * 2; i++) buf.writeInt16LE(((i * 37) % 65536) - 32768, i * 2);
  return buf;
}

function left(buf, frame) {
  return buf.readInt16LE(frame * FRAME);
}

function right(buf, frame) {
  return buf.readInt16LE(frame * FRAME + 2);
}

describe('DuckingMixer (R1, contracts §4)', () => {
  it('passes music through byte-identical with no overlay', () => {
    const mixer = new DuckingMixer();
    const music = rampPcm(5000);
    expect(mixer.mix(music).equals(music)).toBe(true);
  });

  it('uses a 5-frame (20 ms each) highWaterMark', () => {
    expect(new DuckingMixer().writableHighWaterMark).toBe(5 * 3840);
  });

  it('ramps music gain 1.0 → 0.3 over 200 ms and adds the overlay', () => {
    const mixer = new DuckingMixer();
    mixer.overlay(constantPcm(20000, 0));
    const out = mixer.mix(constantPcm(12000, 10000));

    // Linear: halfway through the attack the gain is about 0.65.
    expect(Math.abs(left(out, ATTACK_FRAMES / 2 - 1) - 6500)).toBeLessThanOrEqual(2);
    expect(Math.abs(left(out, ATTACK_FRAMES - 1) - 3000)).toBeLessThanOrEqual(1);
    expect(left(out, 11000)).toBe(3000);
    expect(right(out, 11000)).toBe(3000);
    // Strictly descending through the attack.
    expect(left(out, 100)).toBeLessThan(left(out, 99));
    expect(left(out, 100)).toBeGreaterThan(9900);
  });

  it('adds overlay samples on top of the ducked music', () => {
    const mixer = new DuckingMixer();
    mixer.overlay(constantPcm(20000, 500));
    const out = mixer.mix(constantPcm(12000, 1000));
    expect(left(out, 11000)).toBe(300 + 500);
  });

  it('clamps sums to the int16 range', () => {
    const mixer = new DuckingMixer();
    mixer.overlay(constantPcm(10, 30000));
    expect(left(mixer.mix(constantPcm(10, 30000)), 0)).toBe(32767);

    const neg = new DuckingMixer();
    neg.overlay(constantPcm(10, -30000));
    expect(left(neg.mix(constantPcm(10, -30000)), 0)).toBe(-32768);
  });

  it('ramps back 0.3 → 1.0 over 300 ms once the overlay is exhausted', () => {
    const mixer = new DuckingMixer();
    mixer.overlay(constantPcm(12000, 0));
    mixer.mix(constantPcm(12000, 10000)); // fully ducked, overlay consumed

    const out = mixer.mix(constantPcm(RELEASE_FRAMES + 2000, 10000));
    expect(Math.abs(left(out, 0) - 3000)).toBeLessThanOrEqual(2);
    expect(Math.abs(left(out, RELEASE_FRAMES / 2 - 1) - 6500)).toBeLessThanOrEqual(2);
    expect(Math.abs(left(out, RELEASE_FRAMES - 1) - 10000)).toBeLessThanOrEqual(1);
    expect(left(out, RELEASE_FRAMES + 1000)).toBe(10000);

    // Back at unity, passthrough is byte-identical again.
    const music = rampPcm(100);
    expect(mixer.mix(music).equals(music)).toBe(true);
  });

  it('cancelOverlay() drops the rest of the overlay and starts the release ramp', () => {
    const mixer = new DuckingMixer();
    mixer.overlay(constantPcm(48000, 500));
    mixer.mix(constantPcm(12000, 1000));
    mixer.cancelOverlay();

    const out = mixer.mix(constantPcm(RELEASE_FRAMES + 100, 1000));
    // No overlay added any more: the first frame is ducked music only.
    expect(left(out, 0)).toBeLessThanOrEqual(301);
    expect(left(out, RELEASE_FRAMES + 50)).toBe(1000);
  });

  it('cancelOverlay() with no overlay is a no-op', () => {
    const mixer = new DuckingMixer();
    mixer.cancelOverlay();
    mixer.cancelOverlay();
    const music = rampPcm(10);
    expect(mixer.mix(music).equals(music)).toBe(true);
  });

  it('a new overlay replaces one in progress', () => {
    const mixer = new DuckingMixer();
    mixer.overlay(constantPcm(48000, 500));
    mixer.mix(constantPcm(12000, 0));
    mixer.overlay(constantPcm(48000, 200));
    expect(left(mixer.mix(constantPcm(1, 0)), 0)).toBe(200);
  });

  it('carries a partial frame into the next chunk with no sample loss', () => {
    const mixer = new DuckingMixer();
    const music = rampPcm(50);
    const parts = [music.subarray(0, 3), music.subarray(3, 101), music.subarray(101)];
    const out = Buffer.concat(parts.map((p) => mixer.mix(p)));
    expect(out.equals(music)).toBe(true);
  });

  it('keeps frames aligned when ducking across odd chunk boundaries', () => {
    const whole = new DuckingMixer();
    whole.overlay(constantPcm(1000, 123));
    const expected = whole.mix(rampPcm(800));

    const split = new DuckingMixer();
    split.overlay(constantPcm(1000, 123));
    const music = rampPcm(800);
    const out = Buffer.concat([
      split.mix(music.subarray(0, 3)),
      split.mix(music.subarray(3, 1001)),
      split.mix(music.subarray(1001))
    ]);
    expect(out.equals(expected)).toBe(true);
  });

  it('works as a stream: output equals input with no overlay', async () => {
    const mixer = new DuckingMixer();
    const music = rampPcm(20000);
    const chunks = [];
    mixer.on('data', (c) => chunks.push(c));
    const done = new Promise((resolve) => mixer.on('end', resolve));
    for (let i = 0; i < music.length; i += 777) mixer.write(music.subarray(i, i + 777));
    mixer.end();
    await done;
    expect(Buffer.concat(chunks).equals(music)).toBe(true);
  });
});
