import { getDjConfig } from '../config/env.js';
import { logger } from '../utils/logger.js';

// ElevenLabs text-to-speech for DJ lines (R3, contracts §5c). Plain fetch, no
// SDK: one POST, buffered, converted to the mixer's 48 kHz s16le stereo.

const API_BASE = 'https://api.elevenlabs.io/v1/text-to-speech';
const TIMEOUT_MS = 8000;
const MAX_SECONDS = 15; // FR-002
const RATE_RETRY_DELAY_MS = 1000;

// pcm_48000 matches Discord's rate. Some plan tiers reject it, so on the first
// format rejection we switch to pcm_24000 (upsampled 2× by sample doubling)
// for the rest of the process lifetime.
const FORMATS = {
  pcm_48000: { rate: 48000, upsample: 1 },
  pcm_24000: { rate: 24000, upsample: 2 }
};
let outputFormat = 'pcm_48000';

/** Restore the initial output format. Tests only. */
export function _resetForTests() {
  outputFormat = 'pcm_48000';
}

/**
 * An error with a `kind` the DJ breaker (R9) can act on:
 * `quota` (opens the breaker long, no retry), `rate`, `invalid`, `format`,
 * `too_long`, `timeout`, `http`, `network`.
 */
export class TtsError extends Error {
  constructor(kind, message) {
    super(message);
    this.name = 'TtsError';
    this.kind = kind;
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function readDetail(response) {
  try {
    const body = await response.text();
    try {
      return { text: body, json: JSON.parse(body) };
    } catch {
      return { text: body, json: null };
    }
  } catch {
    return { text: '', json: null };
  }
}

function isFormatRejection(status, detail) {
  if (status !== 400 && status !== 403 && status !== 422) return false;
  return /output[_ ]?format/i.test(detail.text);
}

async function request(text, format) {
  const { apiKey, voiceId, modelId } = getDjConfig().elevenlabs;
  const url = `${API_BASE}/${encodeURIComponent(voiceId)}?output_format=${format}`;
  try {
    return await fetch(url, {
      method: 'POST',
      headers: { 'xi-api-key': apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, model_id: modelId }),
      signal: AbortSignal.timeout(TIMEOUT_MS)
    });
  } catch (error) {
    if (error?.name === 'TimeoutError' || error?.name === 'AbortError') {
      throw new TtsError('timeout', `ElevenLabs request timed out after ${TIMEOUT_MS}ms`);
    }
    throw new TtsError('network', `ElevenLabs request failed: ${error?.message}`);
  }
}

/**
 * Mono s16le at `rate` → 48 kHz s16le stereo. Each mono sample becomes
 * `upsample` frames, each with the sample on both channels.
 */
function toStereo48k(mono, upsample) {
  const samples = Math.floor(mono.length / 2);
  const out = Buffer.allocUnsafe(samples * upsample * 4);
  let pos = 0;
  for (let i = 0; i < samples; i++) {
    const s = mono.readInt16LE(i * 2);
    for (let k = 0; k < upsample; k++) {
      out.writeInt16LE(s, pos);
      out.writeInt16LE(s, pos + 2);
      pos += 4;
    }
  }
  return out;
}

/**
 * Synthesize a DJ line.
 * @param {string} text
 * @returns {Promise<Buffer>} 48 kHz s16le stereo PCM, at most 15 s
 * @throws {TtsError}
 */
export async function synthesize(text) {
  let rateRetried = false;
  let formatRetried = false;

  for (;;) {
    const format = outputFormat;
    const response = await request(text, format);

    if (response.ok) {
      const mono = Buffer.from(await response.arrayBuffer());
      const { rate, upsample } = FORMATS[format];
      const seconds = mono.length / (rate * 2);
      if (seconds > MAX_SECONDS) {
        throw new TtsError('too_long', `TTS clip is ${seconds.toFixed(1)}s, over ${MAX_SECONDS}s`);
      }
      return toStereo48k(mono, upsample);
    }

    const detail = await readDetail(response);
    const status = response.status;

    if (status === 401) {
      throw new TtsError('quota', `ElevenLabs 401: ${detail.text}`);
    }
    if (status === 429) {
      if (rateRetried) throw new TtsError('rate', `ElevenLabs 429: ${detail.text}`);
      rateRetried = true;
      await sleep(RATE_RETRY_DELAY_MS);
      continue;
    }
    if (!formatRetried && format === 'pcm_48000' && isFormatRejection(status, detail)) {
      formatRetried = true;
      outputFormat = 'pcm_24000';
      logger.warn(
        `[DJ] ElevenLabs rejected pcm_48000 (${status}); using pcm_24000 with 2x upsampling`
      );
      continue;
    }
    if (status === 422) {
      throw new TtsError('invalid', `ElevenLabs 422: ${detail.text}`);
    }
    throw new TtsError('http', `ElevenLabs ${status}: ${detail.text}`);
  }
}
