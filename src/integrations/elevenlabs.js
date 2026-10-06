import { getDjConfig } from '../config/env.js';
import { logger } from '../utils/logger.js';

// Text-to-speech for the AI DJ (research R3, contracts §5c). Plain fetch, no SDK.
const API_BASE = 'https://api.elevenlabs.io/v1/text-to-speech';
const TIMEOUT_MS = 8000;
const RATE_RETRY_DELAY_MS = 1000;
const MAX_CLIP_SECONDS = 15;

// pcm_48000 matches Discord's rate. Some plan tiers may reject it; on the first
// rejection the client switches to pcm_24000 with 2× upsampling for the rest of
// the process lifetime.
let outputFormat = 'pcm_48000';

function sampleRate() {
  return outputFormat === 'pcm_48000' ? 48000 : 24000;
}

/**
 * Error from the TTS service. `kind` drives the DJ's circuit breaker (R9):
 * - `quota`: quota exceeded or bad key; not retried
 * - `rate`: rate limited, still failing after one retry
 * - `invalid`: request rejected (422); not retried
 * - `too_long`: the clip is over 15 s (FR-002)
 * - `http` / `network`: anything else
 */
export class TtsError extends Error {
  constructor(kind, message) {
    super(message);
    this.name = 'TtsError';
    this.kind = kind;
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

function isFormatRejection(status, detail) {
  if (status !== 400 && status !== 403) return false;
  const text = JSON.stringify(detail ?? '').toLowerCase();
  return text.includes('output_format') || text.includes('pcm_48000');
}

async function request(text, config) {
  const url = `${API_BASE}/${encodeURIComponent(config.voiceId)}?output_format=${outputFormat}`;
  try {
    return await fetch(url, {
      method: 'POST',
      headers: {
        'xi-api-key': config.apiKey,
        'Content-Type': 'application/json',
        Accept: 'audio/pcm'
      },
      body: JSON.stringify({ text, model_id: config.modelId }),
      signal: AbortSignal.timeout(TIMEOUT_MS)
    });
  } catch (error) {
    throw new TtsError('network', `ElevenLabs request failed: ${error.message}`);
  }
}

/**
 * Convert mono s16le to 48 kHz stereo s16le by sample duplication: each mono
 * sample becomes `repeat` stereo frames (1 at 48 kHz, 2 at 24 kHz).
 */
function toStereo48k(mono, repeat) {
  const samples = Math.floor(mono.length / 2);
  const out = Buffer.allocUnsafe(samples * 4 * repeat);
  let pos = 0;
  for (let i = 0; i < samples; i++) {
    const sample = mono.readInt16LE(i * 2);
    for (let r = 0; r < repeat; r++) {
      out.writeInt16LE(sample, pos);
      out.writeInt16LE(sample, pos + 2);
      pos += 4;
    }
  }
  return out;
}

/**
 * Speak `text` in the configured voice.
 * @param {string} text
 * @returns {Promise<Buffer>} 48 kHz s16le stereo PCM, at most 15 s long
 * @throws {TtsError}
 */
export async function synthesize(text) {
  const config = getDjConfig().elevenlabs;
  let rateRetried = false;
  let formatRetried = false;

  for (;;) {
    const response = await request(text, config);

    if (response.ok) {
      const mono = Buffer.from(await response.arrayBuffer());
      const rate = sampleRate();
      if (mono.length / (rate * 2) > MAX_CLIP_SECONDS) {
        throw new TtsError('too_long', `TTS clip longer than ${MAX_CLIP_SECONDS} s`);
      }
      return toStereo48k(mono, 48000 / rate);
    }

    const detail = await readDetail(response);
    const status = response.status;

    if (!formatRetried && outputFormat === 'pcm_48000' && isFormatRejection(status, detail)) {
      formatRetried = true;
      outputFormat = 'pcm_24000';
      logger.warn(
        '[DJ] ElevenLabs rejected pcm_48000; using pcm_24000 with 2x upsampling from now on'
      );
      continue;
    }

    if (status === 401) {
      throw new TtsError('quota', `ElevenLabs 401: ${detail?.status ?? 'unauthorized'}`);
    }
    if (status === 429) {
      if (!rateRetried) {
        rateRetried = true;
        await new Promise((resolve) => setTimeout(resolve, RATE_RETRY_DELAY_MS));
        continue;
      }
      throw new TtsError('rate', `ElevenLabs 429: ${detail?.status ?? 'rate limited'}`);
    }
    if (status === 422) {
      throw new TtsError('invalid', 'ElevenLabs 422: request rejected');
    }
    throw new TtsError('http', `ElevenLabs HTTP ${status}`);
  }
}
