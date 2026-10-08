import { getDjConfig } from '../config/env.js';

// OpenAI-compatible chat completions (a LiteLLM proxy) for DJ lines and
// themed picks (R4). Plain fetch, json_object mode, no retries: repeated
// failure is the DJ breaker's job (R9), not this client's.

/**
 * Ask the model for a JSON object.
 * @param {Object} params
 * @param {string} params.system - System prompt
 * @param {string|Object} params.user - User message; objects are JSON-encoded
 * @param {number} [params.temperature]
 * @param {number} params.timeoutMs
 * @returns {Promise<Object>} The parsed JSON content
 * @throws {Error} On timeout, network failure, non-2xx, or malformed output
 */
export async function chatJson({ system, user, temperature, timeoutMs }) {
  const { baseUrl, model, apiKey } = getDjConfig().llm;
  const url = `${baseUrl.replace(/\/+$/, '')}/chat/completions`;

  const headers = { 'Content-Type': 'application/json' };
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;

  const body = {
    model,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: typeof user === 'string' ? user : JSON.stringify(user) }
    ],
    response_format: { type: 'json_object' }
  };
  if (temperature !== undefined) body.temperature = temperature;

  const response = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs)
  });

  if (!response.ok) {
    throw new Error(`LLM request failed with status ${response.status}`);
  }

  const payload = await response.json();
  const content = payload?.choices?.[0]?.message?.content;
  if (typeof content !== 'string') {
    throw new Error('LLM response had no message content');
  }

  const parsed = JSON.parse(content);
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('LLM response content was not a JSON object');
  }
  return parsed;
}
