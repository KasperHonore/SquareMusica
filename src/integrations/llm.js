import { getDjConfig } from '../config/env.js';

/**
 * One JSON-mode chat completion against an OpenAI-compatible endpoint (a
 * LiteLLM proxy in practice; research R4). Plain fetch, no SDK and no retries:
 * the DJ's circuit breaker handles repeated failure.
 *
 * @param {Object} params
 * @param {string} params.system - System prompt
 * @param {Object|string} params.user - User payload; objects are sent as JSON
 * @param {number} [params.temperature]
 * @param {number} params.timeoutMs
 * @returns {Promise<Object>} The parsed JSON the model returned
 * @throws {Error} On timeout, non-2xx, or content that is not valid JSON
 */
export async function chatJson({ system, user, temperature, timeoutMs }) {
  const { llm } = getDjConfig();
  const url = `${llm.baseUrl.replace(/\/+$/, '')}/chat/completions`;

  const headers = { 'Content-Type': 'application/json' };
  if (llm.apiKey) {
    headers.Authorization = `Bearer ${llm.apiKey}`;
  }

  const body = {
    model: llm.model,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: typeof user === 'string' ? user : JSON.stringify(user) }
    ],
    response_format: { type: 'json_object' }
  };
  if (temperature !== undefined) {
    body.temperature = temperature;
  }

  const response = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs)
  });

  if (!response.ok) {
    throw new Error(`LLM request failed with HTTP ${response.status}`);
  }

  const data = await response.json();
  const content = data?.choices?.[0]?.message?.content;
  if (typeof content !== 'string') {
    throw new Error('LLM response has no message content');
  }
  return JSON.parse(content);
}
