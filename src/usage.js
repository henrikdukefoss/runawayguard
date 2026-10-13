// Reads token usage from LLM API responses, streamed or not, and normalises it to
// { input (uncached), output, cacheRead, cacheWrite, cacheWrite1h }.
//
// Anthropic Messages: usage.input_tokens excludes cache reads and writes, which come as
//   cache_read_input_tokens and cache_creation_input_tokens. Streams send them in
//   message_start and cumulative counts in message_delta.
// OpenAI Chat Completions: usage.prompt_tokens includes prompt_tokens_details.cached_tokens.
//   Streams carry usage in a final chunk when stream_options.include_usage is set.
// OpenAI Responses: usage.input_tokens includes input_tokens_details.cached_tokens.
//   Streams carry it in response.completed (or response.incomplete / response.failed).

/** Which API a request path belongs to, or null for paths that are not metered. */
export function apiKind(url) {
  const p = String(url).split('?')[0].replace(/\/+$/, '');
  if (/\/messages\/(count_tokens|batches)/.test(p)) return null;
  if (/\/v1\/messages$/.test(p) || p === '/messages') return 'anthropic';
  if (/\/chat\/completions$/.test(p) || /\/v\d+\/completions$/.test(p) || p === '/completions') return 'chat';
  // /responses/compact: Codex's remote compaction, billed like a response
  if (/\/responses(\/compact)?$/.test(p)) return 'responses';
  return null;
}

const n = (x) => (typeof x === 'number' && Number.isFinite(x) && x > 0 ? x : 0);

function fromAnthropic(u) {
  const cacheWrite = n(u.cache_creation_input_tokens);
  return {
    input: n(u.input_tokens),
    output: n(u.output_tokens),
    cacheRead: n(u.cache_read_input_tokens),
    cacheWrite,
    cacheWrite1h: Math.min(cacheWrite, n(u.cache_creation?.ephemeral_1h_input_tokens)),
  };
}

function fromChat(u) {
  const d = u.prompt_tokens_details || {};
  // DeepSeek reports prompt_cache_hit_tokens instead of cached_tokens
  const cacheRead = n(d.cached_tokens) || n(u.prompt_cache_hit_tokens);
  // OpenRouter reports cache writes for providers that bill them
  const cacheWrite = n(d.cache_write_tokens);
  return {
    input: Math.max(0, n(u.prompt_tokens) - cacheRead - cacheWrite),
    output: n(u.completion_tokens),
    cacheRead,
    cacheWrite,
    cacheWrite1h: 0,
  };
}

function fromResponses(u) {
  const cacheRead = n(u.input_tokens_details?.cached_tokens);
  return { input: Math.max(0, n(u.input_tokens) - cacheRead), output: n(u.output_tokens), cacheRead, cacheWrite: 0, cacheWrite1h: 0 };
}

export function normalizeUsage(u, kind) {
  if (!u || typeof u !== 'object') return null;
  if ('prompt_tokens' in u || 'completion_tokens' in u) return fromChat(u);
  if ('input_tokens_details' in u || kind === 'responses') return fromResponses(u);
  if ('input_tokens' in u || 'output_tokens' in u) return fromAnthropic(u);
  return null;
}

const merge = (base, extra) => {
  const out = { ...base };
  for (const [k, v] of Object.entries(extra || {})) if (v != null) out[k] = v;
  return out;
};

/**
 * Collects usage and model from the JSON objects of one response: the whole body of a
 * non-streamed response, or each SSE data payload of a streamed one.
 */
export function createCollector(kind) {
  let model = null;
  let anthropic = null;
  let usage = null;
  let usageKind = kind;
  return {
    get model() {
      return model;
    },
    observe(obj) {
      if (!obj || typeof obj !== 'object') return;
      const m = typeof obj.model === 'string' ? obj.model : obj.message?.model || obj.response?.model;
      if (!model && typeof m === 'string' && m) model = m;
      if (obj.type === 'message_start' && obj.message) {
        anthropic = merge(anthropic, obj.message.usage);
      } else if (obj.type === 'message_delta' && obj.usage) {
        anthropic = merge(anthropic, obj.usage);
      } else if (obj.response && typeof obj.response === 'object' && obj.response.usage) {
        usage = obj.response.usage;
        usageKind = 'responses';
      } else if (obj.usage && typeof obj.usage === 'object') {
        usage = obj.usage;
      }
    },
    result() {
      if (anthropic) return { model, usage: fromAnthropic(anthropic) };
      return { model, usage: normalizeUsage(usage, usageKind) };
    },
  };
}

export const totalTokens = (u) => u.input + u.output + u.cacheRead + u.cacheWrite;
