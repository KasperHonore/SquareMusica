import { getDjConfig } from '../config/env.js';
import { logger } from '../utils/logger.js';

const API_BASE = 'https://api.elevenlabs.io/v1/text-to-speech';
const TIMEOUT_MS = 8000;
const RATE_RETRY_DELAY_MS = 1000;
// FR-002: a line longer than this is never played.
const MAX_CLIP_SECONDS = 15;

// pcm_48000 matches Discord's rate. If the account's plan rejects it, fall back
// to pcm_24000 with 2× sample doubling for the rest of the process (R3).
let outputFormat = 'pcm_48000';

/**
 * A TTS failure. `kind` drives the DJ circuit breaker (R9):
 * - 'quota': 401 quota_exceeded or a bad key; no retry
 * - 'rate': 429 after one retry
 * - 'invalid': 422; no retry
 * - 'too_long': clip over 15 s
 * - 'http': any other non-2xx
 * - 'network': fetch failed or timed out
 */
export class TtsError extends Error {
  constructor(kind, message, cause) {
    super(message);
    this.name = 'TtsError';
    this.kind = kind;
    if (cause) this.cause = cause;
  }
}

async function readDetail(response) {
  try {
    const body = await response.json();
    return body?.detail ?? body;
  } catch {
    return null;
  }
}

function detailText(detail) {
  if (!detail) return '';
  if (typeof detail === 'string') return detail;
  return [detail.status, detail.message].filter(Boolean).join(': ') || JSON.stringify(detail);
}

function isFormatRejection(status, detail) {
  if (status !== 400 && status !== 403) return false;
  return /output_format|format/i.test(detailText(detail));
}

/** Duplicate every s16le sample: 2× upsample for mono, or mono → stereo. */
function doubleSamples(buffer) {
  const samples = Math.floor(buffer.length / 2);
  const out = Buffer.alloc(samples * 4);
  for (let i = 0; i < samples; i++) {
    const value = buffer.readInt16LE(i * 2);
    out.writeInt16LE(value, i * 4);
    out.writeInt16LE(value, i * 4 + 2);
  }
  return out;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function request(text, format) {
  const { apiKey, voiceId, modelId } = getDjConfig().elevenlabs;
  const url = `${API_BASE}/${encodeURIComponent(voiceId)}?output_format=${format}`;
  try {
    return await fetch(url, {
      method: 'POST',
      headers: { 'xi-api-key': apiKey, 'content-type': 'application/json' },
      body: JSON.stringify({ text, model_id: modelId }),
      signal: AbortSignal.timeout(TIMEOUT_MS)
    });
  } catch (error) {
    throw new TtsError('network', `ElevenLabs request failed: ${error.message}`, error);
  }
}

/**
 * Synthesize one DJ line.
 * @param {string} text
 * @returns {Promise<Buffer>} 48 kHz s16le stereo PCM
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
      const rate = format === 'pcm_24000' ? 24000 : 48000;
      if (mono.length / (rate * 2) > MAX_CLIP_SECONDS) {
        throw new TtsError('too_long', `TTS clip longer than ${MAX_CLIP_SECONDS} s`);
      }
      const mono48k = format === 'pcm_24000' ? doubleSamples(mono) : mono;
      return doubleSamples(mono48k);
    }

    const detail = await readDetail(response);
    const text_ = detailText(detail);

    if (!formatRetried && format === 'pcm_48000' && isFormatRejection(response.status, detail)) {
      logger.warn(
        `[ElevenLabs] pcm_48000 rejected (${response.status} ${text_}); using pcm_24000 from now on`
      );
      outputFormat = 'pcm_24000';
      formatRetried = true;
      continue;
    }

    if (response.status === 401) {
      throw new TtsError('quota', `ElevenLabs 401: ${text_}`);
    }
    if (response.status === 429) {
      if (!rateRetried) {
        rateRetried = true;
        await sleep(RATE_RETRY_DELAY_MS);
        continue;
      }
      throw new TtsError('rate', `ElevenLabs 429: ${text_}`);
    }
    if (response.status === 422) {
      throw new TtsError('invalid', `ElevenLabs 422: ${text_}`);
    }
    throw new TtsError('http', `ElevenLabs ${response.status}: ${text_}`);
  }
}
