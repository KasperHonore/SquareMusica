import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../src/utils/logger.js', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() }
}));

const DJ_ENV = {
  ELEVENLABS_API_KEY: 'xi-key',
  ELEVENLABS_VOICE_ID: 'voice-1',
  DJ_LLM_BASE_URL: 'http://litellm:4000/v1',
  DJ_LLM_MODEL: 'm'
};
const saved = { ...process.env };

function monoPcm(samples) {
  const buf = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i++) buf.writeInt16LE(i + 1, i * 2);
  return buf;
}

function pcmResponse(buf) {
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.length);
  return new Response(ab, { status: 200, headers: { 'content-type': 'audio/pcm' } });
}

function jsonResponse(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' }
  });
}

let synthesize;
let logger;
let fetchMock;

beforeEach(async () => {
  Object.assign(process.env, DJ_ENV);
  delete process.env.ELEVENLABS_MODEL_ID;
  // The pcm_24000 fallback is process-lifetime state, so each test gets a fresh module.
  vi.resetModules();
  ({ synthesize } = await import('../../src/integrations/elevenlabs.js'));
  ({ logger } = await import('../../src/utils/logger.js'));
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  for (const name of [...Object.keys(DJ_ENV), 'ELEVENLABS_MODEL_ID']) {
    if (saved[name] === undefined) delete process.env[name];
    else process.env[name] = saved[name];
  }
});

describe('elevenlabs.synthesize (R3, contracts §5c)', () => {
  it('posts the text to the voice endpoint with pcm_48000 and the API key', async () => {
    fetchMock.mockResolvedValue(pcmResponse(monoPcm(4)));

    await synthesize('Hello there.');

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://api.elevenlabs.io/v1/text-to-speech/voice-1?output_format=pcm_48000');
    expect(init.method).toBe('POST');
    expect(init.headers['xi-api-key']).toBe('xi-key');
    expect(JSON.parse(init.body)).toEqual({ text: 'Hello there.', model_id: 'eleven_flash_v2_5' });
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it('uses ELEVENLABS_MODEL_ID when set', async () => {
    process.env.ELEVENLABS_MODEL_ID = 'eleven_turbo_v2_5';
    fetchMock.mockResolvedValue(pcmResponse(monoPcm(4)));
    await synthesize('Hi.');
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).model_id).toBe('eleven_turbo_v2_5');
  });

  it('returns the mono response as stereo by duplicating each sample', async () => {
    fetchMock.mockResolvedValue(pcmResponse(monoPcm(3)));

    const out = await synthesize('Hi.');

    expect(out.length).toBe(3 * 4);
    const samples = [];
    for (let i = 0; i < out.length; i += 2) samples.push(out.readInt16LE(i));
    expect(samples).toEqual([1, 1, 2, 2, 3, 3]);
  });

  it('accepts a clip of exactly 15 s', async () => {
    fetchMock.mockResolvedValue(pcmResponse(Buffer.alloc(48000 * 2 * 15)));
    const out = await synthesize('Hi.');
    expect(out.length).toBe(48000 * 4 * 15);
  });

  it('rejects a clip longer than 15 s', async () => {
    fetchMock.mockResolvedValue(pcmResponse(Buffer.alloc(48000 * 2 * 15 + 2)));
    await expect(synthesize('Hi.')).rejects.toMatchObject({ kind: 'too_long' });
  });

  it('on a format rejection retries once with pcm_24000 and upsamples 2× by sample doubling', async () => {
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse(403, {
          detail: {
            status: 'output_format_not_allowed',
            message: 'output_format pcm_48000 requires a higher tier'
          }
        })
      )
      .mockResolvedValueOnce(pcmResponse(monoPcm(2)));

    const out = await synthesize('Hi.');

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[1][0]).toMatch(/output_format=pcm_24000$/);
    const samples = [];
    for (let i = 0; i < out.length; i += 2) samples.push(out.readInt16LE(i));
    // Each 24 kHz mono sample → two 48 kHz frames → four stereo samples.
    expect(samples).toEqual([1, 1, 1, 1, 2, 2, 2, 2]);
    expect(logger.warn).toHaveBeenCalledTimes(1);

    // The fallback sticks for the process lifetime.
    fetchMock.mockResolvedValueOnce(pcmResponse(monoPcm(1)));
    await synthesize('Again.');
    expect(fetchMock.mock.calls[2][0]).toMatch(/output_format=pcm_24000$/);
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });

  it('applies the 15 s cap at 24 kHz after the fallback', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(400, { detail: { message: 'Invalid output_format' } }))
      .mockResolvedValueOnce(pcmResponse(Buffer.alloc(24000 * 2 * 15 + 2)));
    await expect(synthesize('Hi.')).rejects.toMatchObject({ kind: 'too_long' });
  });

  it('401 quota_exceeded surfaces a quota error without retry', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(401, { detail: { status: 'quota_exceeded', message: 'quota' } })
    );
    await expect(synthesize('Hi.')).rejects.toMatchObject({ kind: 'quota' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('401 with a bad key also surfaces a quota error', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(401, { detail: { status: 'invalid_api_key', message: 'bad key' } })
    );
    await expect(synthesize('Hi.')).rejects.toMatchObject({ kind: 'quota' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('429 retries once after 1 s, then fails with a rate error', async () => {
    vi.useFakeTimers();
    fetchMock.mockImplementation(async () =>
      jsonResponse(429, { detail: { status: 'rate_limit_exceeded' } })
    );

    const result = synthesize('Hi.').catch((e) => e);
    await vi.advanceTimersByTimeAsync(999);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    const error = await result;

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(error).toMatchObject({ kind: 'rate' });
  });

  it('429 followed by success returns the clip', async () => {
    vi.useFakeTimers();
    fetchMock
      .mockResolvedValueOnce(jsonResponse(429, { detail: { status: 'concurrent_limit_exceeded' } }))
      .mockResolvedValueOnce(pcmResponse(monoPcm(1)));

    const result = synthesize('Hi.');
    await vi.advanceTimersByTimeAsync(1000);
    expect((await result).length).toBe(4);
  });

  it('422 fails with an invalid error and no retry', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(422, { detail: [{ msg: 'text too long', loc: ['body', 'text'] }] })
    );
    await expect(synthesize('Hi.')).rejects.toMatchObject({ kind: 'invalid' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('a network failure or timeout surfaces as an error', async () => {
    fetchMock.mockRejectedValue(new DOMException('The operation timed out.', 'TimeoutError'));
    await expect(synthesize('Hi.')).rejects.toBeInstanceOf(Error);
  });
});
