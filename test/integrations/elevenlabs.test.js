import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../src/utils/logger.js', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() }
}));

const ENV = {
  ELEVENLABS_API_KEY: 'xi-key',
  ELEVENLABS_VOICE_ID: 'voice-1',
  DJ_LLM_BASE_URL: 'http://litellm:4000/v1',
  DJ_LLM_MODEL: 'm'
};

// Mono s16le PCM with the given samples.
function mono(samples) {
  const buf = Buffer.alloc(samples.length * 2);
  samples.forEach((s, i) => buf.writeInt16LE(s, i * 2));
  return buf;
}

function pcmResponse(buf) {
  return new Response(buf, { status: 200, headers: { 'content-type': 'audio/pcm' } });
}

function jsonResponse(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' }
  });
}

let synthesize;
let fetchMock;
const saved = {};

beforeEach(async () => {
  for (const [k, v] of Object.entries(ENV)) {
    saved[k] = process.env[k];
    process.env[k] = v;
  }
  saved.ELEVENLABS_MODEL_ID = process.env.ELEVENLABS_MODEL_ID;
  delete process.env.ELEVENLABS_MODEL_ID;
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
  // Fresh module per test: the pcm_24000 fallback is sticky for the process.
  vi.resetModules();
  ({ synthesize } = await import('../../src/integrations/elevenlabs.js'));
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

describe('elevenlabs.synthesize (R3, contracts §5c)', () => {
  it('POSTs to the pcm_48000 endpoint with xi-api-key and { text, model_id }', async () => {
    fetchMock.mockResolvedValue(pcmResponse(mono([1, 2])));
    await synthesize('Hello there');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://api.elevenlabs.io/v1/text-to-speech/voice-1?output_format=pcm_48000');
    expect(init.method).toBe('POST');
    expect(init.headers['xi-api-key']).toBe('xi-key');
    expect(init.headers['content-type'] ?? init.headers['Content-Type']).toBe('application/json');
    expect(JSON.parse(init.body)).toEqual({ text: 'Hello there', model_id: 'eleven_flash_v2_5' });
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it('returns stereo by duplicating each mono sample', async () => {
    fetchMock.mockResolvedValue(pcmResponse(mono([100, -200, 300])));
    const out = await synthesize('x');
    const samples = [];
    for (let i = 0; i < out.length; i += 2) samples.push(out.readInt16LE(i));
    expect(samples).toEqual([100, 100, -200, -200, 300, 300]);
  });

  it('rejects a clip longer than 15 s', async () => {
    const tooLong = Buffer.alloc(48_000 * 2 * 15 + 2);
    fetchMock.mockResolvedValue(pcmResponse(tooLong));
    await expect(synthesize('x')).rejects.toMatchObject({ kind: 'invalid' });
  });

  it('accepts a clip of exactly 15 s', async () => {
    fetchMock.mockResolvedValue(pcmResponse(Buffer.alloc(48_000 * 2 * 15)));
    const out = await synthesize('x');
    expect(out.length).toBe(48_000 * 4 * 15);
  });

  it('on a format rejection retries once with pcm_24000 and upsamples 2×, then stays on it', async () => {
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse(403, {
          detail: { status: 'output_format_not_allowed', message: 'pcm_48000 requires Pro' }
        })
      )
      .mockResolvedValueOnce(pcmResponse(mono([10, -20])))
      .mockResolvedValueOnce(pcmResponse(mono([5])));

    const out = await synthesize('x');
    expect(fetchMock.mock.calls[1][0]).toMatch(/output_format=pcm_24000$/);
    const samples = [];
    for (let i = 0; i < out.length; i += 2) samples.push(out.readInt16LE(i));
    // 2× upsample by doubling, then mono→stereo: each source sample appears 4 times.
    expect(samples).toEqual([10, 10, 10, 10, -20, -20, -20, -20]);

    await synthesize('y');
    expect(fetchMock.mock.calls[2][0]).toMatch(/output_format=pcm_24000$/);
  });

  it('a 24 kHz clip longer than 15 s is rejected', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(400, { detail: { status: 'invalid_output_format' } }))
      .mockResolvedValueOnce(pcmResponse(Buffer.alloc(24_000 * 2 * 15 + 2)));
    await expect(synthesize('x')).rejects.toMatchObject({ kind: 'invalid' });
  });

  it('401 quota_exceeded surfaces a quota error without retry', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(401, { detail: { status: 'quota_exceeded', message: 'quota' } })
    );
    await expect(synthesize('x')).rejects.toMatchObject({ kind: 'quota' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('401 with a bad key also surfaces quota (breaker opens long)', async () => {
    fetchMock.mockResolvedValue(jsonResponse(401, { detail: { status: 'invalid_api_key' } }));
    await expect(synthesize('x')).rejects.toMatchObject({ kind: 'quota' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('429 retries once after 1 s and then fails with a rate error', async () => {
    vi.useFakeTimers();
    fetchMock.mockImplementation(async () =>
      jsonResponse(429, { detail: { status: 'rate_limit_exceeded' } })
    );
    const promise = synthesize('x');
    const assertion = expect(promise).rejects.toMatchObject({ kind: 'rate' });
    await vi.advanceTimersByTimeAsync(999);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    await assertion;
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('429 then success returns the clip', async () => {
    vi.useFakeTimers();
    fetchMock
      .mockResolvedValueOnce(jsonResponse(429, { detail: { status: 'concurrent_limit_exceeded' } }))
      .mockResolvedValueOnce(pcmResponse(mono([7])));
    const promise = synthesize('x');
    await vi.advanceTimersByTimeAsync(1000);
    const out = await promise;
    expect(out.length).toBe(4);
  });

  it('422 fails with an invalid error and no retry', async () => {
    fetchMock.mockResolvedValue(jsonResponse(422, { detail: [{ msg: 'bad text' }] }));
    await expect(synthesize('x')).rejects.toMatchObject({ kind: 'invalid' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('a network error or timeout rejects', async () => {
    fetchMock.mockRejectedValue(new DOMException('timed out', 'TimeoutError'));
    await expect(synthesize('x')).rejects.toBeInstanceOf(Error);
  });
});
