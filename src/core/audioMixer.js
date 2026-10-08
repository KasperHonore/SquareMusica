import { Transform } from 'node:stream';

// 48 kHz s16le stereo: 2 channels × 2 bytes per frame.
const SAMPLE_RATE = 48000;
const BYTES_PER_FRAME = 4;
// One 20 ms Discord frame of PCM.
const PCM_FRAME_BYTES = (SAMPLE_RATE / 50) * BYTES_PER_FRAME;

const DUCK_GAIN = 0.3;
const ATTACK_FRAMES = SAMPLE_RATE * 0.2; // 200 ms
const RELEASE_FRAMES = SAMPLE_RATE * 0.3; // 300 ms
const ATTACK_STEP = (1 - DUCK_GAIN) / ATTACK_FRAMES;
const RELEASE_STEP = (1 - DUCK_GAIN) / RELEASE_FRAMES;

function clamp16(value) {
  if (value > 32767) return 32767;
  if (value < -32768) return -32768;
  return value;
}

/**
 * Mixes an overlay (the DJ voice) over a music stream, ducking the music while
 * the overlay plays (ADR-002, research R1).
 *
 * Input and output are 48 kHz s16le stereo. With no overlay and the gain at
 * unity, chunks pass through untouched. With an overlay, the music gain ramps
 * linearly per frame toward 0.3 over 200 ms, overlay samples are added, and the
 * sum is clamped to int16. When the overlay runs out (or is cancelled) the gain
 * ramps back to 1.0 over 300 ms. A partial frame at the end of a chunk is held
 * and prepended to the next one.
 */
export class DuckingMixer extends Transform {
  constructor() {
    super({ highWaterMark: 5 * PCM_FRAME_BYTES });
    this._gain = 1;
    this._overlay = null;
    this._overlayOffset = 0;
    this._carry = null;
  }

  /**
   * Start mixing `buffer` over the music, replacing any overlay in progress.
   * @param {Buffer} buffer - 48 kHz s16le stereo PCM
   */
  overlay(buffer) {
    const usable = buffer.length - (buffer.length % BYTES_PER_FRAME);
    this._overlay = usable > 0 ? buffer.subarray(0, usable) : null;
    this._overlayOffset = 0;
  }

  /** Drop the remaining overlay and begin the release ramp. Idempotent. */
  cancelOverlay() {
    this._overlay = null;
    this._overlayOffset = 0;
  }

  /** @returns {boolean} Whether overlay samples remain to be mixed. */
  hasOverlay() {
    return this._overlay !== null;
  }

  _transform(chunk, _encoding, callback) {
    let input = chunk;
    if (this._carry) {
      input = Buffer.concat([this._carry, chunk]);
      this._carry = null;
    }

    const whole = input.length - (input.length % BYTES_PER_FRAME);
    if (whole < input.length) {
      this._carry = Buffer.from(input.subarray(whole));
      input = input.subarray(0, whole);
    }
    if (input.length === 0) {
      callback();
      return;
    }

    if (!this._overlay && this._gain === 1) {
      callback(null, input);
      return;
    }

    callback(null, this._mix(input));
  }

  _flush(callback) {
    // A trailing partial frame cannot be mixed; pass it on unchanged so no
    // bytes are lost.
    if (this._carry) {
      const rest = this._carry;
      this._carry = null;
      callback(null, rest);
      return;
    }
    callback();
  }

  _mix(input) {
    const out = Buffer.allocUnsafe(input.length);
    const frames = input.length / BYTES_PER_FRAME;
    let gain = this._gain;

    for (let f = 0; f < frames; f++) {
      const pos = f * BYTES_PER_FRAME;
      const overlay = this._overlay;

      if (overlay) {
        gain = Math.max(DUCK_GAIN, gain - ATTACK_STEP);
      } else if (gain < 1) {
        gain = Math.min(1, gain + RELEASE_STEP);
      }
      // Snap float drift so the ramp lands exactly on its targets.
      if (Math.abs(gain - DUCK_GAIN) < 1e-9) gain = DUCK_GAIN;
      if (Math.abs(1 - gain) < 1e-9) gain = 1;

      let l = Math.round(input.readInt16LE(pos) * gain);
      let r = Math.round(input.readInt16LE(pos + 2) * gain);

      if (overlay) {
        l += overlay.readInt16LE(this._overlayOffset);
        r += overlay.readInt16LE(this._overlayOffset + 2);
        this._overlayOffset += BYTES_PER_FRAME;
        if (this._overlayOffset >= overlay.length) {
          this._overlay = null;
          this._overlayOffset = 0;
        }
      }

      out.writeInt16LE(clamp16(l), pos);
      out.writeInt16LE(clamp16(r), pos + 2);
    }

    this._gain = gain;
    return out;
  }
}
