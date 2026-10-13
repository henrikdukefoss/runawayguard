import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import zlib from 'node:zlib';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { localDate } from '../src/budget.js';
import { joinPath } from '../src/proxy.js';
import {
  ANSWER, ANTHROPIC_USD, anthropicEvents, anthropicJson, chatEvents, chatJson, fakeUpstream, KEY, OPENAI_USD,
  post, PROMPT, responsesEvents, responsesJson, sse, startGuard, tmp, until,
} from './helpers.js';

const near = (a, b) => Math.abs(a - b) < 1e-9;
const anthropicBody = { model: 'claude-sonnet-4-5', max_tokens: 100, messages: [{ role: 'user', content: PROMPT }] };
const openaiBody = (stream) => ({ model: 'gpt-5', stream, messages: [{ role: 'user', content: PROMPT }], ...(stream ? { stream_options: { include_usage: true } } : {}) });

const json = (res, obj, status = 200) => {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body), 'request-id': 'req_abc' });
  res.end(body);
};
const stream = (res, events) => {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
  res.end(sse(events));
};

test('anthropic: JSON response passes through unchanged and is priced', async () => {
  const up = await fakeUpstream((req, res) => json(res, anthropicJson()));
  const g = await startGuard(up.url);
  try {
    const r = await post(g.url, '/v1/messages?beta=true', anthropicBody, { headers: { 'anthropic-version': '2023-06-01', 'anthropic-beta': 'x' } });
    assert.equal(r.status, 200);
    assert.deepEqual(JSON.parse(r.body), anthropicJson());
    assert.equal(r.headers['request-id'], 'req_abc');
    // forwarded unchanged: path, query, body and every auth header; host rewritten
    const seen = up.requests[0];
    assert.equal(seen.url, '/v1/messages?beta=true');
    assert.deepEqual(JSON.parse(seen.body), anthropicBody);
    assert.equal(seen.headers['x-api-key'], KEY);
    assert.equal(seen.headers.authorization, `Bearer ${KEY}`);
    assert.equal(seen.headers['anthropic-version'], '2023-06-01');
    assert.equal(seen.headers['anthropic-beta'], 'x');
    assert.equal(seen.headers.host, new URL(up.url).host);
    await until(() => g.events.some((e) => e.type === 'request'));
    const ev = g.events.find((e) => e.type === 'request');
    assert.equal(ev.model, 'claude-sonnet-4-5-20250929');
    assert.ok(near(ev.usd, ANTHROPIC_USD));
    assert.ok(near(g.budget.spent(), ANTHROPIC_USD));
  } finally {
    await g.close();
    await up.close();
  }
});

test('anthropic: SSE stream is passed through without buffering and metered at the end', async () => {
  const events = anthropicEvents();
  let release;
  const released = new Promise((r) => (release = r));
  const up = await fakeUpstream(async (req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write(sse(events.slice(0, 1)));
    await released; // the rest only after the client has seen the first event
    res.end(sse(events.slice(1)));
  });
  const g = await startGuard(up.url);
  try {
    let firstChunkAt = null;
    const r = await post(g.url, '/v1/messages', { ...anthropicBody, stream: true }, {
      onChunk: (c) => {
        if (firstChunkAt == null) {
          firstChunkAt = Date.now();
          assert.match(c.toString(), /message_start/);
          release();
        }
      },
    });
    assert.ok(firstChunkAt, 'first event arrived before the stream ended');
    assert.equal(r.body.toString(), sse(events));
    await until(() => g.events.some((e) => e.type === 'request'));
    const ev = g.events.find((e) => e.type === 'request');
    assert.equal(ev.stream, true);
    assert.deepEqual([ev.input, ev.output, ev.cacheRead, ev.cacheWrite, ev.cacheWrite1h], [1000, 500, 10000, 2000, 500]);
    assert.ok(near(ev.usd, ANTHROPIC_USD));
  } finally {
    await g.close();
    await up.close();
  }
});

