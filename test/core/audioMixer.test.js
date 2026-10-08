import { describe, it, expect } from 'vitest';
import { DuckingMixer } from '../../src/core/audioMixer.js';

// 48 kHz s16le stereo: 4 bytes per frame.
const FRAME = 4;
const ATTACK_FRAMES = 9600; // 200 ms
const RELEASE_FRAMES = 14400; // 300 ms
const DUCK = 0.3;

/** A buffer of `frames` stereo frames, every sample set to `value`. */
function pcm(frames, value) {
  const buf = Buffer.alloc(frames * FRAME);
  for (let i = 0; i < frames * 2; i++) buf.writeInt16LE(value, i * 2);
  return buf;
}

/** Left-channel sample of frame `i`. */
function left(buf, i) {
  return buf.readInt16LE(i * FRAME);
}

function right(buf, i) {
  return buf.readInt16LE(i * FRAME + 2);
}

/** Feed chunks one write at a time (running `between` after each) and collect output. */
async function run(mixer, chunks, between = () => {}) {
  const out = [];
  mixer.on('data', (d) => out.push(d));
  for (let i = 0; i < chunks.length; i++) {
    await new Promise((resolve, reject) =>
      mixer.write(chunks[i], (err) => (err ? reject(err) : resolve()))
    );
    between(i);
  }
  await new Promise((resolve) => mixer.end(resolve));
  return Buffer.concat(out);
}

describe('DuckingMixer', () => {
  it('passes music through byte-identical when no overlay is set', async () => {
    const music = Buffer.alloc(3840 * 3);
    for (let i = 0; i < music.length; i++) music[i] = (i * 37) & 0xff;

    const out = await run(new DuckingMixer(), [music]);

    expect(out.equals(music)).toBe(true);
  });

  it('ducks the music 1.0 → 0.3 over 200 ms and adds the overlay samples', async () => {
    const mixer = new DuckingMixer();
    // Overlay long enough to outlast the attack ramp.
    mixer.overlay(pcm(ATTACK_FRAMES * 2, 100));

    const out = await run(mixer, [pcm(ATTACK_FRAMES * 2, 10000)]);

    // First frame is barely ducked; the ramp is linear and per sample.
    expect(left(out, 0)).toBeGreaterThanOrEqual(10000 + 100 - 2);
    const mid = left(out, ATTACK_FRAMES / 2 - 1);
    expect(mid).toBeGreaterThan(6500 + 100 - 3);
    expect(mid).toBeLessThan(6500 + 100 + 3);
    // Fully ducked at the end of the attack and held there.
    expect(left(out, ATTACK_FRAMES - 1)).toBe(10000 * DUCK + 100);
    expect(left(out, ATTACK_FRAMES + 100)).toBe(10000 * DUCK + 100);
    expect(right(out, ATTACK_FRAMES + 100)).toBe(10000 * DUCK + 100);
    // Monotonic decline through the attack.
    for (let i = 1; i < ATTACK_FRAMES; i += 97) {
      expect(left(out, i)).toBeLessThanOrEqual(left(out, i - 1));
    }
  });

  it('clamps sums to int16', async () => {
    const mixer = new DuckingMixer();
    mixer.overlay(pcm(10, 32000));
    const hi = await run(mixer, [pcm(10, 32767)]);
    for (let i = 0; i < 10; i++) expect(left(hi, i)).toBe(32767);

    const mixer2 = new DuckingMixer();
    mixer2.overlay(pcm(10, -32000));
    const lo = await run(mixer2, [pcm(10, -32768)]);
    for (let i = 0; i < 10; i++) expect(left(lo, i)).toBe(-32768);
  });

  it('ramps back 0.3 → 1.0 over 300 ms once the overlay is exhausted', async () => {
    const mixer = new DuckingMixer();
    mixer.overlay(pcm(ATTACK_FRAMES, 0));

    const total = ATTACK_FRAMES + RELEASE_FRAMES + 1000;
    const out = await run(mixer, [pcm(total, 10000)]);

    expect(left(out, ATTACK_FRAMES - 1)).toBe(10000 * DUCK);
    const midRelease = left(out, ATTACK_FRAMES + RELEASE_FRAMES / 2 - 1);
    expect(midRelease).toBeGreaterThan(6500 - 3);
    expect(midRelease).toBeLessThan(6500 + 3);
    expect(left(out, ATTACK_FRAMES + RELEASE_FRAMES - 1)).toBe(10000);
    // Back to unity passthrough after the release.
    expect(left(out, total - 1)).toBe(10000);
  });

  it('cancelOverlay drops the remaining overlay and starts the release ramp', async () => {
    const mixer = new DuckingMixer();
    mixer.overlay(pcm(ATTACK_FRAMES * 4, 500));

    const chunk = ATTACK_FRAMES; // first chunk covers the whole attack
    const out = await run(
      mixer,
      [pcm(chunk, 10000), pcm(RELEASE_FRAMES + 100, 10000)],
      (i) => i === 0 && mixer.cancelOverlay()
    );

    expect(left(out, chunk - 1)).toBe(10000 * DUCK + 500);
    // No more overlay after the cancel; music ramps back up.
    expect(left(out, chunk)).toBeLessThan(10000 * DUCK + 10);
    expect(left(out, chunk + RELEASE_FRAMES - 1)).toBe(10000);
    expect(left(out, chunk + RELEASE_FRAMES + 50)).toBe(10000);
  });

  it('cancelOverlay is idempotent and harmless with no overlay', async () => {
    const mixer = new DuckingMixer();
    mixer.cancelOverlay();
    mixer.cancelOverlay();
    const music = pcm(100, 1234);
    const out = await run(mixer, [music]);
    expect(out.equals(music)).toBe(true);
  });

  it('a new overlay replaces one in progress', async () => {
    const mixer = new DuckingMixer();
    mixer.overlay(pcm(ATTACK_FRAMES * 2, 700));
    const out = await run(
      mixer,
      [pcm(ATTACK_FRAMES, 0), pcm(10, 0)],
      (i) => i === 0 && mixer.overlay(pcm(10, 42))
    );
    expect(left(out, ATTACK_FRAMES)).toBe(42);
  });

  it('carries a partial frame across chunks with no sample loss', async () => {
    const music = Buffer.alloc(40);
    for (let i = 0; i < music.length; i++) music[i] = (i * 11 + 3) & 0xff;

    const passthrough = await run(new DuckingMixer(), [
      music.subarray(0, 3),
      music.subarray(3, 21),
      music.subarray(21)
    ]);
    expect(passthrough.equals(music)).toBe(true);

    const mixer = new DuckingMixer();
    mixer.overlay(pcm(10, 0));
    const musicFrames = pcm(10, 1000);
    const mixed = await run(mixer, [musicFrames.subarray(0, 3), musicFrames.subarray(3)]);
    expect(mixed.length).toBe(musicFrames.length);
    // Every frame was mixed whole: both channels of each frame share one gain.
    for (let i = 0; i < 10; i++) expect(left(mixed, i)).toBe(right(mixed, i));
  });

  it('uses a 5-frame (100 ms) highWaterMark', () => {
    const mixer = new DuckingMixer();
    expect(mixer.readableHighWaterMark).toBe(5 * 3840);
    expect(mixer.writableHighWaterMark).toBe(5 * 3840);
  });
});
