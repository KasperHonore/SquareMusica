import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { chatJson, LlmError } from '../../src/integrations/llm.js';

const ENV = {
  ELEVENLABS_API_KEY: 'k',
  ELEVENLABS_VOICE_ID: 'v',
  DJ_LLM_BASE_URL: 'http://litellm:4000/v1',
  DJ_LLM_MODEL: 'gpt-dj'
};
const saved = {};

function completion(content, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => ({ choices: [{ message: { content } }] })
  };
}

beforeEach(() => {
  for (const k of [...Object.keys(ENV), 'DJ_LLM_API_KEY']) saved[k] = process.env[k];
  Object.assign(process.env, ENV);
  delete process.env.DJ_LLM_API_KEY;
  globalThis.fetch = vi.fn();
});

afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

describe('llm.chatJson (R4)', () => {
  it('posts a json_object chat completion and parses the content', async () => {
    fetch.mockResolvedValue(completion('{"line":"hi"}'));
    const result = await chatJson({ system: 'sys', user: 'usr', temperature: 0.7, timeoutMs: 500 });

    expect(result).toEqual({ line: 'hi' });
    const [url, init] = fetch.mock.calls[0];
    expect(url).toBe('http://litellm:4000/v1/chat/completions');
    expect(init.method).toBe('POST');
    const body = JSON.parse(init.body);
    expect(body).toEqual({
      model: 'gpt-dj',
      temperature: 0.7,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: 'sys' },
        { role: 'user', content: 'usr' }
      ]
    });
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it('sends no Authorization header without DJ_LLM_API_KEY', async () => {
    fetch.mockResolvedValue(completion('{}'));
    await chatJson({ system: 's', user: 'u' });
    expect(fetch.mock.calls[0][1].headers.Authorization).toBeUndefined();
  });

  it('sends Authorization: Bearer when DJ_LLM_API_KEY is set', async () => {
    process.env.DJ_LLM_API_KEY = 'sk-123';
    fetch.mockResolvedValue(completion('{}'));
    await chatJson({ system: 's', user: 'u' });
    expect(fetch.mock.calls[0][1].headers.Authorization).toBe('Bearer sk-123');
  });

  it('throws on malformed JSON content', async () => {
    fetch.mockResolvedValue(completion('not json {'));
    await expect(chatJson({ system: 's', user: 'u' })).rejects.toMatchObject({
      kind: 'malformed'
    });
  });

  it('throws when content is missing', async () => {
    fetch.mockResolvedValue({ ok: true, status: 200, json: async () => ({ choices: [] }) });
    await expect(chatJson({ system: 's', user: 'u' })).rejects.toBeInstanceOf(LlmError);
  });

  it('throws on non-2xx without retrying', async () => {
    fetch.mockResolvedValue(completion('{}', 502));
    await expect(chatJson({ system: 's', user: 'u' })).rejects.toMatchObject({ kind: 'http' });
    expect(fetch).toHaveBeenCalledOnce();
  });

  it('throws on timeout', async () => {
    fetch.mockImplementation(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          init.signal.addEventListener('abort', () => reject(init.signal.reason));
        })
    );
    await expect(chatJson({ system: 's', user: 'u', timeoutMs: 20 })).rejects.toMatchObject({
      kind: 'timeout'
    });
  });
});