test('openai chat: JSON and streamed usage (include_usage)', async () => {
  const up = await fakeUpstream((req, res, body) => (JSON.parse(body).stream ? stream(res, chatEvents()) : json(res, chatJson())));
  const g = await startGuard(up.url);
  try {
    const a = await post(g.url, '/v1/chat/completions', openaiBody(false));
    assert.deepEqual(JSON.parse(a.body), chatJson());
    const b = await post(g.url, '/v1/chat/completions', openaiBody(true));
    assert.equal(b.body.toString(), sse(chatEvents()));
    await until(() => g.events.filter((e) => e.type === 'request').length === 2);
    for (const ev of g.events.filter((e) => e.type === 'request')) {
      assert.equal(ev.api, 'chat');
      assert.deepEqual([ev.input, ev.cacheRead, ev.output], [2000, 8000, 1000]);
      assert.ok(near(ev.usd, OPENAI_USD));
    }
    assert.ok(near(g.budget.spent(), 2 * OPENAI_USD));
  } finally {
    await g.close();
    await up.close();
  }
});

test('openai responses (Codex): JSON and streamed response.completed usage', async () => {
  const up = await fakeUpstream((req, res, body) => (JSON.parse(body).stream ? stream(res, responsesEvents()) : json(res, responsesJson())));
  const g = await startGuard(up.url);
  try {
    await post(g.url, '/v1/responses', { model: 'gpt-5', input: PROMPT, stream: true });
    await post(g.url, '/v1/responses', { model: 'gpt-5', input: PROMPT });
    await until(() => g.events.filter((e) => e.type === 'request').length === 2);
    for (const ev of g.events.filter((e) => e.type === 'request')) {
      assert.equal(ev.api, 'responses');
      assert.equal(ev.model, 'gpt-5');
      assert.ok(near(ev.usd, OPENAI_USD));
    }
  } finally {
    await g.close();
    await up.close();
  }
});

test('gzip and brotli responses: client gets the compressed bytes, usage is still read', async () => {
  const up = await fakeUpstream((req, res) => {
    if (req.url.includes('stream')) {
      // a gzip SSE stream, flushed per event as a real server would
      res.writeHead(200, { 'content-type': 'text/event-stream', 'content-encoding': 'gzip' });
      const gz = zlib.createGzip();
      gz.pipe(res);
      for (const e of anthropicEvents()) {
        gz.write(sse([e]));
        gz.flush();
      }
      gz.end();
      return;
    }
    const br = req.url.includes('br');
    const body = br ? zlib.brotliCompressSync(JSON.stringify(chatJson())) : zlib.gzipSync(JSON.stringify(anthropicJson()));
    res.writeHead(200, { 'content-type': 'application/json', 'content-encoding': br ? 'br' : 'gzip', 'content-length': body.length });
    res.end(body);
  });
  const g = await startGuard(up.url);
  try {
    const a = await post(g.url, '/v1/messages', anthropicBody, { headers: { 'accept-encoding': 'gzip' } });
    assert.equal(a.headers['content-encoding'], 'gzip');
    assert.deepEqual(JSON.parse(zlib.gunzipSync(a.body)), anthropicJson());
    const b = await post(g.url, '/v1/messages?stream', { ...anthropicBody, stream: true }, { headers: { 'accept-encoding': 'gzip' } });
    assert.equal(zlib.gunzipSync(b.body).toString(), sse(anthropicEvents()));
    const c = await post(g.url, '/br/v1/chat/completions', openaiBody(false), { headers: { 'accept-encoding': 'br' } });
    assert.deepEqual(JSON.parse(zlib.brotliDecompressSync(c.body)), chatJson());
    await until(() => g.events.filter((e) => e.type === 'request').length === 3);
    const usds = g.events.filter((e) => e.type === 'request').map((e) => e.usd);
    assert.ok(near(usds[0], ANTHROPIC_USD) && near(usds[1], ANTHROPIC_USD) && near(usds[2], OPENAI_USD), usds.join());
  } finally {
    await g.close();
    await up.close();
  }
});

