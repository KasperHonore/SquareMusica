import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../src/utils/logger.js', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() }
}));

import { synthesize, _resetForTests } from '../../src/integrations/elevenlabs.js';
import { logger } from '../../src/utils/logger.js';

const ENV = {
  ELEVENLABS_API_KEY: 'xi-key',
  ELEVENLABS_VOICE_ID: 'voice-1',
  DJ_LLM_BASE_URL: 'http://llm:4000',
  DJ_LLM_MODEL: 'm'
};

/** Mono s16le PCM with the given sample values. */
function mono(samples) {
  const buf = Buffer.alloc(samples.length * 2);
  samples.forEach((s, i) => buf.writeInt16LE(s, i * 2));
  return buf;
}

function samplesOf(buf) {
  const out = [];
  for (let i = 0; i < buf.length; i += 2) out.push(buf.readInt16LE(i));
  return out;
}

function okResponse(body) {
  return {
    ok: true,
    status: 200,
    arrayBuffer: async () => body.buffer.slice(body.byteOffset, body.byteOffset + body.length)
  };
}

function errorResponse(status, detail) {
  const text = JSON.stringify({ detail });
  return {
    ok: false,
    status,
    text: async () => text,
    json: async () => JSON.parse(text)
  };
}

let fetchMock;
const saved = {};

beforeEach(() => {
  for (const [k, v] of Object.entries(ENV)) {
    saved[k] = process.env[k];
    process.env[k] = v;
  }
  saved.ELEVENLABS_MODEL_ID = process.env.ELEVENLABS_MODEL_ID;
  delete process.env.ELEVENLABS_MODEL_ID;
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
  _resetForTests();
  vi.clearAllMocks();
});

afterEach(() => {
  for (const k of [...Object.keys(ENV), 'ELEVENLABS_MODEL_ID']) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('elevenlabs.synthesize (R3, contracts §5c)', () => {
  it('posts to the pcm_48000 endpoint with the key header and { text, model_id }', async () => {
    fetchMock.mockResolvedValue(okResponse(mono([1, 2])));
    await synthesize('Hello there');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://api.elevenlabs.io/v1/text-to-speech/voice-1?output_format=pcm_48000');
    expect(init.method).toBe('POST');
    expect(init.headers['xi-api-key']).toBe('xi-key');
    expect(init.headers['Content-Type']).toBe('application/json');
    expect(JSON.parse(init.body)).toEqual({ text: 'Hello there', model_id: 'eleven_flash_v2_5' });
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it('uses ELEVENLABS_MODEL_ID when set', async () => {
    process.env.ELEVENLABS_MODEL_ID = 'eleven_turbo_v2_5';
    fetchMock.mockResolvedValue(okResponse(mono([1])));
    await synthesize('hi');
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).model_id).toBe('eleven_turbo_v2_5');
  });

  it('returns mono as stereo with each sample duplicated', async () => {
    fetchMock.mockResolvedValue(okResponse(mono([100, -200, 300])));
    const out = await synthesize('hi');
    expect(Buffer.isBuffer(out)).toBe(true);
    expect(samplesOf(out)).toEqual([100, 100, -200, -200, 300, 300]);
  });

  it('rejects a clip longer than 15 s', async () => {
    const tooLong = Buffer.alloc(48000 * 2 * 15 + 2);
    fetchMock.mockResolvedValue(okResponse(tooLong));
    await expect(synthesize('long')).rejects.toMatchObject({ kind: 'too_long' });
  });

  it('accepts a clip of exactly 15 s', async () => {
    fetchMock.mockResolvedValue(okResponse(Buffer.alloc(48000 * 2 * 15)));
    const out = await synthesize('ok');
    expect(out.length).toBe(48000 * 4 * 15);
  });

  it('on a format rejection retries once with pcm_24000 and 2× sample-doubling', async () => {
    fetchMock
      .mockResolvedValueOnce(
        errorResponse(403, {
          status: 'output_format_not_allowed',
          message: 'output_format pcm_48000 requires a higher tier'
        })
      )
      .mockResolvedValueOnce(okResponse(mono([10, -20])));

    const out = await synthesize('hi');

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[1][0]).toBe(
      'https://api.elevenlabs.io/v1/text-to-speech/voice-1?output_format=pcm_24000'
    );
    // Each 24 kHz mono sample → 2 frames at 48 kHz, each frame L+R.
    expect(samplesOf(out)).toEqual([10, 10, 10, 10, -20, -20, -20, -20]);
    expect(logger.warn).toHaveBeenCalledTimes(1);

    // The fallback sticks for the process lifetime.
    fetchMock.mockResolvedValueOnce(okResponse(mono([1])));
    await synthesize('again');
    expect(fetchMock.mock.calls[2][0]).toContain('output_format=pcm_24000');
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });

  it('applies the 15 s cap at 24 kHz on the fallback format', async () => {
    fetchMock
      .mockResolvedValueOnce(errorResponse(400, { status: 'invalid_output_format' }))
      .mockResolvedValueOnce(okResponse(Buffer.alloc(24000 * 2 * 15 + 2)));
    await expect(synthesize('long')).rejects.toMatchObject({ kind: 'too_long' });
  });

  it('401 quota_exceeded surfaces a quota error without retry', async () => {
    fetchMock.mockResolvedValue(errorResponse(401, { status: 'quota_exceeded' }));
    await expect(synthesize('hi')).rejects.toMatchObject({ kind: 'quota' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('401 bad key also surfaces quota without retry', async () => {
    fetchMock.mockResolvedValue(errorResponse(401, { status: 'invalid_api_key' }));
    await expect(synthesize('hi')).rejects.toMatchObject({ kind: 'quota' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('429 retries once after 1 s then succeeds', async () => {
    vi.useFakeTimers();
    fetchMock
      .mockResolvedValueOnce(errorResponse(429, { status: 'rate_limit_exceeded' }))
      .mockResolvedValueOnce(okResponse(mono([5])));
    const p = synthesize('hi');
    await vi.advanceTimersByTimeAsync(999);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(samplesOf(await p)).toEqual([5, 5]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('429 twice fails with a rate error', async () => {
    vi.useFakeTimers();
    fetchMock.mockResolvedValue(errorResponse(429, { status: 'concurrent_limit_exceeded' }));
    const p = synthesize('hi');
    const assertion = expect(p).rejects.toMatchObject({ kind: 'rate' });
    await vi.advanceTimersByTimeAsync(1000);
    await assertion;
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('422 fails with an invalid error and no retry', async () => {
    fetchMock.mockResolvedValue(errorResponse(422, [{ msg: 'bad text' }]));
    await expect(synthesize('hi')).rejects.toMatchObject({ kind: 'invalid' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('a network failure or timeout rejects', async () => {
    fetchMock.mockRejectedValue(Object.assign(new Error('timed out'), { name: 'TimeoutError' }));
    await expect(synthesize('hi')).rejects.toMatchObject({ kind: 'timeout' });
  });
});
