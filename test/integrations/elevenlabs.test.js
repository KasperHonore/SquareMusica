import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../src/utils/logger.js', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() }
}));

const ENV = {
  ELEVENLABS_API_KEY: 'el-key',
  ELEVENLABS_VOICE_ID: 'voice-1',
  DJ_LLM_BASE_URL: 'http://llm.local/v1',
  DJ_LLM_MODEL: 'model-x'
};

/** Mono s16le PCM with sample values 1..n. */
function monoPcm(samples) {
  const buf = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i++) buf.writeInt16LE(i + 1, i * 2);
  return buf;
}

function okResponse(buf) {
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

beforeEach(async () => {
  // Fresh module per test: the pcm_24000 fallback is sticky for the process.
  vi.resetModules();
  Object.assign(process.env, ENV);
  delete process.env.ELEVENLABS_MODEL_ID;
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
  ({ synthesize } = await import('../../src/integrations/elevenlabs.js'));
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  for (const name of Object.keys(ENV)) delete process.env[name];
});

describe('elevenlabs.synthesize (R3, contracts §5c)', () => {
  it('POSTs text and model_id to the pcm_48000 endpoint with xi-api-key', async () => {
    fetchMock.mockResolvedValue(okResponse(monoPcm(4)));

    await synthesize('Hello there');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://api.elevenlabs.io/v1/text-to-speech/voice-1?output_format=pcm_48000');
    expect(init.method).toBe('POST');
    expect(init.headers['xi-api-key']).toBe('el-key');
    expect(JSON.parse(init.body)).toMatchObject({
      text: 'Hello there',
      model_id: 'eleven_flash_v2_5'
    });
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it('uses ELEVENLABS_MODEL_ID when set', async () => {
    process.env.ELEVENLABS_MODEL_ID = 'eleven_turbo_v2_5';
    fetchMock.mockResolvedValue(okResponse(monoPcm(2)));
    await synthesize('x');
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).model_id).toBe('eleven_turbo_v2_5');
  });

  it('returns mono as stereo by duplicating each sample', async () => {
    fetchMock.mockResolvedValue(okResponse(monoPcm(3)));

    const out = await synthesize('x');

    expect(out.length).toBe(3 * 4);
    const samples = [];
    for (let i = 0; i < out.length; i += 2) samples.push(out.readInt16LE(i));
    expect(samples).toEqual([1, 1, 2, 2, 3, 3]);
  });

  it('rejects a clip longer than 15 s', async () => {
    fetchMock.mockResolvedValue(okResponse(Buffer.alloc(48000 * 2 * 15 + 2)));
    await expect(synthesize('long')).rejects.toMatchObject({ kind: 'too_long' });
  });

  it('accepts a clip of exactly 15 s', async () => {
    fetchMock.mockResolvedValue(okResponse(Buffer.alloc(48000 * 2 * 15)));
    const out = await synthesize('ok');
    expect(out.length).toBe(48000 * 4 * 15);
  });

  it('on a format rejection retries once with pcm_24000 and 2× upsamples, then sticks', async () => {
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse(400, { detail: { status: 'invalid_output_format', message: 'nope' } })
      )
      .mockResolvedValueOnce(okResponse(monoPcm(2)))
      .mockResolvedValueOnce(okResponse(monoPcm(1)));

    const out = await synthesize('x');

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[1][0]).toMatch(/output_format=pcm_24000$/);
    // 2 mono samples → 4 after doubling → 4 stereo frames.
    const samples = [];
    for (let i = 0; i < out.length; i += 2) samples.push(out.readInt16LE(i));
    expect(samples).toEqual([1, 1, 1, 1, 2, 2, 2, 2]);

    await synthesize('y');
    expect(fetchMock.mock.calls[2][0]).toMatch(/output_format=pcm_24000$/);
  });

  it('401 quota_exceeded surfaces a quota error kind without retry', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(401, { detail: { status: 'quota_exceeded', message: 'out' } })
    );
    await expect(synthesize('x')).rejects.toMatchObject({ kind: 'quota' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('401 for a bad key is also a quota error kind', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(401, { detail: { status: 'invalid_api_key', message: 'bad' } })
    );
    await expect(synthesize('x')).rejects.toMatchObject({ kind: 'quota' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('429 retries once after 1 s, then fails with a rate error kind', async () => {
    vi.useFakeTimers();
    fetchMock.mockImplementation(async () =>
      jsonResponse(429, { detail: { status: 'rate_limit_exceeded' } })
    );

    const promise = synthesize('x');
    const settled = expect(promise).rejects.toMatchObject({ kind: 'rate' });
    await vi.advanceTimersByTimeAsync(999);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    await settled;
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('429 then success returns the audio', async () => {
    vi.useFakeTimers();
    fetchMock
      .mockResolvedValueOnce(jsonResponse(429, { detail: { status: 'concurrent_limit_exceeded' } }))
      .mockResolvedValueOnce(okResponse(monoPcm(1)));
    const promise = synthesize('x');
    await vi.advanceTimersByTimeAsync(1000);
    expect((await promise).length).toBe(4);
  });

  it('422 fails with an invalid error kind and no retry', async () => {
    fetchMock.mockResolvedValue(jsonResponse(422, { detail: [{ msg: 'bad' }] }));
    await expect(synthesize('x')).rejects.toMatchObject({ kind: 'invalid' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('a network error or timeout rejects', async () => {
    fetchMock.mockRejectedValue(new DOMException('timed out', 'TimeoutError'));
    await expect(synthesize('x')).rejects.toBeTruthy();
  });
});