test('limit: once reached, metered requests get HTTP 402 and never reach the upstream', async () => {
  const up = await fakeUpstream((req, res) => json(res, anthropicJson()));
  const g = await startGuard(up.url, { limit: 0.03, warnAt: 0.5 });
  try {
    assert.equal((await post(g.url, '/v1/messages', anthropicBody)).status, 200); // $0.022: warn (over $0.015)
    await until(() => g.events.some((e) => e.type === 'warn'));
    assert.equal((await post(g.url, '/v1/messages', anthropicBody)).status, 200); // $0.044: limit reached
    await until(() => g.events.some((e) => e.type === 'limit'));
    const r = await post(g.url, '/v1/messages', anthropicBody);
    assert.equal(r.status, 402);
    assert.equal(r.headers['x-should-retry'], 'false');
    const err = JSON.parse(r.body);
    assert.equal(err.type, 'error');
    assert.equal(err.error.type, 'spend_limit_reached');
    assert.equal(err.error.message, 'runawayguard: $0.03 session limit reached ($0.04 spent). Restart runawayguard with a higher --limit to continue.');
    assert.equal(up.requests.length, 2, 'blocked request was not forwarded');
    // other APIs are blocked too; free endpoints are not
    assert.equal((await post(g.url, '/v1/chat/completions', openaiBody(true))).status, 402);
    assert.equal((await post(g.url, '/v1/responses', { model: 'gpt-5', input: 'x' })).status, 402);
    assert.equal((await post(g.url, '/v1/messages/count_tokens', anthropicBody)).status, 200);
    assert.equal(g.guard.stats.blocked, 3);
    assert.deepEqual(g.events.filter((e) => e.type === 'block').map((e) => e.count), [1, 2, 3]);
  } finally {
    await g.close();
    await up.close();
  }
});

test('dry run: meters and reports the limit, never blocks', async () => {
  const up = await fakeUpstream((req, res) => json(res, anthropicJson()));
  const g = await startGuard(up.url, { limit: 0.01, dryRun: true });
  try {
    for (let i = 0; i < 3; i++) assert.equal((await post(g.url, '/v1/messages', anthropicBody)).status, 200);
    await until(() => g.events.filter((e) => e.type === 'request').length === 3);
    assert.equal(g.events.filter((e) => e.type === 'limit').length, 1);
    assert.equal(up.requests.length, 3);
  } finally {
    await g.close();
    await up.close();
  }
});

