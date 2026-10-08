import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../src/utils/logger.js', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() }
}));

import { chatJson } from '../../src/integrations/llm.js';

const ENV = {
  ELEVENLABS_API_KEY: 'el-key',
  ELEVENLABS_VOICE_ID: 'voice-1',
  DJ_LLM_BASE_URL: 'http://llm.local/v1',
  DJ_LLM_MODEL: 'model-x'
};

function completion(content, status = 200) {
  return new Response(JSON.stringify({ choices: [{ message: { content } }] }), {
    status,
    headers: { 'content-type': 'application/json' }
  });
}

let fetchMock;

beforeEach(() => {
  Object.assign(process.env, ENV);
  delete process.env.DJ_LLM_API_KEY;
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  for (const name of [...Object.keys(ENV), 'DJ_LLM_API_KEY']) delete process.env[name];
});

describe('llm.chatJson (R4)', () => {
  it('posts a json_object chat completion and parses the content', async () => {
    fetchMock.mockResolvedValue(completion('{"line":"hi"}'));

    const result = await chatJson({
      system: 'sys',
      user: 'usr',
      temperature: 0.9,
      timeoutMs: 10000
    });

    expect(result).toEqual({ line: 'hi' });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('http://llm.local/v1/chat/completions');
    expect(init.method).toBe('POST');
    expect(init.signal).toBeInstanceOf(AbortSignal);
    const body = JSON.parse(init.body);
    expect(body).toMatchObject({
      model: 'model-x',
      temperature: 0.9,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: 'sys' },
        { role: 'user', content: 'usr' }
      ]
    });
  });

  it('tolerates a trailing slash on the base URL', async () => {
    process.env.DJ_LLM_BASE_URL = 'http://llm.local/v1/';
    fetchMock.mockResolvedValue(completion('{}'));
    await chatJson({ system: 's', user: 'u', timeoutMs: 1000 });
    expect(fetchMock.mock.calls[0][0]).toBe('http://llm.local/v1/chat/completions');
  });

  it('omits Authorization when DJ_LLM_API_KEY is unset', async () => {
    fetchMock.mockResolvedValue(completion('{}'));
    await chatJson({ system: 's', user: 'u', timeoutMs: 1000 });
    expect(fetchMock.mock.calls[0][1].headers.Authorization).toBeUndefined();
  });

  it('sends a Bearer key when DJ_LLM_API_KEY is set', async () => {
    process.env.DJ_LLM_API_KEY = 'sk-test';
    fetchMock.mockResolvedValue(completion('{}'));
    await chatJson({ system: 's', user: 'u', timeoutMs: 1000 });
    expect(fetchMock.mock.calls[0][1].headers.Authorization).toBe('Bearer sk-test');
  });

  it('throws on malformed JSON content', async () => {
    fetchMock.mockResolvedValue(completion('not json'));
    await expect(chatJson({ system: 's', user: 'u', timeoutMs: 1000 })).rejects.toThrow();
  });

  it('throws on a missing choices array', async () => {
    fetchMock.mockResolvedValue(new Response('{}', { status: 200 }));
    await expect(chatJson({ system: 's', user: 'u', timeoutMs: 1000 })).rejects.toThrow();
  });

  it('throws on a non-2xx response without retrying', async () => {
    fetchMock.mockResolvedValue(completion('{}', 500));
    await expect(chatJson({ system: 's', user: 'u', timeoutMs: 1000 })).rejects.toThrow(/500/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('throws on timeout', async () => {
    fetchMock.mockImplementation(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          init.signal.addEventListener('abort', () => reject(init.signal.reason));
        })
    );
    await expect(chatJson({ system: 's', user: 'u', timeoutMs: 20 })).rejects.toThrow();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
