import { Transform } from 'node:stream';

// 48 kHz s16le stereo, the format Discord's Raw stream type expects.
const SAMPLE_RATE = 48000;
const BYTES_PER_FRAME = 4; // 2 channels × 2 bytes
// One 20 ms Opus frame of PCM. The highWaterMark is 5 of these (~100 ms), which
// bounds how far ahead of the voice pipeline the mixer reads, and so how late a
// duck can start after overlay() is called (R1 "Onset latency").
const OPUS_FRAME_BYTES = (SAMPLE_RATE / 50) * BYTES_PER_FRAME; // 3840
const HIGH_WATER_MARK = 5 * OPUS_FRAME_BYTES;

const DUCK_GAIN = 0.3; // about −10 dB
const ATTACK_FRAMES = (SAMPLE_RATE * 200) / 1000;
const RELEASE_FRAMES = (SAMPLE_RATE * 300) / 1000;
const ATTACK_STEP = (1 - DUCK_GAIN) / ATTACK_FRAMES;
const RELEASE_STEP = (1 - DUCK_GAIN) / RELEASE_FRAMES;

const clamp16 = (v) => (v > 32767 ? 32767 : v < -32768 ? -32768 : v);

/**
 * Mixes a voice overlay over a music PCM stream, ducking the music while the
 * overlay plays (ADR-002, contracts §4).
 *
 * Music passes through untouched while no overlay is set and the gain is at
 * unity. With an overlay, the music gain ramps linearly to DUCK_GAIN over the
 * attack, overlay samples are added, and the sum is clamped to int16. When the
 * overlay runs out (or is cancelled) the gain ramps back to unity over the
 * release. Gain changes once per frame, so both channels always move together.
 *
 * Input chunks need not be frame-aligned: a trailing partial frame is held and
 * prepended to the next chunk.
 */
export class DuckingMixer extends Transform {
  constructor() {
    super({ highWaterMark: HIGH_WATER_MARK });
    this._gain = 1;
    this._overlay = null;
    this._overlayOffset = 0;
    this._carry = null;
  }

  /**
   * Start mixing `buffer` (48 kHz s16le stereo) over the music. Replaces any
   * overlay already in progress; the gain continues from wherever it is.
   * @param {Buffer} buffer
   */
  overlay(buffer) {
    const usable = buffer.length - (buffer.length % BYTES_PER_FRAME);
    this._overlay = usable > 0 ? buffer.subarray(0, usable) : null;
    this._overlayOffset = 0;
  }

  /** Drop the remaining overlay and start the release ramp. Idempotent. */
  cancelOverlay() {
    this._overlay = null;
    this._overlayOffset = 0;
  }

  _transform(chunk, _encoding, callback) {
    let data = chunk;
    if (this._carry) {
      data = Buffer.concat([this._carry, chunk]);
      this._carry = null;
    }

    const aligned = data.length - (data.length % BYTES_PER_FRAME);
    if (aligned < data.length) {
      this._carry = Buffer.from(data.subarray(aligned));
    }
    if (aligned === 0) {
      callback();
      return;
    }

    const frames = data.subarray(0, aligned);
    if (this._overlay === null && this._gain === 1) {
      callback(null, frames);
      return;
    }
    callback(null, this._mix(frames));
  }

  _flush(callback) {
    // A trailing partial frame can't be mixed; pass it through so no bytes are lost.
    if (this._carry) {
      this.push(this._carry);
      this._carry = null;
    }
    callback();
  }

  /**
   * Apply gain and overlay to a frame-aligned buffer.
   * @param {Buffer} frames
   * @returns {Buffer}
   */
  _mix(frames) {
    const out = Buffer.allocUnsafe(frames.length);
    let gain = this._gain;
    let overlay = this._overlay;
    let offset = this._overlayOffset;

    for (let pos = 0; pos < frames.length; pos += BYTES_PER_FRAME) {
      if (overlay !== null && offset >= overlay.length) {
        overlay = null;
        offset = 0;
      }

      let left = frames.readInt16LE(pos) * gain;
      let right = frames.readInt16LE(pos + 2) * gain;
      if (overlay !== null) {
        left += overlay.readInt16LE(offset);
        right += overlay.readInt16LE(offset + 2);
        offset += BYTES_PER_FRAME;
      }
      out.writeInt16LE(clamp16(Math.round(left)), pos);
      out.writeInt16LE(clamp16(Math.round(right)), pos + 2);

      if (overlay !== null) {
        gain = Math.max(DUCK_GAIN, gain - ATTACK_STEP);
      } else if (gain < 1) {
        gain = Math.min(1, gain + RELEASE_STEP);
      }
    }

    // An overlay that finished exactly at the end of this chunk is done.
    if (overlay !== null && offset >= overlay.length) {
      overlay = null;
      offset = 0;
    }

    this._gain = gain;
    this._overlay = overlay;
    this._overlayOffset = offset;
    return out;
  }
}
