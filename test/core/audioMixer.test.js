import { describe, it, expect } from 'vitest';
import {
  DuckingMixer,
  DUCK_GAIN,
  ATTACK_FRAMES,
  RELEASE_FRAMES
} from '../../src/core/audioMixer.js';

// Synthetic 48 kHz s16le stereo. Each frame is [left, right] int16.
function pcm(frames, left, right = left) {
  const buf = Buffer.alloc(frames * 4);
  for (let i = 0; i < frames; i++) {
    buf.writeInt16LE(typeof left === 'function' ? left(i) : left, i * 4);
    buf.writeInt16LE(typeof right === 'function' ? right(i) : right, i * 4 + 2);
  }
  return buf;
}

function frameAt(buf, i) {
  return [buf.readInt16LE(i * 4), buf.readInt16LE(i * 4 + 2)];
}

// Push one chunk through the Transform synchronously and return what it emitted.
function feed(mixer, chunk) {
  let out = null;
  mixer._transform(chunk, 'buffer', (err, data) => {
    if (err) throw err;
    out = data ?? Buffer.alloc(0);
  });
  return out;
}

describe('DuckingMixer', () => {
  it('passes music through byte-identical when no overlay is set', () => {
    const mixer = new DuckingMixer();
    const music = pcm(
      960,
      (i) => ((i * 37) % 30000) - 15000,
      (i) => -i
    );
    const out = feed(mixer, music);
    expect(out.equals(music)).toBe(true);
  });

  it('uses a highWaterMark of 5 voice frames', () => {
    expect(new DuckingMixer().writableHighWaterMark).toBe(5 * 3840);
  });

  it('ramps music 1.0 -> 0.3 over 200 ms (9600 frames) and adds the overlay', () => {
    expect(ATTACK_FRAMES).toBe(9600);
    const mixer = new DuckingMixer();
    mixer.overlay(pcm(20000, 100, -100));
    const out = feed(mixer, pcm(12000, 10000));

    // First frame: gain one step below unity, overlay added.
    const step = (1 - DUCK_GAIN) / ATTACK_FRAMES;
    const [l0, r0] = frameAt(out, 0);
    expect(l0).toBe(Math.round(10000 * (1 - step)) + 100);
    expect(r0).toBe(Math.round(10000 * (1 - step)) - 100);

    // Halfway through the attack the gain is about 0.65.
    const [lMid] = frameAt(out, 4799);
    expect(lMid).toBe(Math.round(10000 * (1 - step * 4800)) + 100);

    // From the end of the attack the music sits at the duck gain.
    expect(frameAt(out, ATTACK_FRAMES - 1)).toEqual([3100, 2900]);
    expect(frameAt(out, 11999)).toEqual([3100, 2900]);
  });

  it('clamps the sum to int16', () => {
    const mixer = new DuckingMixer();
    mixer.overlay(pcm(4, 32767, -32768));
    const out = feed(mixer, pcm(4, 32767, -32768));
    expect(frameAt(out, 0)).toEqual([32767, -32768]);
    expect(frameAt(out, 3)).toEqual([32767, -32768]);
  });

  it('ramps 0.3 -> 1.0 over 300 ms once the overlay is exhausted', () => {
    expect(RELEASE_FRAMES).toBe(14400);
    const mixer = new DuckingMixer();
    mixer.overlay(pcm(ATTACK_FRAMES, 0));
    feed(mixer, pcm(ATTACK_FRAMES, 10000));
    expect(mixer.hasOverlay()).toBe(false);

    const out = feed(mixer, pcm(RELEASE_FRAMES + 100, 10000));
    const step = (1 - DUCK_GAIN) / RELEASE_FRAMES;
    expect(frameAt(out, 0)[0]).toBe(Math.round(10000 * (DUCK_GAIN + step)));
    expect(frameAt(out, RELEASE_FRAMES / 2 - 1)[0]).toBe(6500);
    expect(frameAt(out, RELEASE_FRAMES - 1)[0]).toBe(10000);
    expect(frameAt(out, RELEASE_FRAMES + 99)[0]).toBe(10000);

    // Back at unity: passthrough is byte-identical again.
    const music = pcm(100, 1234, -4321);
    expect(feed(mixer, music).equals(music)).toBe(true);
  });

  it('cancelOverlay() drops the remaining overlay and starts the release', () => {
    const mixer = new DuckingMixer();
    mixer.overlay(pcm(100000, 500));
    feed(mixer, pcm(ATTACK_FRAMES, 10000));
    mixer.cancelOverlay();
    mixer.cancelOverlay(); // idempotent
    expect(mixer.hasOverlay()).toBe(false);

    const out = feed(mixer, pcm(10, 10000));
    // No overlay added any more, and the gain is rising from the duck level.
    const step = (1 - DUCK_GAIN) / RELEASE_FRAMES;
    expect(frameAt(out, 0)[0]).toBe(Math.round(10000 * (DUCK_GAIN + step)));
    expect(frameAt(out, 9)[0]).toBe(Math.round(10000 * (DUCK_GAIN + step * 10)));
  });

  it('overlay() replaces an overlay in progress', () => {
    const mixer = new DuckingMixer();
    mixer.overlay(pcm(10, 111));
    mixer.overlay(pcm(10, 7));
    const out = feed(mixer, pcm(1, 0));
    expect(frameAt(out, 0)).toEqual([7, 7]);
  });

  it('carries a partial frame into the next chunk with no sample loss', () => {
    const mixer = new DuckingMixer();
    const music = pcm(
      6,
      (i) => 1000 + i,
      (i) => -1000 - i
    );

    const outputs = [
      feed(mixer, music.subarray(0, 3)),
      feed(mixer, music.subarray(3, 13)),
      feed(mixer, music.subarray(13))
    ];
    for (const out of outputs) expect(out.length % 4).toBe(0);
    expect(outputs[0].length).toBe(0);
    expect(Buffer.concat(outputs).equals(music)).toBe(true);
  });

  it('keeps frame alignment of the mix across a split chunk', () => {
    const mixer = new DuckingMixer();
    mixer.overlay(pcm(2, 5));
    const music = pcm(2, 0);
    const out = Buffer.concat([feed(mixer, music.subarray(0, 3)), feed(mixer, music.subarray(3))]);
    expect(frameAt(out, 0)).toEqual([5, 5]);
    expect(frameAt(out, 1)).toEqual([5, 5]);
  });

  it('works as a real stream', async () => {
    const mixer = new DuckingMixer();
    const music = pcm(960, 42);
    const chunks = [];
    mixer.on('data', (c) => chunks.push(c));
    const done = new Promise((resolve) => mixer.on('end', resolve));
    mixer.write(music.subarray(0, 7));
    mixer.end(music.subarray(7));
    await done;
    expect(Buffer.concat(chunks).equals(music)).toBe(true);
  });
});
