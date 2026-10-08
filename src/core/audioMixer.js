import { Transform } from 'node:stream';

// 48 kHz s16le stereo: 4 bytes per frame, 48 frames per millisecond.
const FRAME_BYTES = 4;
const FRAMES_PER_MS = 48;
// One Discord voice frame is 20 ms = 960 frames = 3840 bytes.
const VOICE_FRAME_BYTES = 20 * FRAMES_PER_MS * FRAME_BYTES;

export const DUCK_GAIN = 0.3;
export const ATTACK_FRAMES = 200 * FRAMES_PER_MS; // 9600
export const RELEASE_FRAMES = 300 * FRAMES_PER_MS; // 14400

/**
 * Mixes a spoken overlay over s16le stereo music, ducking the music while the
 * overlay plays (research R1, contracts §4).
 *
 * With no overlay and the gain at unity, chunks pass through untouched. With an
 * overlay the music gain ramps linearly to DUCK_GAIN over ATTACK_FRAMES, the
 * overlay is added sample by sample and the sum is clamped to int16. When the
 * overlay runs out (or is cancelled) the gain ramps back to 1.0 over
 * RELEASE_FRAMES. Gain changes per frame, so both channels share one gain.
 */
export class DuckingMixer extends Transform {
  constructor() {
    super({ highWaterMark: 5 * VOICE_FRAME_BYTES });
    this._gain = 1;
    this._overlay = null;
    this._overlayPos = 0;
    this._carry = null;
  }

  /**
   * Start mixing `buffer` (48 kHz s16le stereo) into the music. Replaces any
   * overlay already in progress.
   * @param {Buffer} buffer
   */
  overlay(buffer) {
    const usable = buffer.length - (buffer.length % FRAME_BYTES);
    this._overlay = usable > 0 ? buffer.subarray(0, usable) : null;
    this._overlayPos = 0;
  }

  /** Drop the rest of the overlay and start the release ramp. Idempotent. */
  cancelOverlay() {
    this._overlay = null;
    this._overlayPos = 0;
  }

  /** @returns {boolean} Whether an overlay is still being mixed. */
  hasOverlay() {
    return this._overlay !== null;
  }

  _transform(chunk, _encoding, callback) {
    let data = chunk;
    if (this._carry) {
      data = Buffer.concat([this._carry, chunk]);
      this._carry = null;
    }
    const remainder = data.length % FRAME_BYTES;
    if (remainder) {
      this._carry = Buffer.from(data.subarray(data.length - remainder));
      data = data.subarray(0, data.length - remainder);
    }
    if (data.length === 0) {
      callback();
      return;
    }

    if (!this._overlay && this._gain === 1) {
      callback(null, data);
      return;
    }

    const out = Buffer.allocUnsafe(data.length);
    const attackStep = (1 - DUCK_GAIN) / ATTACK_FRAMES;
    const releaseStep = (1 - DUCK_GAIN) / RELEASE_FRAMES;

    for (let offset = 0; offset < data.length; offset += FRAME_BYTES) {
      const overlay = this._overlay;
      if (overlay) {
        this._gain = Math.max(DUCK_GAIN, this._gain - attackStep);
      } else if (this._gain < 1) {
        this._gain = Math.min(1, this._gain + releaseStep);
      }

      let left = data.readInt16LE(offset) * this._gain;
      let right = data.readInt16LE(offset + 2) * this._gain;

      if (overlay) {
        left += overlay.readInt16LE(this._overlayPos);
        right += overlay.readInt16LE(this._overlayPos + 2);
        this._overlayPos += FRAME_BYTES;
        if (this._overlayPos >= overlay.length) {
          this._overlay = null;
          this._overlayPos = 0;
        }
      }

      out.writeInt16LE(clamp(left), offset);
      out.writeInt16LE(clamp(right), offset + 2);
    }

    callback(null, out);
  }

  _flush(callback) {
    // A trailing partial frame can't be mixed; pass it on rather than drop it.
    const carry = this._carry;
    this._carry = null;
    callback(null, carry ?? undefined);
  }
}

function clamp(sample) {
  const rounded = Math.round(sample);
  if (rounded > 32767) return 32767;
  if (rounded < -32768) return -32768;
  return rounded;
}
