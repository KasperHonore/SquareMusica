import { getDjConfig } from '../config/env.js';

// OpenAI-compatible chat completions (a LiteLLM proxy in practice) for the AI
// DJ (research R4). Plain fetch and no retries: the DJ's circuit breaker handles
// repeated failure.

/**
 * Ask the model for a JSON object.
 * @param {Object} params
 * @param {string} params.system - System prompt
 * @param {string|Object} params.user - User message; objects are sent as JSON
 * @param {number} params.temperature
 * @param {number} params.timeoutMs
 * @returns {Promise<Object>} The parsed JSON from the first choice
 * @throws {Error} On timeout, network failure, non-2xx status or malformed JSON
 */
export async function chatJson({ system, user, temperature, timeoutMs }) {
  const { baseUrl, model, apiKey } = getDjConfig().llm;
  const url = `${baseUrl.replace(/\/+$/, '')}/chat/completions`;

  const headers = { 'Content-Type': 'application/json' };
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;

  const response = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      model,
      temperature,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: typeof user === 'string' ? user : JSON.stringify(user) }
      ]
    }),
    signal: AbortSignal.timeout(timeoutMs)
  });

  if (!response.ok) {
    throw new Error(`LLM request failed with HTTP ${response.status}`);
  }

  const body = await response.json();
  const content = body?.choices?.[0]?.message?.content;
  if (typeof content !== 'string') {
    throw new Error('LLM response has no message content');
  }
  return JSON.parse(content);
}
