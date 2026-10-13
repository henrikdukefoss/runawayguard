// A fake upstream API and a small client, so the proxy is tested end to end over real
// sockets without contacting any real provider.
import http from 'node:http';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createBudget } from '../src/budget.js';
import { createGuard } from '../src/proxy.js';

export const PROMPT = 'PROMPT_MARKER do not log me';
export const ANSWER = 'RESPONSE_MARKER do not log me either';
export const KEY = 'sk-test-SECRET-KEY-123';

export const prices = (() => {
  const f = JSON.parse(readFileSync(new URL('../src/prices-fallback.json', import.meta.url), 'utf8'));
  return { table: f.prices, source: 'LiteLLM (bundled)', fetchedAt: f.fetchedAt };
})();

export const sse = (events) => events.map((e) => (typeof e === 'string' ? e : `${e.event ? `event: ${e.event}\n` : ''}data: ${JSON.stringify(e.data)}\n\n`)).join('');

// Anthropic: 1,000 uncached + 2,000 cache writes (500 of them 1h) + 10,000 cache reads in, 500 out.
export const ANTHROPIC_USAGE = {
  input_tokens: 1000,
  cache_creation_input_tokens: 2000,
  cache_read_input_tokens: 10000,
  cache_creation: { ephemeral_5m_input_tokens: 1500, ephemeral_1h_input_tokens: 500 },
  output_tokens: 500,
};
// claude-sonnet-4-5: 1000*3e-6 + 1500*3.75e-6 + 500*6e-6 + 10000*3e-7 + 500*15e-6
export const ANTHROPIC_USD = 0.022125;

export const anthropicJson = (model = 'claude-sonnet-4-5-20250929') => ({
  id: 'msg_1',
  type: 'message',
  role: 'assistant',
  model,
  content: [{ type: 'text', text: ANSWER }],
  stop_reason: 'end_turn',
  usage: ANTHROPIC_USAGE,
});

export const anthropicEvents = (model = 'claude-sonnet-4-5-20250929') => [
  { event: 'message_start', data: { type: 'message_start', message: { id: 'msg_1', type: 'message', role: 'assistant', model, content: [], usage: { ...ANTHROPIC_USAGE, output_tokens: 1 } } } },
  { event: 'content_block_start', data: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } } },
  'event: ping\ndata: {"type": "ping"}\n\n',
  { event: 'content_block_delta', data: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: ANSWER } } },
  { event: 'content_block_stop', data: { type: 'content_block_stop', index: 0 } },
  { event: 'message_delta', data: { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 500 } } },
  { event: 'message_stop', data: { type: 'message_stop' } },
];

// OpenAI: 10,000 prompt tokens of which 8,000 cached, 1,000 out.
// gpt-5: 2000*1.25e-6 + 8000*1.25e-7 + 1000*1e-5
export const OPENAI_USD = 0.0135;
export const chatUsage = { prompt_tokens: 10000, completion_tokens: 1000, total_tokens: 11000, prompt_tokens_details: { cached_tokens: 8000 }, completion_tokens_details: { reasoning_tokens: 400 } };

export const chatJson = (model = 'gpt-5-2025-08-07') => ({
  id: 'chatcmpl-1',
  object: 'chat.completion',
  model,
  choices: [{ index: 0, message: { role: 'assistant', content: ANSWER }, finish_reason: 'stop' }],
  usage: chatUsage,
});

export const chatEvents = (model = 'gpt-5-2025-08-07', withUsage = true) => [
  { data: { id: 'c1', object: 'chat.completion.chunk', model, choices: [{ index: 0, delta: { role: 'assistant', content: '' } }], usage: null } },
  { data: { id: 'c1', object: 'chat.completion.chunk', model, choices: [{ index: 0, delta: { content: ANSWER } }], usage: null } },
  { data: { id: 'c1', object: 'chat.completion.chunk', model, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: null } },
  ...(withUsage ? [{ data: { id: 'c1', object: 'chat.completion.chunk', model, choices: [], usage: chatUsage } }] : []),
  'data: [DONE]\n\n',
];

const respUsage = { input_tokens: 10000, input_tokens_details: { cached_tokens: 8000 }, output_tokens: 1000, output_tokens_details: { reasoning_tokens: 400 }, total_tokens: 11000 };
export const responsesEvents = (model = 'gpt-5') => [
  { event: 'response.created', data: { type: 'response.created', sequence_number: 0, response: { id: 'resp_1', object: 'response', status: 'in_progress', model, usage: null } } },
  { event: 'response.output_text.delta', data: { type: 'response.output_text.delta', sequence_number: 1, delta: ANSWER } },
  { event: 'response.completed', data: { type: 'response.completed', sequence_number: 2, response: { id: 'resp_1', object: 'response', status: 'completed', model, usage: respUsage } } },
];
export const responsesJson = (model = 'gpt-5') => ({ id: 'resp_1', object: 'response', status: 'completed', model, output: [{ type: 'message', content: [{ type: 'output_text', text: ANSWER }] }], usage: respUsage });

/**
 * Starts a fake upstream. `handler(req, res, body)` answers each request; every request is
 * recorded in `requests` with its method, url, headers and body.
 */
export async function fakeUpstream(handler) {
  const requests = [];
  let connections = 0;
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      requests.push({ method: req.method, url: req.url, headers: req.headers, body });
      handler(req, res, body);
    });
  });
  server.on('connection', () => connections++);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${server.address().port}`;
  return {
    url,
    requests,
    get connections() {
      return connections;
    },
    close: () => {
      server.closeAllConnections?.();
      return new Promise((r) => server.close(r));
    },
  };
}

export const tmp = () => mkdtempSync(join(tmpdir(), 'runawayguard-test-'));

/** Starts a guard in front of `upstreamUrl`. Returns { url, guard, budget, events, close }. */
export async function startGuard(upstreamUrl, { limit = 5, per = 'session', warnAt = 0.8, dryRun = false, logFile = null, env } = {}) {
  const events = [];
  const budget = createBudget({ limit, per, warnAt, dryRun, env: env || { XDG_STATE_HOME: tmp() } });
  const guard = createGuard({ upstream: upstreamUrl, prices, budget, logFile, onEvent: (type, data) => events.push({ type, ...data }) });
  const port = await guard.listen(0);
  return { url: `http://127.0.0.1:${port}`, guard, budget, events, close: () => guard.close() };
}

/** POST through the proxy. Resolves { status, headers, body, chunks } once the response ends. */
export function post(url, path, payload, { headers = {}, agent, onChunk } = {}) {
  return new Promise((resolve, reject) => {
    const body = typeof payload === 'string' || Buffer.isBuffer(payload) ? payload : JSON.stringify(payload);
    const req = http.request(`${url}${path}`, { method: 'POST', agent, headers: { 'content-type': 'application/json', 'x-api-key': KEY, authorization: `Bearer ${KEY}`, ...headers } }, (res) => {
      const chunks = [];
      res.on('data', (c) => {
        chunks.push(c);
        onChunk?.(c, req, res);
      });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks), chunks }));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.end(body);
  });
}

/** Waits until `fn()` is truthy (for effects that land after the response ends). */
export async function until(fn, ms = 2000) {
  const end = Date.now() + ms;
  while (!fn()) {
    if (Date.now() > end) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 5));
  }
}
