import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../src/utils/logger.js', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() }
}));

import { chatJson } from '../../src/integrations/llm.js';

const VARS = ['DJ_LLM_BASE_URL', 'DJ_LLM_MODEL', 'DJ_LLM_API_KEY'];
const saved = {};
let fetchMock;

function completion(content, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => ({ choices: [{ message: { content } }] }),
    text: async () => 'body'
  };
}

beforeEach(() => {
  for (const k of VARS) saved[k] = process.env[k];
  process.env.DJ_LLM_BASE_URL = 'http://litellm:4000';
  process.env.DJ_LLM_MODEL = 'gpt-4o-mini';
  delete process.env.DJ_LLM_API_KEY;
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  for (const k of VARS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  vi.unstubAllGlobals();
});

describe('llm.chatJson (R4)', () => {
  it('posts a json_object chat completion and returns the parsed content', async () => {
    fetchMock.mockResolvedValue(completion('{"line":"Hi","factIds":[]}'));

    const out = await chatJson({
      system: 'sys',
      user: { a: 1 },
      temperature: 0.9,
      timeoutMs: 10000
    });

    expect(out).toEqual({ line: 'Hi', factIds: [] });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('http://litellm:4000/chat/completions');
    expect(init.method).toBe('POST');
    expect(init.headers['Content-Type']).toBe('application/json');
    expect(init.headers.Authorization).toBeUndefined();
    expect(init.signal).toBeInstanceOf(AbortSignal);
    const body = JSON.parse(init.body);
    expect(body.model).toBe('gpt-4o-mini');
    expect(body.response_format).toEqual({ type: 'json_object' });
    expect(body.temperature).toBe(0.9);
    expect(body.messages).toEqual([
      { role: 'system', content: 'sys' },
      { role: 'user', content: '{"a":1}' }
    ]);
  });

  it('sends a string user message as-is', async () => {
    fetchMock.mockResolvedValue(completion('{}'));
    await chatJson({ system: 's', user: 'plain', timeoutMs: 1000 });
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).messages[1].content).toBe('plain');
  });

  it('sends Authorization: Bearer only when DJ_LLM_API_KEY is set', async () => {
    process.env.DJ_LLM_API_KEY = 'sk-123';
    fetchMock.mockResolvedValue(completion('{}'));
    await chatJson({ system: 's', user: 'u', timeoutMs: 1000 });
    expect(fetchMock.mock.calls[0][1].headers.Authorization).toBe('Bearer sk-123');
  });

  it('tolerates a trailing slash on the base URL', async () => {
    process.env.DJ_LLM_BASE_URL = 'http://litellm:4000/v1/';
    fetchMock.mockResolvedValue(completion('{}'));
    await chatJson({ system: 's', user: 'u', timeoutMs: 1000 });
    expect(fetchMock.mock.calls[0][0]).toBe('http://litellm:4000/v1/chat/completions');
  });

  it('throws on malformed JSON content', async () => {
    fetchMock.mockResolvedValue(completion('not json {'));
    await expect(chatJson({ system: 's', user: 'u', timeoutMs: 1000 })).rejects.toThrow();
  });

  it('throws when content is missing', async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 200, json: async () => ({ choices: [] }) });
    await expect(chatJson({ system: 's', user: 'u', timeoutMs: 1000 })).rejects.toThrow();
  });

  it('throws on non-2xx without retrying', async () => {
    fetchMock.mockResolvedValue(completion('{}', 500));
    await expect(chatJson({ system: 's', user: 'u', timeoutMs: 1000 })).rejects.toThrow(/500/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('throws on timeout without retrying', async () => {
    fetchMock.mockRejectedValue(Object.assign(new Error('aborted'), { name: 'TimeoutError' }));
    await expect(chatJson({ system: 's', user: 'u', timeoutMs: 5 })).rejects.toThrow();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
