import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../src/utils/logger.js', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() }
}));

import { synthesize, resetElevenLabsState, TtsError } from '../../src/integrations/elevenlabs.js';
import { logger } from '../../src/utils/logger.js';

const ENV = {
  ELEVENLABS_API_KEY: 'el-key',
  ELEVENLABS_VOICE_ID: 'voice-1',
  DJ_LLM_BASE_URL: 'http://llm/v1',
  DJ_LLM_MODEL: 'm'
};
const saved = {};

function mono(samples) {
  const buf = Buffer.alloc(samples.length * 2);
  samples.forEach((s, i) => buf.writeInt16LE(s, i * 2));
  return buf;
}

function okPcm(buf) {
  return {
    ok: true,
    status: 200,
    arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.length)
  };
}

function error(status, detail) {
  return { ok: false, status, json: async () => ({ detail }) };
}

beforeEach(() => {
  for (const [k, v] of Object.entries(ENV)) {
    saved[k] = process.env[k];
    process.env[k] = v;
  }
  delete process.env.ELEVENLABS_MODEL_ID;
  resetElevenLabsState();
  globalThis.fetch = vi.fn();
  vi.clearAllMocks();
});

afterEach(() => {
  for (const k of Object.keys(ENV)) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  vi.useRealTimers();
});

describe('elevenlabs.synthesize (R3, contracts §5c)', () => {
  it('posts to the pcm_48000 endpoint with xi-api-key and { text, model_id }', async () => {
    fetch.mockResolvedValue(okPcm(mono([1, 2])));
    await synthesize('hello there');

    const [url, init] = fetch.mock.calls[0];
    expect(url).toBe('https://api.elevenlabs.io/v1/text-to-speech/voice-1?output_format=pcm_48000');
    expect(init.method).toBe('POST');
    expect(init.headers['xi-api-key']).toBe('el-key');
    expect(JSON.parse(init.body)).toEqual({ text: 'hello there', model_id: 'eleven_flash_v2_5' });
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it('returns mono as stereo by duplicating each sample', async () => {
    fetch.mockResolvedValue(okPcm(mono([100, -200, 300])));
    const out = await synthesize('x');
    expect(out.length).toBe(12);
    const frames = [];
    for (let i = 0; i < 3; i++) frames.push([out.readInt16LE(i * 4), out.readInt16LE(i * 4 + 2)]);
    expect(frames).toEqual([
      [100, 100],
      [-200, -200],
      [300, 300]
    ]);
  });

  it('accepts exactly 15 s and rejects a longer clip', async () => {
    fetch.mockResolvedValueOnce(okPcm(Buffer.alloc(48000 * 2 * 15)));
    await expect(synthesize('x')).resolves.toBeInstanceOf(Buffer);

    fetch.mockResolvedValueOnce(okPcm(Buffer.alloc(48000 * 2 * 15 + 2)));
    await expect(synthesize('x')).rejects.toMatchObject({ kind: 'too_long' });
  });

  it('on a format rejection retries once with pcm_24000 and 2x sample-doubles', async () => {
    fetch
      .mockResolvedValueOnce(
        error(403, { status: 'output_format_not_allowed', message: 'pcm_48000 requires Pro' })
      )
      .mockResolvedValueOnce(okPcm(mono([7, -8])));
    const out = await synthesize('x');

    expect(fetch).toHaveBeenCalledTimes(2);
    expect(fetch.mock.calls[1][0]).toMatch(/output_format=pcm_24000$/);
    expect(logger.warn).toHaveBeenCalledOnce();
    const samples = [];
    for (let i = 0; i < out.length; i += 2) samples.push(out.readInt16LE(i));
    expect(samples).toEqual([7, 7, 7, 7, -8, -8, -8, -8]);

    // The fallback sticks for the process lifetime.
    fetch.mockResolvedValueOnce(okPcm(mono([1])));
    await synthesize('y');
    expect(fetch.mock.calls[2][0]).toMatch(/output_format=pcm_24000$/);
  });

  it('applies the 15 s cap at 24 kHz after the fallback', async () => {
    fetch
      .mockResolvedValueOnce(error(422, { status: 'invalid_output_format' }))
      .mockResolvedValueOnce(okPcm(Buffer.alloc(24000 * 2 * 15 + 2)));
    await expect(synthesize('x')).rejects.toMatchObject({ kind: 'too_long' });
  });

  it('401 quota_exceeded surfaces a quota error without retry', async () => {
    fetch.mockResolvedValue(error(401, { status: 'quota_exceeded', message: 'quota' }));
    const err = await synthesize('x').catch((e) => e);
    expect(err).toBeInstanceOf(TtsError);
    expect(err.kind).toBe('quota');
    expect(fetch).toHaveBeenCalledOnce();
  });

  it('a bad key (401) is also a quota error', async () => {
    fetch.mockResolvedValue(error(401, { status: 'invalid_api_key' }));
    await expect(synthesize('x')).rejects.toMatchObject({ kind: 'quota' });
  });

  it('429 retries once after 1 s, then fails', async () => {
    vi.useFakeTimers();
    fetch.mockResolvedValue(error(429, { status: 'rate_limit_exceeded' }));
    const result = synthesize('x').catch((e) => e);

    await vi.advanceTimersByTimeAsync(999);
    expect(fetch).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    const err = await result;
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(err.kind).toBe('rate');
  });

  it('429 then success returns the clip', async () => {
    vi.useFakeTimers();
    fetch
      .mockResolvedValueOnce(error(429, { status: 'concurrent_limit_exceeded' }))
      .mockResolvedValueOnce(okPcm(mono([5])));
    const result = synthesize('x');
    await vi.advanceTimersByTimeAsync(1000);
    expect((await result).length).toBe(4);
  });

  it('422 fails without retry', async () => {
    fetch.mockResolvedValue(error(422, { status: 'invalid_text' }));
    await expect(synthesize('x')).rejects.toMatchObject({ kind: 'invalid' });
    expect(fetch).toHaveBeenCalledOnce();
  });

  it('a network failure is a TtsError', async () => {
    fetch.mockRejectedValue(new Error('ECONNRESET'));
    await expect(synthesize('x')).rejects.toMatchObject({ kind: 'network' });
  });
});
