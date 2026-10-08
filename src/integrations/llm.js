import { getDjConfig } from '../config/env.js';

/**
 * One chat completion against the OpenAI-compatible endpoint at
 * DJ_LLM_BASE_URL (a LiteLLM proxy, research R4), asking for a JSON object.
 * No retries: repeated failure is the DJ circuit breaker's job (R9).
 *
 * @param {Object} params
 * @param {string} params.system
 * @param {string} params.user
 * @param {number} [params.temperature]
 * @param {number} params.timeoutMs
 * @returns {Promise<Object>} The parsed JSON content of the first choice
 * @throws {Error} On timeout, network failure, non-2xx, or malformed output
 */
export async function chatJson({ system, user, temperature, timeoutMs }) {
  const { baseUrl, model, apiKey } = getDjConfig().llm;
  const url = `${baseUrl.replace(/\/+$/, '')}/chat/completions`;

  const headers = { 'content-type': 'application/json' };
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;

  const body = {
    model,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user }
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
    throw new Error(`LLM request failed with HTTP ${response.status}`);
  }

  const payload = await response.json();
  const content = payload?.choices?.[0]?.message?.content;
  if (typeof content !== 'string') {
    throw new Error('LLM response has no message content');
  }
  try {
    return JSON.parse(content);
  } catch {
    throw new Error('LLM returned malformed JSON');
  }
}