test('per day: the ledger survives restarts and is shared', async () => {
  const state = tmp();
  const dir = join(state, 'runawayguard', 'spend');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${localDate(Date.now())}.jsonl`);
  writeFileSync(file, `${JSON.stringify({ t: new Date().toISOString(), usd: 0.99 })}\n`);
  const up = await fakeUpstream((req, res) => json(res, anthropicJson()));
  const g = await startGuard(up.url, { limit: 1, per: 'day', env: { XDG_STATE_HOME: state } });
  try {
    assert.ok(near(g.budget.spent(), 0.99));
    assert.equal((await post(g.url, '/v1/messages', anthropicBody)).status, 200);
    await until(() => g.events.some((e) => e.type === 'request'));
    // another process adds to today's total
    writeFileSync(file, readFileSync(file, 'utf8') + 'torn line\n' + JSON.stringify({ t: 'x', usd: 0.5 }) + '\n');
    const r = await post(g.url, '/v1/messages', anthropicBody);
    assert.equal(r.status, 402);
    assert.match(JSON.parse(r.body).error.message, /^runawayguard: \$1\.00 daily limit reached \(\$1\.51 spent today\)/);
    const lines = readFileSync(file, 'utf8').trim().split('\n');
    assert.deepEqual(Object.keys(JSON.parse(lines[1])), ['t', 'usd']);
  } finally {
    await g.close();
    await up.close();
  }
});

test('--log writes usage only: no prompts, responses or keys', async () => {
  const logFile = join(tmp(), 'usage.jsonl');
  const up = await fakeUpstream((req, res, body) => (req.url.includes('chat') ? stream(res, chatEvents()) : json(res, anthropicJson())));
  const g = await startGuard(up.url, { limit: 0.03, logFile });
  try {
    await post(g.url, '/v1/messages?beta=true', anthropicBody);
    await post(g.url, '/v1/chat/completions', openaiBody(true));
    await post(g.url, '/v1/messages', anthropicBody); // blocked
    await until(() => existsSync(logFile) && readFileSync(logFile, 'utf8').trim().split('\n').length === 3);
    const text = readFileSync(logFile, 'utf8');
    for (const secret of [PROMPT, ANSWER, KEY, 'PROMPT_MARKER', 'RESPONSE_MARKER', 'SECRET', 'beta=true']) assert.ok(!text.includes(secret), `log must not contain ${secret}`);
    const [a, b, c] = text.trim().split('\n').map((l) => JSON.parse(l));
    assert.deepEqual(Object.keys(a).sort(), ['api', 'cacheRead', 'cacheWrite', 'cacheWrite1h', 'input', 'limit', 'method', 'model', 'ms', 'output', 'path', 'per', 'spent', 'status', 'stream', 'time', 'usd'].sort());
    assert.equal(a.path, '/v1/messages');
    assert.equal(a.usd, ANTHROPIC_USD);
    assert.equal(b.stream, true);
    assert.equal(c.status, 402);
    assert.equal(c.blocked, true);
  } finally {
    await g.close();
    await up.close();
  }
});

test('unpriced models and streams without usage are reported, not guessed', async () => {
  const up = await fakeUpstream((req, res, body) => {
    const b = JSON.parse(body);
    if (b.stream) stream(res, chatEvents('gpt-5', false));
    else json(res, chatJson('standardcompute'));
  });
  const g = await startGuard(up.url);
  try {
    await post(g.url, '/v1/chat/completions', { model: 'standardcompute', messages: [] });
    await post(g.url, '/v1/chat/completions', { model: 'gpt-5', stream: true, messages: [] });
    await until(() => g.events.some((e) => e.type === 'unmetered'));
    assert.deepEqual(g.events.find((e) => e.type === 'unpriced'), { type: 'unpriced', model: 'standardcompute' });
    assert.equal(g.events.find((e) => e.type === 'request').usd, null);
    assert.equal(g.events.find((e) => e.type === 'unmetered').reason, 'no usage in stream');
    assert.equal(g.budget.spent(), 0);
    assert.equal(g.guard.stats.unmetered, 1);
  } finally {
    await g.close();
    await up.close();
  }
});

test('model falls back to the request body when the response has none', async () => {
  const up = await fakeUpstream((req, res) => json(res, { ...chatJson(), model: undefined }));
  const g = await startGuard(up.url);
  try {
    await post(g.url, '/v1/chat/completions', openaiBody(false), { headers: {} });
    await until(() => g.events.some((e) => e.type === 'request'));
    assert.equal(g.events.find((e) => e.type === 'request').model, 'gpt-5');
  } finally {
    await g.close();
    await up.close();
  }
});

test('upstream errors pass through and cost nothing; an unreachable upstream gives 502', async () => {
  const up = await fakeUpstream((req, res) => json(res, { type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } }, 529));
  const g = await startGuard(up.url);
  try {
    const r = await post(g.url, '/v1/messages', anthropicBody);
    assert.equal(r.status, 529);
    assert.equal(JSON.parse(r.body).error.type, 'overloaded_error');
    assert.equal(g.budget.spent(), 0);
  } finally {
    await g.close();
    await up.close();
  }
  const dead = await startGuard('http://127.0.0.1:9');
  try {
    const r = await post(dead.url, '/v1/messages', anthropicBody);
    assert.equal(r.status, 502);
    assert.match(JSON.parse(r.body).error.message, /^runawayguard: could not reach http:\/\/127\.0\.0\.1:9/);
  } finally {
    await dead.close();
  }
});

test('non-metered requests pass through even over the limit', async () => {
  const up = await fakeUpstream((req, res) => json(res, { data: [{ id: 'gpt-5' }] }));
  const g = await startGuard(up.url, { limit: 1 });
  g.budget.add(2);
  try {
    const r = await new Promise((resolve) => http.get(`${g.url}/v1/models`, { headers: { authorization: `Bearer ${KEY}` } }, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => resolve({ status: res.statusCode, body }));
    }));
    assert.equal(r.status, 200);
    assert.equal(up.requests[0].method, 'GET');
    assert.equal(up.requests[0].headers.authorization, `Bearer ${KEY}`);
  } finally {
    await g.close();
    await up.close();
  }
});

test('the agent cancelling a stream stops the upstream request and keeps the partial usage', async () => {
  let upstreamClosed = false;
  const up = await fakeUpstream((req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write(sse(anthropicEvents().slice(0, 2)));
    res.on('close', () => (upstreamClosed = true)); // never ends on its own
  });
  const g = await startGuard(up.url);
  try {
    await new Promise((resolve) => {
      const req = http.request(`${g.url}/v1/messages`, { method: 'POST', headers: { 'content-type': 'application/json' } }, (res) => {
        res.once('data', () => {
          req.destroy();
          resolve();
        });
      });
      req.on('error', () => {});
      req.end(JSON.stringify({ ...anthropicBody, stream: true }));
    });
    await until(() => upstreamClosed);
    await until(() => g.events.some((e) => e.type === 'request'));
    const ev = g.events.find((e) => e.type === 'request');
    assert.equal(ev.aborted, 'client');
    assert.equal(ev.input, 1000);
    assert.equal(ev.cacheRead, 10000);
  } finally {
    await g.close();
    await up.close();
  }
});

test('keep-alive: sequential requests reuse one upstream connection', async () => {
  const up = await fakeUpstream((req, res) => json(res, anthropicJson()));
  const g = await startGuard(up.url);
  const agent = new http.Agent({ keepAlive: true, maxSockets: 1 });
  try {
    for (let i = 0; i < 3; i++) await post(g.url, '/v1/messages', anthropicBody, { agent });
    assert.equal(up.requests.length, 3);
    assert.equal(up.connections, 1);
  } finally {
    agent.destroy();
    await g.close();
    await up.close();
  }
});

test('upstream with a path prefix, and /v1 is not doubled', async () => {
  assert.equal(joinPath('/v1', '/v1/chat/completions'), '/v1/chat/completions');
  assert.equal(joinPath('/v1/', '/v1/messages?beta=true'), '/v1/messages?beta=true');
  assert.equal(joinPath('/api', '/v1/chat/completions'), '/api/v1/chat/completions');
  assert.equal(joinPath('/', '/v1/messages'), '/v1/messages');
  assert.equal(joinPath('/v1', '/chat/completions'), '/v1/chat/completions');
  const up = await fakeUpstream((req, res) => json(res, chatJson()));
  const g = await startGuard(`${up.url}/api/v1`);
  try {
    await post(g.url, '/v1/chat/completions', openaiBody(false));
    assert.equal(up.requests[0].url, '/api/v1/chat/completions');
  } finally {
    await g.close();
    await up.close();
  }
});

test('WebSocket upgrades are refused with 501, not passed through unmetered', async () => {
  const up = await fakeUpstream((req, res) => json(res, {}));
  const g = await startGuard(up.url);
  try {
    const status = await new Promise((resolve) => {
      const req = http.request(`${g.url}/v1/responses`, { headers: { connection: 'Upgrade', upgrade: 'websocket', 'sec-websocket-version': '13', 'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==' } });
      req.on('response', (res) => resolve(res.statusCode));
      req.on('upgrade', () => resolve('upgraded'));
      req.on('error', () => resolve('error'));
      req.end();
    });
    assert.equal(status, 501);
    assert.equal(up.requests.length, 0);
    assert.deepEqual(g.events.map((e) => e.type), ['websocket']);
  } finally {
    await g.close();
    await up.close();
  }
});

test('an upstream that drops mid-stream ends the response instead of leaving the agent waiting', async () => {
  const up = await fakeUpstream((req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write(sse(anthropicEvents().slice(0, 2)));
    setTimeout(() => res.socket.destroy(), 20);
  });
  const g = await startGuard(up.url);
  try {
    const outcome = await new Promise((resolve) => {
      const req = http.request(`${g.url}/v1/messages`, { method: 'POST' }, (res) => {
        res.on('data', () => {});
        res.on('end', () => resolve('end'));
        res.on('error', () => resolve('error'));
        res.on('aborted', () => resolve('aborted'));
      });
      req.on('error', () => resolve('error'));
      req.end('{}');
      setTimeout(() => resolve('hung'), 2000);
    });
    assert.notEqual(outcome, 'hung');
    await until(() => g.events.some((e) => e.type === 'request'));
    assert.equal(g.events.find((e) => e.type === 'request').aborted, 'upstream');
  } finally {
    await g.close();
    await up.close();
  }
});

test('the agent hanging up before the response starts is not reported as an upstream error', async () => {
  let reached;
  const arrived = new Promise((r) => (reached = r));
  const up = await fakeUpstream(() => reached()); // never answers
  const g = await startGuard(up.url);
  try {
    const req = http.request(`${g.url}/v1/messages`, { method: 'POST' });
    req.on('error', () => {});
    req.end('{}');
    await arrived;
    req.destroy();
    await new Promise((r) => setTimeout(r, 100));
    assert.deepEqual(g.events, []);
  } finally {
    await g.close();
    await up.close();
  }
});

test('a day ledger that cannot be written is reported, and the proxy keeps running', async () => {
  const notADir = join(tmp(), 'file');
  writeFileSync(notADir, '');
  const up = await fakeUpstream((req, res) => json(res, anthropicJson()));
  const g = await startGuard(up.url, { per: 'day', env: { XDG_STATE_HOME: notADir } });
  try {
    assert.throws(() => g.budget.checkWritable());
    assert.equal((await post(g.url, '/v1/messages', anthropicBody)).status, 200);
    assert.equal((await post(g.url, '/v1/messages', anthropicBody)).status, 200);
    await until(() => g.events.filter((e) => e.type === 'request').length === 2);
    assert.equal(g.events.filter((e) => e.type === 'error').length, 1);
    assert.match(g.events.find((e) => e.type === 'error').message, /could not update the daily spend file/);
  } finally {
    await g.close();
    await up.close();
  }
});

test('accept-encoding only offers what the meter can decode', async () => {
  const up = await fakeUpstream((req, res) => json(res, anthropicJson()));
  const g = await startGuard(up.url);
  try {
    await post(g.url, '/v1/messages', anthropicBody, { headers: { 'accept-encoding': 'gzip, deflate, br, snappy' } });
    await post(g.url, '/v1/messages', anthropicBody, { headers: { 'accept-encoding': 'snappy' } });
    await post(g.url, '/v1/models', anthropicBody, { headers: { 'accept-encoding': 'snappy' } });
    assert.equal(up.requests[0].headers['accept-encoding'], 'gzip, deflate, br');
    assert.equal(up.requests[1].headers['accept-encoding'], undefined);
    assert.equal(up.requests[2].headers['accept-encoding'], 'snappy', 'unmetered paths are untouched');
  } finally {
    await g.close();
    await up.close();
  }
});

test('close() ends open streams and waits until they are recorded', async () => {
  const up = await fakeUpstream((req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write(sse(anthropicEvents().slice(0, 1))); // never ends
  });
  const g = await startGuard(up.url);
  const req = http.request(`${g.url}/v1/messages`, { method: 'POST' }, (res) => res.resume());
  req.on('error', () => {});
  req.end('{}');
  await until(() => up.requests.length === 1);
  await new Promise((r) => setTimeout(r, 50));
  try {
    await g.close();
    assert.equal(g.events.filter((e) => e.type === 'request').length, 1);
    assert.equal(g.events[0].aborted, 'shutdown');
  } finally {
    await up.close();
  }
});
