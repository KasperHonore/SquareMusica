import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { chatJson } from '../../src/integrations/llm.js';

const ENV = {
  ELEVENLABS_API_KEY: 'xi-key',
  ELEVENLABS_VOICE_ID: 'voice-1',
  DJ_LLM_BASE_URL: 'http://litellm:4000/v1',
  DJ_LLM_MODEL: 'gpt-dj',
  DJ_LLM_API_KEY: undefined
};

function completion(content, status = 200) {
  return new Response(JSON.stringify({ choices: [{ message: { content } }] }), {
    status,
    headers: { 'content-type': 'application/json' }
  });
}

let fetchMock;
const saved = {};

beforeEach(() => {
  for (const [k, v] of Object.entries(ENV)) {
    saved[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

const args = { system: 'sys', user: { a: 1 }, temperature: 0.9, timeoutMs: 10_000 };

describe('llm.chatJson (R4)', () => {
  it('posts to /chat/completions with json_object and parses the content', async () => {
    fetchMock.mockResolvedValue(completion('{"line":"hi","factIds":[]}'));
    const result = await chatJson(args);
    expect(result).toEqual({ line: 'hi', factIds: [] });

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('http://litellm:4000/v1/chat/completions');
    expect(init.method).toBe('POST');
    const body = JSON.parse(init.body);
    expect(body.model).toBe('gpt-dj');
    expect(body.response_format).toEqual({ type: 'json_object' });
    expect(body.temperature).toBe(0.9);
    expect(body.messages).toEqual([
      { role: 'system', content: 'sys' },
      { role: 'user', content: JSON.stringify({ a: 1 }) }
    ]);
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it('tolerates a trailing slash on the base URL', async () => {
    process.env.DJ_LLM_BASE_URL = 'http://litellm:4000/v1/';
    fetchMock.mockResolvedValue(completion('{}'));
    await chatJson(args);
    expect(fetchMock.mock.calls[0][0]).toBe('http://litellm:4000/v1/chat/completions');
  });

  it('omits Authorization when DJ_LLM_API_KEY is unset', async () => {
    fetchMock.mockResolvedValue(completion('{}'));
    await chatJson(args);
    const headers = fetchMock.mock.calls[0][1].headers;
    expect(Object.keys(headers).map((h) => h.toLowerCase())).not.toContain('authorization');
  });

  it('sends Authorization: Bearer when DJ_LLM_API_KEY is set', async () => {
    process.env.DJ_LLM_API_KEY = 'sk-123';
    fetchMock.mockResolvedValue(completion('{}'));
    await chatJson(args);
    expect(fetchMock.mock.calls[0][1].headers.Authorization).toBe('Bearer sk-123');
  });

  it('throws on malformed JSON content', async () => {
    fetchMock.mockResolvedValue(completion('not json {'));
    await expect(chatJson(args)).rejects.toThrow();
  });

  it('throws on a missing choices array', async () => {
    fetchMock.mockResolvedValue(new Response('{}', { status: 200 }));
    await expect(chatJson(args)).rejects.toThrow();
  });

  it('throws on non-2xx without retrying', async () => {
    fetchMock.mockResolvedValue(completion('{}', 500));
    await expect(chatJson(args)).rejects.toThrow(/500/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('throws on timeout', async () => {
    fetchMock.mockImplementation(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          init.signal.addEventListener('abort', () => reject(init.signal.reason));
        })
    );
    await expect(chatJson({ ...args, timeoutMs: 20 })).rejects.toThrow();
  });
});
