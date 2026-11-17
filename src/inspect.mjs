// Decides which model responses PromptHole can read tool calls from. Every other shape passes through untouched.
export function inspectKind(format, upPath, contentType) {
  const sse = /event-stream/i.test(contentType), jsn = /json/i.test(contentType);
  if (!sse && !jsn) return null;
  if (format === 'anthropic' && /^\/v1\/messages(\?|$)/.test(upPath)) return sse ? 'anthropic-sse' : 'anthropic-json'; // not /count_tokens
  if (format === 'openai' && /\/chat\/completions(\?|$)/.test(upPath)) return sse ? 'openai-sse' : 'openai-json';
  return null; // OpenAI Responses API, Gemini, ... : not inspected yet
}
