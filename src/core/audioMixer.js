import { Transform } from 'node:stream';

// 48 kHz s16le stereo: 2 channels × 2 bytes per frame.
const SAMPLE_RATE = 48000;
const BYTES_PER_FRAME = 4;
const FRAMES_PER_20MS = SAMPLE_RATE / 50;

// Music level under the DJ voice (about −10 dB), and the ramp lengths into and
// out of it. The release keeps the restore well inside FR-003's 1 s.
const DUCK_GAIN = 0.3;
const ATTACK_FRAMES = (SAMPLE_RATE * 200) / 1000;
const RELEASE_FRAMES = (SAMPLE_RATE * 300) / 1000;
const ATTACK_STEP = (1 - DUCK_GAIN) / ATTACK_FRAMES;
const RELEASE_STEP = (1 - DUCK_GAIN) / RELEASE_FRAMES;

const INT16_MIN = -32768;
const INT16_MAX = 32767;

function clamp16(value) {
  if (value > INT16_MAX) return INT16_MAX;
  if (value < INT16_MIN) return INT16_MIN;
  return value;
}

/**
 * Mixes an overlay (the DJ voice) over the music with ducking (research R1,
 * contracts §4). Both inputs are 48 kHz s16le stereo.
 *
 * With no overlay and the gain at unity, music passes through byte for byte.
 * While an overlay plays, the music gain ramps linearly per frame toward 0.3 over
 * 200 ms and the overlay samples are added on top, clamped to int16. When the
 * overlay runs out, or cancelOverlay() is called, the gain ramps back to 1.0 over
 * 300 ms. A partial frame at a chunk boundary is carried into the next chunk.
 *
 * The highWaterMark is 5 frames of 20 ms, so the mixer adds about 100 ms of
 * read-ahead between overlay() and the voice reaching Discord.
 */
export class DuckingMixer extends Transform {
  constructor() {
    super({ highWaterMark: 5 * FRAMES_PER_20MS * BYTES_PER_FRAME });
    this._gain = 1;
    this._overlay = null;
    this._overlayOffset = 0;
    this._carry = null;
  }

  /**
   * Start mixing `pcm` over the music, replacing any overlay in progress.
   * @param {Buffer} pcm - 48 kHz s16le stereo
   */
  overlay(pcm) {
    const usable = pcm.length - (pcm.length % BYTES_PER_FRAME);
    this._overlay = usable > 0 ? pcm.subarray(0, usable) : null;
    this._overlayOffset = 0;
  }

  /**
   * Drop the rest of the overlay and start ramping the music back up. Idempotent.
   */
  cancelOverlay() {
    this._overlay = null;
    this._overlayOffset = 0;
  }

  /**
   * Mix one chunk of music. Synchronous, so the Transform and the tests share it.
   * @param {Buffer} chunk - s16le stereo music, any length
   * @returns {Buffer} Whole frames only; a trailing partial frame is held back
   */
  mix(chunk) {
    let input = chunk;
    if (this._carry) {
      input = Buffer.concat([this._carry, chunk]);
      this._carry = null;
    }

    const remainder = input.length % BYTES_PER_FRAME;
    if (remainder > 0) {
      this._carry = Buffer.from(input.subarray(input.length - remainder));
      input = input.subarray(0, input.length - remainder);
    }

    if (!this._overlay && this._gain === 1) return input;

    const out = Buffer.allocUnsafe(input.length);
    for (let pos = 0; pos < input.length; pos += BYTES_PER_FRAME) {
      const overlay = this._overlay;
      if (overlay) {
        this._gain = Math.max(DUCK_GAIN, this._gain - ATTACK_STEP);
      } else if (this._gain < 1) {
        this._gain = Math.min(1, this._gain + RELEASE_STEP);
      }

      let left = Math.round(input.readInt16LE(pos) * this._gain);
      let right = Math.round(input.readInt16LE(pos + 2) * this._gain);

      if (overlay) {
        left += overlay.readInt16LE(this._overlayOffset);
        right += overlay.readInt16LE(this._overlayOffset + 2);
        this._overlayOffset += BYTES_PER_FRAME;
        if (this._overlayOffset >= overlay.length) this.cancelOverlay();
      }

      out.writeInt16LE(clamp16(left), pos);
      out.writeInt16LE(clamp16(right), pos + 2);
    }
    return out;
  }

  _transform(chunk, _encoding, callback) {
    const out = this.mix(chunk);
    if (out.length > 0) this.push(out);
    callback();
  }

  _flush(callback) {
    // A partial frame left at end of stream is not playable audio; drop it.
    this._carry = null;
    callback();
  }
}
