import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findPrice, priceEvent } from '../src/pricing.js';
import { createSseParser } from '../src/sse.js';
import { apiKind, createCollector, normalizeUsage } from '../src/usage.js';
import { anthropicEvents, ANTHROPIC_USD, chatEvents, OPENAI_USD, prices, responsesEvents, sse } from './helpers.js';

const parseAll = (text, splitEvery) => {
  const events = [];
  const p = createSseParser((e) => events.push(e));
  const buf = Buffer.from(text);
  for (let i = 0; i < buf.length; i += splitEvery) p.write(buf.subarray(i, i + splitEvery));
  p.end();
  return events;
};

test('apiKind: metered paths only', () => {
  assert.equal(apiKind('/v1/messages'), 'anthropic');
  assert.equal(apiKind('/v1/messages?beta=true'), 'anthropic');
  assert.equal(apiKind('/v1/messages/count_tokens'), null);
  assert.equal(apiKind('/v1/messages/batches'), null);
  assert.equal(apiKind('/v1/chat/completions'), 'chat');
  assert.equal(apiKind('/api/v1/chat/completions'), 'chat');
  assert.equal(apiKind('/chat/completions'), 'chat');
  assert.equal(apiKind('/v1/completions'), 'chat');
  assert.equal(apiKind('/v1/responses'), 'responses');
  assert.equal(apiKind('/v1/models'), null);
  assert.equal(apiKind('/v1/embeddings'), null);
  assert.equal(apiKind('/v1/threads/t_1/messages'), null);
  assert.equal(apiKind('/v1/responses/compact'), 'responses');
});

test('sse parser: same events whatever the chunk boundaries, CRLF and comments', () => {
  const text = sse(anthropicEvents()) + ': keepalive comment\r\n\r\n' + 'data: {"a":\r\ndata: 1}\r\n\r\n';
  const whole = parseAll(text, text.length);
  for (const n of [1, 2, 3, 7, 64]) assert.deepEqual(parseAll(text, n), whole, `split every ${n}`);
  assert.equal(whole.length, anthropicEvents().length + 1);
  assert.equal(whole[0].event, 'message_start');
  assert.equal(whole.at(-1).data, '{"a":\n1}');
  // multibyte characters split across chunks
  assert.equal(parseAll('data: "blå ✓"\n\n', 1)[0].data, '"blå ✓"');
  // a final event without the trailing blank line still counts
  assert.equal(parseAll('data: x', 1)[0].data, 'x');
});

const collect = (kind, events) => {
  const c = createCollector(kind);
  for (const e of parseAll(sse(events), 5)) if (e.data !== '[DONE]') c.observe(JSON.parse(e.data));
  return c.result();
};

const cost = ({ model, usage }) => priceEvent(findPrice(prices.table, model), usage);

test('anthropic stream: message_start usage, cumulative message_delta output, 1h cache writes', () => {
  const r = collect('anthropic', anthropicEvents());
  assert.equal(r.model, 'claude-sonnet-4-5-20250929');
  assert.deepEqual(r.usage, { input: 1000, output: 500, cacheRead: 10000, cacheWrite: 2000, cacheWrite1h: 500 });
  assert.ok(Math.abs(cost(r) - ANTHROPIC_USD) < 1e-9);
});

test('anthropic stream: message_delta may restate input and cache counts', () => {
  const events = anthropicEvents();
  events[5] = { event: 'message_delta', data: { type: 'message_delta', delta: {}, usage: { input_tokens: 1200, cache_read_input_tokens: 10000, output_tokens: 700, cache_creation_input_tokens: null } } };
  const r = collect('anthropic', events);
  assert.deepEqual(r.usage, { input: 1200, output: 700, cacheRead: 10000, cacheWrite: 2000, cacheWrite1h: 500 });
});

test('openai chat stream: final usage chunk, cached tokens split out', () => {
  const r = collect('chat', chatEvents());
  assert.deepEqual(r.usage, { input: 2000, output: 1000, cacheRead: 8000, cacheWrite: 0, cacheWrite1h: 0 });
  assert.ok(Math.abs(cost(r) - OPENAI_USD) < 1e-9);
  assert.equal(collect('chat', chatEvents(undefined, false)).usage, null);
});

test('openai responses stream: usage from response.completed', () => {
  const r = collect('responses', responsesEvents());
  assert.equal(r.model, 'gpt-5');
  assert.deepEqual(r.usage, { input: 2000, output: 1000, cacheRead: 8000, cacheWrite: 0, cacheWrite1h: 0 });
  assert.ok(Math.abs(cost(r) - OPENAI_USD) < 1e-9);
});

test('normalizeUsage: provider variants', () => {
  // DeepSeek cache hits
  assert.deepEqual(normalizeUsage({ prompt_tokens: 100, completion_tokens: 5, prompt_cache_hit_tokens: 60, prompt_cache_miss_tokens: 40 }, 'chat'), { input: 40, output: 5, cacheRead: 60, cacheWrite: 0, cacheWrite1h: 0 });
  // OpenRouter cache writes
  assert.deepEqual(normalizeUsage({ prompt_tokens: 100, completion_tokens: 5, prompt_tokens_details: { cached_tokens: 10, cache_write_tokens: 50 } }, 'chat'), { input: 40, output: 5, cacheRead: 10, cacheWrite: 50, cacheWrite1h: 0 });
  // Responses API without details
  assert.deepEqual(normalizeUsage({ input_tokens: 100, output_tokens: 5 }, 'responses'), { input: 100, output: 5, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0 });
  assert.equal(normalizeUsage(null, 'chat'), null);
});

test('long-context tier applies when the prompt is over the threshold', () => {
  const p = findPrice(prices.table, 'gpt-6-sol');
  const small = priceEvent(p, { input: 1000, output: 0, cacheRead: 0, cacheWrite: 0 });
  const big = priceEvent(p, { input: 300000, output: 0, cacheRead: 0, cacheWrite: 0 });
  assert.ok(Math.abs(small - 1000 * p.input_cost_per_token) < 1e-12);
  assert.ok(Math.abs(big - 300000 * p.input_cost_per_token_above_272k_tokens) < 1e-9);
});

test('sse parser: a multi-megabyte line in small chunks stays fast', () => {
  const big = `data: {"type":"response.completed","pad":"${'x'.repeat(4 * 1024 * 1024)}"}\n\n`;
  const t = performance.now();
  const events = parseAll(big, 16 * 1024);
  assert.equal(events.length, 1);
  assert.ok(performance.now() - t < 300, `took ${Math.round(performance.now() - t)}ms`);
});

test('1-hour cache writes use the long-context 1h rate when there is one', () => {
  const p = { input_cost_per_token: 1, cache_creation_input_token_cost: 1.25, cache_creation_input_token_cost_above_1hr: 2, input_cost_per_token_above_200k_tokens: 2, cache_creation_input_token_cost_above_200k_tokens: 2.5, cache_creation_input_token_cost_above_1hr_above_200k_tokens: 4 };
  assert.equal(priceEvent(p, { input: 0, output: 0, cacheRead: 0, cacheWrite: 100, cacheWrite1h: 100 }), 200);
  assert.equal(priceEvent(p, { input: 300000, output: 0, cacheRead: 0, cacheWrite: 100, cacheWrite1h: 100 }), 300000 * 2 + 400);
});
