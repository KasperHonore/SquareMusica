import { getDjConfig } from '../config/env.js';
import { logger } from '../utils/logger.js';

// Text-to-speech for DJ lines (research R3). Plain fetch, no SDK. The whole clip
// is buffered: lines are prepared during the previous track, and a known length
// lets the 15 s cap (FR-002) be checked exactly.
const API_BASE = 'https://api.elevenlabs.io/v1/text-to-speech';
const TIMEOUT_MS = 8000;
const MAX_SECONDS = 15;
const RATE_RETRY_DELAY_MS = 1000;

// pcm_48000 may be plan-gated. On the first format rejection we fall back to
// pcm_24000 with 2x upsampling for the rest of the process lifetime.
let outputFormat = 'pcm_48000';

/** Error thrown by synthesize(); `kind` drives the DJ circuit breaker. */
export class TtsError extends Error {
  /**
   * @param {'quota'|'rate'|'invalid'|'too_long'|'network'|'http'} kind
   * @param {string} message
   */
  constructor(kind, message) {
    super(message);
    this.name = 'TtsError';
    this.kind = kind;
  }
}

/** Test hook: restore the initial output format. */
export function resetElevenLabsState() {
  outputFormat = 'pcm_48000';
}

function sampleRateOf(format) {
  return format === 'pcm_24000' ? 24000 : 48000;
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
    throw new TtsError('network', `ElevenLabs request failed: ${error.message}`);
  }
}

async function readDetail(response) {
  try {
    const body = await response.json();
    return body?.detail ?? body ?? null;
  } catch {
    return null;
  }
}

function isFormatRejection(status, detail) {
  if (status !== 400 && status !== 403 && status !== 422) return false;
  const text = JSON.stringify(detail ?? '').toLowerCase();
  return text.includes('output_format') || text.includes('pcm_48000');
}

/**
 * Convert mono s16le to stereo, optionally repeating each sample `factor` times
 * in time (sample-doubling upsample for the pcm_24000 fallback).
 * @param {Buffer} mono
 * @param {number} factor - 1 for 48 kHz input, 2 for 24 kHz
 * @returns {Buffer} 48 kHz s16le stereo
 */
export function monoToStereo48k(mono, factor = 1) {
  const samples = Math.floor(mono.length / 2);
  const out = Buffer.alloc(samples * factor * 4);
  let offset = 0;
  for (let i = 0; i < samples; i++) {
    const sample = mono.readInt16LE(i * 2);
    for (let r = 0; r < factor; r++) {
      out.writeInt16LE(sample, offset);
      out.writeInt16LE(sample, offset + 2);
      offset += 4;
    }
  }
  return out;
}

/**
 * Synthesize a DJ line.
 * @param {string} text
 * @returns {Promise<Buffer>} 48 kHz s16le stereo PCM
 * @throws {TtsError}
 */
export async function synthesize(text) {
  let rateRetried = false;

  for (;;) {
    const format = outputFormat;
    const response = await request(text, format);

    if (response.ok) {
      const mono = Buffer.from(await response.arrayBuffer());
      const rate = sampleRateOf(format);
      if (mono.length / (rate * 2) > MAX_SECONDS) {
        throw new TtsError('too_long', `TTS clip exceeds ${MAX_SECONDS} s`);
      }
      return monoToStereo48k(mono, 48000 / rate);
    }

    const detail = await readDetail(response);

    if (format === 'pcm_48000' && isFormatRejection(response.status, detail)) {
      logger.warn('[DJ] ElevenLabs rejected pcm_48000; falling back to pcm_24000 with 2x upsample');
      outputFormat = 'pcm_24000';
      continue;
    }

    if (response.status === 401) {
      const status = detail?.status ?? 'unauthorized';
      throw new TtsError('quota', `ElevenLabs 401 (${status})`);
    }

    if (response.status === 429) {
      if (!rateRetried) {
        rateRetried = true;
        await new Promise((resolve) => setTimeout(resolve, RATE_RETRY_DELAY_MS));
        continue;
      }
      throw new TtsError('rate', 'ElevenLabs rate limited (429)');
    }

    if (response.status === 422) {
      throw new TtsError('invalid', 'ElevenLabs rejected the request (422)');
    }

    throw new TtsError('http', `ElevenLabs HTTP ${response.status}`);
  }
}
