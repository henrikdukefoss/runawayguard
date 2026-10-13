// The local proxy. Requests are forwarded to the upstream unchanged: same method, path,
// headers (API keys included) and body, streamed in both directions without buffering.
// A copy of each response is decoded on the side to read its usage. Nothing from a
// request or response body is stored or logged except token counts and the model name.
import http from 'node:http';
import https from 'node:https';
import zlib from 'node:zlib';
import { appendFileSync } from 'node:fs';
import { findPrice, priceEvent } from './pricing.js';
import { createSseParser } from './sse.js';
import { apiKind, createCollector } from './usage.js';

// Headers that describe one connection and must not be forwarded (RFC 9110, 7.6.1).
const HOP = new Set(['connection', 'keep-alive', 'proxy-connection', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade']);
const MAX_JSON = 64 * 1024 * 1024;
const MAX_SNIFF = 16 * 1024 * 1024;

export const UPSTREAMS = {
  anthropic: 'https://api.anthropic.com',
  openai: 'https://api.openai.com',
  openrouter: 'https://openrouter.ai/api',
};

function forwardHeaders(src) {
  const drop = new Set(HOP);
  for (const name of String(src.connection || '').split(',')) drop.add(name.trim().toLowerCase());
  const out = {};
  for (const [k, v] of Object.entries(src)) if (!drop.has(k) && v !== undefined) out[k] = v;
  return out;
}

/** Upstream path + request path, without doubling a /v1 present in both. */
export function joinPath(basePath, url) {
  const base = basePath.replace(/\/+$/, '');
  if (/\/v1$/.test(base) && /^\/v1(\/|\?|$)/.test(url)) return base + url.slice(3);
  return base + url;
}

function decoderFor(encoding) {
  const e = String(encoding || '').trim().toLowerCase();
  if (!e || e === 'identity') return null;
  if (e === 'gzip' || e === 'x-gzip') return zlib.createGunzip({ finishFlush: zlib.constants.Z_SYNC_FLUSH });
  if (e === 'deflate') return zlib.createUnzip({ finishFlush: zlib.constants.Z_SYNC_FLUSH });
  if (e === 'br') return zlib.createBrotliDecompress({ finishFlush: zlib.constants.BROTLI_OPERATION_FLUSH });
  if (e === 'zstd' && typeof zlib.createZstdDecompress === 'function') return zlib.createZstdDecompress();
  return undefined; // unsupported: forwarded as is, but not metered
}

/** Reads the model name from a buffered request body (only used when the response has none). */
function sniffModel(chunks, encoding) {
  try {
    let buf = Buffer.concat(chunks);
    const e = String(encoding || '').toLowerCase();
    if (e === 'gzip') buf = zlib.gunzipSync(buf);
    else if (e === 'br') buf = zlib.brotliDecompressSync(buf);
    else if (e === 'zstd' && typeof zlib.zstdDecompressSync === 'function') buf = zlib.zstdDecompressSync(buf);
    else if (e && e !== 'identity') return null;
    const m = JSON.parse(buf.toString('utf8')).model;
    return typeof m === 'string' ? m : null;
  } catch {
    return null;
  }
}

/**
 * Creates the guard. Returns { server, listen(port, host), close(), stats }.
 * onEvent(type, data) receives: 'request' (a usage record), 'warn', 'limit', 'block',
 * 'unpriced' (model), 'unmetered' (record), 'error' (record).
 */
export function createGuard({ upstream, prices, budget, logFile = null, onEvent = () => {}, now = () => Date.now() }) {
  const up = new URL(upstream);
  const lib = up.protocol === 'https:' ? https : http;
  const agent = new lib.Agent({ keepAlive: true, maxSockets: 256 });
  const basePath = up.pathname;
  const table = prices?.table || {};
  const stats = { requests: 0, blocked: 0, unmetered: 0, models: new Map() };
  const seenUnpriced = new Set();
  const pending = new Set();
  let closing = false;
  const reported = new Set();
  // Report a failure once; a broken disk must not take the proxy down.
  const fault = (key, message) => {
    if (reported.has(key)) return;
    reported.add(key);
    try {
      onEvent('error', { message });
    } catch {
      // the reporter itself failed; nothing left to tell
    }
  };

  const log = (entry) => {
    if (!logFile) return;
    try {
      appendFileSync(logFile, JSON.stringify(entry) + '\n');
    } catch (err) {
      fault('log', `runawayguard: could not write ${logFile} (${err.code || err.message})`);
    }
  };

  function limitMessage() {
    const spent = budget.spent();
    const lim = `$${budget.limit.toFixed(2)}`;
    return budget.per === 'day'
      ? `runawayguard: ${lim} daily limit reached ($${spent.toFixed(2)} spent today). It resets at local midnight, or restart runawayguard with a higher --limit.`
      : `runawayguard: ${lim} session limit reached ($${spent.toFixed(2)} spent). Restart runawayguard with a higher --limit to continue.`;
  }

  function block(req, res) {
    req.resume();
    const message = limitMessage();
    // One body that reads as an error to both Anthropic and OpenAI clients.
    const body = JSON.stringify({ type: 'error', error: { type: 'spend_limit_reached', code: 'spend_limit_reached', message } });
    res.writeHead(402, {
      'content-type': 'application/json',
      'content-length': Buffer.byteLength(body),
      'x-should-retry': 'false',
    });
    res.end(body);
    stats.blocked++;
    const path = req.url.split('?')[0];
    log({ time: new Date(now()).toISOString(), method: req.method, path, status: 402, blocked: true, spent: round(budget.spent()), limit: budget.limit, per: budget.per });
    onEvent('block', { path, message, spent: budget.spent(), count: stats.blocked });
  }

  function record({ req, kind, status, stream, started, collected, sniff, aborted, unmeterable }) {
    const path = req.url.split('?')[0];
    const { model: respModel, usage } = collected || {};
    const model = respModel || sniff() || 'unknown';
    const ok = status >= 200 && status < 300;
    const base = { time: new Date(started).toISOString(), method: req.method, path, api: kind, status, stream, model, ms: now() - started };
    if (!usage) {
      if (ok && !aborted) {
        stats.unmetered++;
        const entry = { ...base, usd: null, unmetered: true };
        log(entry);
        onEvent('unmetered', { ...entry, reason: unmeterable || (stream ? 'no usage in stream' : 'no usage in response') });
      }
      return;
    }
    const price = findPrice(table, model);
    const usd = price ? priceEvent(price, usage) : null;
    if (!price && !seenUnpriced.has(model)) {
      seenUnpriced.add(model);
      onEvent('unpriced', { model });
    }
    stats.requests++;
    const m = stats.models.get(model) || { requests: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, usd: 0, priced: !!price };
    m.requests++;
    m.input += usage.input;
    m.output += usage.output;
    m.cacheRead += usage.cacheRead;
    m.cacheWrite += usage.cacheWrite;
    m.usd += usd || 0;
    stats.models.set(model, m);
    let crossed = null;
    try {
      crossed = budget.add(usd || 0);
    } catch (err) {
      fault('ledger', `runawayguard: could not update the daily spend file (${err.code || err.message}). This session's spend is still counted.`);
    }
    const entry = { ...base, ...usage, usd: usd == null ? null : round(usd), spent: round(budget.spent()), limit: budget.limit, per: budget.per };
    if (aborted) entry.aborted = aborted;
    log(entry);
    onEvent('request', { ...entry, usd });
    if (crossed) onEvent(crossed, { spent: budget.spent(), limit: budget.limit });
  }

  function handle(req, res) {
    const kind = req.method === 'POST' ? apiKind(req.url) : null;
    if (kind && budget.blocks()) return block(req, res);

    const started = now();
    const headers = forwardHeaders(req.headers);
    headers.host = up.host;
    // Only ask for compressions the meter can decode, so no response goes unmetered.
    if (kind && headers['accept-encoding']) {
      const accepted = String(headers['accept-encoding']).split(',').filter((t) => decoderFor(t.split(';')[0]) !== undefined);
      if (accepted.length) headers['accept-encoding'] = accepted.join(',').trim();
      else delete headers['accept-encoding'];
    }
    const upReq = lib.request({
      protocol: up.protocol,
      hostname: up.hostname,
      port: up.port || undefined,
      method: req.method,
      path: joinPath(basePath, req.url),
      headers,
      agent,
    });

    // Keep a copy of the request body only to read its model name if the response lacks one.
    const reqChunks = [];
    let reqBytes = 0;
    if (kind) {
      req.on('data', (c) => {
        reqBytes += c.length;
        if (reqBytes <= MAX_SNIFF) reqChunks.push(c);
      });
    }
    const sniff = () => (reqBytes <= MAX_SNIFF ? sniffModel(reqChunks, req.headers['content-encoding']) : null);
    req.pipe(upReq);

    let finished = false;
    let clientGone = false;
    let upRes = null;
    let meter = null;
    // aborted: false, 'client' (the agent hung up) or 'upstream' (the API dropped the stream)
    // Settles once this request is recorded; close() waits for every open one.
    let settle = () => {};
    if (kind) {
      const p = new Promise((r) => (settle = r)).then(() => pending.delete(p));
      pending.add(p);
    }
    const finish = async (aborted) => {
      if (finished) return;
      finished = true;
      if (aborted && closing) aborted = 'shutdown';
      try {
        if (!kind || !upRes) return;
        const collected = meter ? await meter.done() : null;
        record({ req, kind, status: upRes.statusCode, stream: meter?.stream || false, started, collected, sniff, aborted, unmeterable: meter?.unmeterable });
      } catch (err) {
        fault(`record:${err.message}`, `runawayguard: could not record a request (${err.message})`);
      } finally {
        reqChunks.length = 0;
        settle();
      }
    };

    upReq.on('response', (r) => {
      upRes = r;
      res.writeHead(r.statusCode, r.statusMessage, forwardHeaders(r.headers));
      res.flushHeaders();
      if (kind && r.statusCode >= 200 && r.statusCode < 300) meter = createMeter(kind, r.headers);
      if (meter) r.on('data', (c) => meter.write(c));
      r.pipe(res);
      r.on('end', () => finish(false));
      // pipe() does not end the response when the upstream fails; close it so the agent
      // sees the failure instead of waiting on a stream that will never finish.
      const dropped = () => {
        finish(clientGone ? 'client' : 'upstream');
        res.destroy();
      };
      r.on('error', dropped);
      r.on('aborted', dropped);
    });

    upReq.on('error', (err) => {
      if (clientGone) return finish('client');
      if (!res.headersSent) {
        const message = `runawayguard: could not reach ${up.origin} (${err.code || err.message})`;
        const body = JSON.stringify({ type: 'error', error: { type: 'upstream_unreachable', code: 'upstream_unreachable', message } });
        res.writeHead(502, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) });
        res.end(body);
        onEvent('error', { path: req.url.split('?')[0], message });
      } else {
        res.destroy();
      }
      finish('upstream');
    });

    // The agent hung up (Esc, Ctrl+C): stop the upstream request so it stops generating.
    res.on('close', () => {
      if (!res.writableFinished) {
        clientGone = true;
        upReq.destroy();
        finish('client');
      }
    });
    req.on('aborted', () => upReq.destroy());
  }

  const server = http.createServer(handle);
  server.keepAliveTimeout = 65_000;
  // Streams of a long agent turn can run for many minutes; never time them out here.
  server.requestTimeout = 0;
  server.headersTimeout = 60_000;
  server.on('clientError', (err, socket) => socket.destroy());
  // WebSocket transports (Codex and OpenCode try one for the Responses API) cannot be
  // metered here. Refuse the upgrade plainly so the client falls back to HTTP streaming.
  server.on('upgrade', (req, socket) => {
    const body = JSON.stringify({ type: 'error', error: { type: 'websocket_not_supported', code: 'websocket_not_supported', message: 'runawayguard: WebSocket transport is not supported; use HTTP streaming.' } });
    socket.end(`HTTP/1.1 501 Not Implemented\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`);
    onEvent('websocket', { path: req.url.split('?')[0] });
  });

  return {
    server,
    stats,
    listen(port = 8402, host = '127.0.0.1') {
      return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, host, () => {
          server.off('error', reject);
          resolve(server.address().port);
        });
      });
    },
    /** Stops listening, ends open streams and waits until each one is recorded. */
    async close() {
      closing = true;
      const closed = new Promise((resolve) => server.close(() => resolve()));
      server.closeAllConnections?.();
      agent.destroy();
      await closed;
      const limit = new Promise((r) => setTimeout(r, 3000).unref());
      while (pending.size) await Promise.race([Promise.allSettled([...pending]), limit.then(() => pending.clear())]);
    },
  };
}

