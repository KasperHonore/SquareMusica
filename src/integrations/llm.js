import { getDjConfig } from '../config/env.js';

// OpenAI-compatible chat completions (LiteLLM proxy), research R4. Plain fetch,
// no SDK and no retries: the DJ circuit breaker handles repeated failure. The
// caller validates the parsed JSON's shape itself.

/** Error thrown by chatJson(). */
export class LlmError extends Error {
  /**
   * @param {'network'|'timeout'|'http'|'malformed'} kind
   * @param {string} message
   */
  constructor(kind, message) {
    super(message);
    this.name = 'LlmError';
    this.kind = kind;
  }
}

/**
 * Ask the model for a JSON object.
 * @param {{ system: string, user: string, temperature?: number, timeoutMs?: number }} params
 * @returns {Promise<Object>} The parsed JSON content
 * @throws {LlmError}
 */
export async function chatJson({ system, user, temperature = 0.9, timeoutMs = 10000 }) {
  const { baseUrl, model, apiKey } = getDjConfig().llm;
  const headers = { 'Content-Type': 'application/json' };
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;

  let response;
  try {
    response = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model,
        temperature,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user }
        ]
      }),
      signal: AbortSignal.timeout(timeoutMs)
    });
  } catch (error) {
    const timedOut = error?.name === 'TimeoutError' || error?.name === 'AbortError';
    throw new LlmError(
      timedOut ? 'timeout' : 'network',
      `LLM request ${timedOut ? 'timed out' : 'failed'}: ${error.message}`
    );
  }

  if (!response.ok) {
    throw new LlmError('http', `LLM HTTP ${response.status}`);
  }

  let content;
  try {
    const body = await response.json();
    content = body?.choices?.[0]?.message?.content;
  } catch (error) {
    throw new LlmError('malformed', `LLM response is not JSON: ${error.message}`);
  }
  if (typeof content !== 'string') {
    throw new LlmError('malformed', 'LLM response has no message content');
  }

  let parsed;
  try {
    parsed = JSON.parse(content);
  } catch (error) {
    throw new LlmError('malformed', `LLM content is not valid JSON: ${error.message}`);
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new LlmError('malformed', 'LLM content is not a JSON object');
  }
  return parsed;
}
