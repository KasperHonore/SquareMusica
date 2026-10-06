import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { chatJson } from '../../src/integrations/llm.js';

const DJ_ENV = {
  ELEVENLABS_API_KEY: 'xi-key',
  ELEVENLABS_VOICE_ID: 'voice-1',
  DJ_LLM_BASE_URL: 'http://litellm:4000/v1',
  DJ_LLM_MODEL: 'gpt-dj'
};
const saved = { ...process.env };

function completion(content, status = 200) {
  return new Response(JSON.stringify({ choices: [{ message: { content } }] }), {
    status,
    headers: { 'content-type': 'application/json' }
  });
}

let fetchMock;

beforeEach(() => {
  Object.assign(process.env, DJ_ENV);
  delete process.env.DJ_LLM_API_KEY;
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  for (const name of [...Object.keys(DJ_ENV), 'DJ_LLM_API_KEY']) {
    if (saved[name] === undefined) delete process.env[name];
    else process.env[name] = saved[name];
  }
});

const args = { system: 'sys', user: { a: 1 }, temperature: 0.9, timeoutMs: 10000 };

describe('llm.chatJson (R4)', () => {
  it('posts a json_object chat completion to the configured base URL', async () => {
    fetchMock.mockResolvedValue(completion('{"line":"hi","factIds":[]}'));

    const out = await chatJson(args);

    expect(out).toEqual({ line: 'hi', factIds: [] });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('http://litellm:4000/v1/chat/completions');
    expect(init.method).toBe('POST');
    expect(init.signal).toBeInstanceOf(AbortSignal);
    const body = JSON.parse(init.body);
    expect(body.model).toBe('gpt-dj');
    expect(body.response_format).toEqual({ type: 'json_object' });
    expect(body.temperature).toBe(0.9);
    expect(body.messages).toEqual([
      { role: 'system', content: 'sys' },
      { role: 'user', content: '{"a":1}' }
    ]);
  });

  it('tolerates a trailing slash on the base URL', async () => {
    process.env.DJ_LLM_BASE_URL = 'http://litellm:4000/v1/';
    fetchMock.mockResolvedValue(completion('{}'));
    await chatJson(args);
    expect(fetchMock.mock.calls[0][0]).toBe('http://litellm:4000/v1/chat/completions');
  });

  it('passes a string user message through unchanged', async () => {
    fetchMock.mockResolvedValue(completion('{}'));
    await chatJson({ ...args, user: 'plain' });
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).messages[1].content).toBe('plain');
  });

  it('sends no Authorization header when DJ_LLM_API_KEY is unset', async () => {
    fetchMock.mockResolvedValue(completion('{}'));
    await chatJson(args);
    const headers = fetchMock.mock.calls[0][1].headers;
    expect(Object.keys(headers).map((h) => h.toLowerCase())).not.toContain('authorization');
  });

  it('sends a Bearer token when DJ_LLM_API_KEY is set', async () => {
    process.env.DJ_LLM_API_KEY = 'sk-123';
    fetchMock.mockResolvedValue(completion('{}'));
    await chatJson(args);
    expect(fetchMock.mock.calls[0][1].headers.Authorization).toBe('Bearer sk-123');
  });

  it('throws on malformed JSON content', async () => {
    fetchMock.mockResolvedValue(completion('not json {'));
    await expect(chatJson(args)).rejects.toThrow();
  });

  it('throws when the response has no message content', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ choices: [] }), { status: 200 }));
    await expect(chatJson(args)).rejects.toThrow();
  });

  it('throws on a non-2xx status without retrying', async () => {
    fetchMock.mockResolvedValue(new Response('upstream down', { status: 502 }));
    await expect(chatJson(args)).rejects.toThrow(/502/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('throws on timeout', async () => {
    fetchMock.mockRejectedValue(new DOMException('The operation timed out.', 'TimeoutError'));
    await expect(chatJson(args)).rejects.toThrow();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('uses the requested timeout for the abort signal', async () => {
    const spy = vi.spyOn(AbortSignal, 'timeout');
    fetchMock.mockResolvedValue(completion('{}'));
    await chatJson({ ...args, timeoutMs: 20000 });
    expect(spy).toHaveBeenCalledWith(20000);
    spy.mockRestore();
  });
});
