import { getDjConfig } from '../config/env.js';
import { logger } from '../utils/logger.js';

const API_BASE = 'https://api.elevenlabs.io/v1/text-to-speech';
const REQUEST_TIMEOUT_MS = 8000;
const RATE_RETRY_DELAY_MS = 1000;
const MAX_CLIP_SECONDS = 15;

// pcm_48000 may be gated behind a paid plan (R3). After the first format
// rejection the process switches to pcm_24000 for good and upsamples by 2×.
let useFallbackFormat = false;

/**
 * A TTS failure with a `kind` the DJ's breaker can act on:
 * - `quota`: out of credits or bad key; no retry, opens the breaker long
 * - `rate`: still rate limited after one retry
 * - `invalid`: the request or the returned clip was rejected
 * - `network`: timeout, connection error or an unexpected status
 */
export class TtsError extends Error {
  constructor(kind, message) {
    super(message);
    this.name = 'TtsError';
    this.kind = kind;
  }
}

async function readDetailStatus(response) {
  try {
    const body = await response.json();
    return body?.detail?.status ?? null;
  } catch {
    return null;
  }
}

function isFormatRejection(status, detailStatus) {
  if (status !== 400 && status !== 403) return false;
  return typeof detailStatus === 'string' && /format/i.test(detailStatus);
}

// Repeat every 16-bit sample `times` times. Mono→stereo is times = 2; a 24 kHz
// mono clip to 48 kHz stereo is times = 4.
function repeatSamples(mono, times) {
  const samples = Math.floor(mono.length / 2);
  const out = Buffer.allocUnsafe(samples * 2 * times);
  for (let i = 0; i < samples; i++) {
    const value = mono.readInt16LE(i * 2);
    for (let j = 0; j < times; j++) {
      out.writeInt16LE(value, (i * times + j) * 2);
    }
  }
  return out;
}

async function request(text, format) {
  const { elevenlabs } = getDjConfig();
  const url = `${API_BASE}/${encodeURIComponent(elevenlabs.voiceId)}?output_format=${format}`;
  try {
    return await fetch(url, {
      method: 'POST',
      headers: { 'xi-api-key': elevenlabs.apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, model_id: elevenlabs.modelId }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
    });
  } catch (error) {
    throw new TtsError('network', `ElevenLabs request failed: ${error.message}`);
  }
}

/**
 * Synthesize one DJ line.
 * @param {string} text
 * @returns {Promise<Buffer>} 48 kHz s16le stereo PCM, at most 15 s long
 * @throws {TtsError}
 */
export async function synthesize(text) {
  let format = useFallbackFormat ? 'pcm_24000' : 'pcm_48000';
  let rateRetried = false;
  let formatRetried = false;

  for (;;) {
    const response = await request(text, format);

    if (response.ok) {
      const mono = Buffer.from(await response.arrayBuffer());
      const sampleRate = format === 'pcm_24000' ? 24_000 : 48_000;
      if (mono.length / (sampleRate * 2) > MAX_CLIP_SECONDS) {
        throw new TtsError('invalid', `TTS clip is longer than ${MAX_CLIP_SECONDS} s`);
      }
      return repeatSamples(mono, sampleRate === 24_000 ? 4 : 2);
    }

    const detailStatus = await readDetailStatus(response);

    if (
      !formatRetried &&
      format === 'pcm_48000' &&
      isFormatRejection(response.status, detailStatus)
    ) {
      logger.warn(
        `[DJ] ElevenLabs rejected pcm_48000 (${detailStatus}); using pcm_24000 with 2× upsampling`
      );
      useFallbackFormat = true;
      format = 'pcm_24000';
      formatRetried = true;
      continue;
    }

    if (response.status === 401) {
      throw new TtsError('quota', `ElevenLabs refused the request (${detailStatus ?? '401'})`);
    }

    if (response.status === 429) {
      if (!rateRetried) {
        rateRetried = true;
        await new Promise((resolve) => setTimeout(resolve, RATE_RETRY_DELAY_MS));
        continue;
      }
      throw new TtsError('rate', `ElevenLabs rate limited (${detailStatus ?? '429'})`);
    }

    if (response.status === 422) {
      throw new TtsError('invalid', 'ElevenLabs rejected the text (422)');
    }

    throw new TtsError('network', `ElevenLabs request failed with HTTP ${response.status}`);
  }
}