/** Side channel that decodes a response copy and collects its usage. */
function createMeter(kind, headers) {
  const collector = createCollector(kind);
  const stream = String(headers['content-type'] || '').includes('text/event-stream');
  let consumer;
  if (stream) {
    consumer = createSseParser((ev) => {
      if (!ev.data || ev.data === '[DONE]') return;
      if (collector.model && !ev.data.includes('"usage"')) return;
      try {
        collector.observe(JSON.parse(ev.data));
      } catch {
        // not JSON; ignore
      }
    });
  } else {
    const chunks = [];
    let size = 0;
    consumer = {
      write(c) {
        size += c.length;
        if (size <= MAX_JSON) chunks.push(c);
      },
      end() {
        if (size > MAX_JSON) return;
        try {
          collector.observe(JSON.parse(Buffer.concat(chunks).toString('utf8')));
        } catch {
          // not JSON; nothing to read
        }
      },
    };
  }

  const decoder = decoderFor(headers['content-encoding']);
  let unmeterable = decoder === undefined ? `content-encoding ${headers['content-encoding']} not supported` : null;
  let ended = false;
  let resolveDone;
  const donePromise = new Promise((r) => (resolveDone = r));
  const end = () => {
    if (ended) return;
    ended = true;
    if (!unmeterable) consumer.end();
    resolveDone(unmeterable ? null : collector.result());
  };
  if (decoder) {
    decoder.on('data', (c) => consumer.write(c));
    decoder.on('end', end);
    decoder.on('error', end);
  }

  return {
    stream,
    get unmeterable() {
      return unmeterable;
    },
    write(c) {
      if (unmeterable || ended) return;
      if (decoder) decoder.write(c);
      else consumer.write(c);
    },
    done() {
      if (decoder && !ended && !unmeterable) decoder.end();
      else end();
      return donePromise;
    },
  };
}

const round = (x) => Math.round(x * 1e6) / 1e6;
