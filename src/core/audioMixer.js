import { Transform } from 'node:stream';

// 48 kHz s16le stereo: 4 bytes per frame, 960 frames (3840 B) per 20 ms.
const SAMPLE_RATE = 48_000;
const BYTES_PER_FRAME = 4;
const BYTES_PER_20MS = 3840;

export const DUCK_GAIN = 0.3;
export const ATTACK_FRAMES = (SAMPLE_RATE * 200) / 1000;
export const RELEASE_FRAMES = (SAMPLE_RATE * 300) / 1000;

const ATTACK_STEP = (1 - DUCK_GAIN) / ATTACK_FRAMES;
const RELEASE_STEP = (1 - DUCK_GAIN) / RELEASE_FRAMES;
const GAIN_EPSILON = 1e-9;

function clamp16(value) {
  if (value > 32767) return 32767;
  if (value < -32768) return -32768;
  return value;
}

/**
 * Mixes a spoken overlay over music, ducking the music while it plays
 * (research R1, contracts §4). Input and overlay are 48 kHz s16le stereo.
 *
 * With no overlay and the gain at unity, chunks pass through untouched. With
 * an overlay the music gain ramps linearly per frame to 0.3 over 200 ms and the
 * overlay samples are added, clamped to int16. When the overlay runs out, or
 * cancelOverlay() is called, the gain ramps back to 1.0 over 300 ms.
 *
 * One mixer is created per track, so an overlay can never outlive its track.
 */
export class DuckingMixer extends Transform {
  constructor() {
    // A small buffer keeps the delay between overlay() and audible ducking low.
    super({ highWaterMark: 5 * BYTES_PER_20MS });
    this._gain = 1;
    this._overlay = null;
    this._overlayOffset = 0;
    this._remainder = null;
  }

  /**
   * Start mixing `buffer` over the music, replacing any overlay in progress.
   * @param {Buffer} buffer - 48 kHz s16le stereo PCM
   */
  overlay(buffer) {
    // Drop any trailing partial frame so reads stay frame aligned.
    const usable = buffer.length - (buffer.length % BYTES_PER_FRAME);
    this._overlay = usable > 0 ? buffer.subarray(0, usable) : null;
    this._overlayOffset = 0;
  }

  /** Drop the remaining overlay and ramp the music back to unity. Idempotent. */
  cancelOverlay() {
    this._overlay = null;
    this._overlayOffset = 0;
  }

  _transform(chunk, _encoding, callback) {
    let data = chunk;
    if (this._remainder) {
      data = Buffer.concat([this._remainder, chunk]);
      this._remainder = null;
    }

    const tail = data.length % BYTES_PER_FRAME;
    if (tail > 0) {
      this._remainder = Buffer.from(data.subarray(data.length - tail));
      data = data.subarray(0, data.length - tail);
    }

    if (data.length > 0) {
      this.push(this._mix(data));
    }
    callback();
  }

  _flush(callback) {
    // A trailing partial frame cannot be a valid sample pair; pass it through so
    // no byte is silently dropped.
    if (this._remainder) {
      this.push(this._remainder);
      this._remainder = null;
    }
    callback();
  }

  _mix(data) {
    if (!this._overlay && this._gain === 1) {
      return data;
    }

    const out = Buffer.allocUnsafe(data.length);
    for (let pos = 0; pos < data.length; pos += BYTES_PER_FRAME) {
      const overlay = this._overlay;
      if (overlay) {
        this._gain -= ATTACK_STEP;
        // Snap at the ends so float drift can't leave the gain a hair off target.
        if (this._gain < DUCK_GAIN + GAIN_EPSILON) this._gain = DUCK_GAIN;
      } else if (this._gain < 1) {
        this._gain += RELEASE_STEP;
        if (this._gain > 1 - GAIN_EPSILON) this._gain = 1;
      }

      let left = data.readInt16LE(pos) * this._gain;
      let right = data.readInt16LE(pos + 2) * this._gain;

      if (overlay) {
        left += overlay.readInt16LE(this._overlayOffset);
        right += overlay.readInt16LE(this._overlayOffset + 2);
        this._overlayOffset += BYTES_PER_FRAME;
        if (this._overlayOffset >= overlay.length) {
          this._overlay = null;
          this._overlayOffset = 0;
        }
      }

      out.writeInt16LE(clamp16(Math.round(left)), pos);
      out.writeInt16LE(clamp16(Math.round(right)), pos + 2);
    }
    return out;
  }
}
