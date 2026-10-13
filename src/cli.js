import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createBudget } from './budget.js';
import { loadPrices } from './pricing.js';
import { createGuard, UPSTREAMS } from './proxy.js';
import { banner, meterLine, palette, requestLine, summary, usd } from './render.js';

const VERSION = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
export const DEFAULT_PORT = 8402;

const HELP = `runawayguard ${VERSION} - a spend limit for coding agents that run on your own API key

Usage: npx github:henrikdukefoss/runawayguard --limit <usd> --upstream <url> [options]

Options:
  --limit <usd>        stop at this many dollars, for example 5 or 12.50
  --upstream <url>     the API to forward to, for example https://api.anthropic.com
                       (shortcuts: ${Object.keys(UPSTREAMS).join(', ')})
  --per <period>       session (default: since runawayguard started) or day (local
                       calendar day, kept across restarts)
  --warn-at <ratio>    print a warning at this share of the limit (default 0.8)
  --port <n>           local port (default ${DEFAULT_PORT}; 0 picks a free one)
  --log <file>         append one JSON line per request: model, tokens, cost (no content)
  --dry-run            meter only, never block (--limit is optional)
  --offline            use the bundled price table (no network apart from the proxy)
  --no-color           plain output
  -h, --help           show this help
  -v, --version        show version

Then point your agent at the proxy:
  Claude Code     ANTHROPIC_BASE_URL=http://127.0.0.1:${DEFAULT_PORT} ENABLE_TOOL_SEARCH=true claude
  OpenAI-style    base URL http://127.0.0.1:${DEFAULT_PORT}/v1
  Settings for Codex, OpenCode, Cline, Aider and others are in the README.

Requests pass through unchanged. API keys are forwarded, never stored or logged.`;

const money = (v, flag) => {
  const x = Number(String(v).replace(/^\$/, ''));
  if (!(x > 0) || !Number.isFinite(x)) throw new Error(`${flag} needs a dollar amount above 0, for example 5`);
  return x;
};

export function parseArgs(argv) {
  const o = { per: 'session', warnAt: 0.8, port: DEFAULT_PORT, dryRun: false, offline: false, color: true };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const [flag, inline] = a.startsWith('--') && a.includes('=') ? [a.slice(0, a.indexOf('=')), a.slice(a.indexOf('=') + 1)] : [a, undefined];
    const value = () => {
      const v = inline ?? argv[++i];
      if (v == null || v === '') throw new Error(`${flag} needs a value`);
      return v;
    };
    switch (flag) {
      case '--limit': o.limit = money(value(), '--limit'); break;
      case '--upstream': o.upstream = value(); break;
      case '--per': {
        o.per = value();
        if (o.per !== 'session' && o.per !== 'day') throw new Error('--per must be session or day');
        break;
      }
      case '--warn-at': {
        const v = value();
        const x = v.endsWith('%') ? Number(v.slice(0, -1)) / 100 : Number(v);
        if (!(x >= 0 && x <= 1)) throw new Error('--warn-at needs a ratio between 0 and 1, for example 0.8 (0 turns the warning off)');
        o.warnAt = x;
        break;
      }
      case '--port': {
        o.port = Number(value());
        if (!Number.isInteger(o.port) || o.port < 0 || o.port > 65535) throw new Error('--port needs a port number');
        break;
      }
      case '--log': o.log = value(); break;
      case '--dry-run': o.dryRun = true; break;
      case '--offline': o.offline = true; break;
      case '--no-color': o.color = false; break;
      case '-h': case '--help': o.help = true; break;
      case '-v': case '--version': o.version = true; break;
      default: throw new Error(`unknown option ${a} (see --help)`);
    }
  }
  return o;
}

export function resolveUpstream(u) {
  const raw = UPSTREAMS[String(u).toLowerCase()] || u;
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`--upstream is not a URL: ${u}`);
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error('--upstream must be an http(s) URL');
  if (url.search || url.hash) throw new Error('--upstream must not have a query string');
  if (url.username || url.password) throw new Error('--upstream must not contain a user name or password; your agent sends the API key');
  return url.href.replace(/\/+$/, '');
}

/**
 * Runs the proxy until SIGINT/SIGTERM (or opts.signal aborts). Resolves to an exit code.
 * The test suite drives it with a stub stderr and an AbortSignal.
 */
export async function main(argv = process.argv.slice(2), { env = process.env, stderr = process.stderr, signal, now = () => Date.now() } = {}) {
  const say = (s) => stderr.write(s + '\n');
  let o;
  let upstream;
  try {
    o = parseArgs(argv);
    if (o.help) return say(HELP), 0;
    if (o.version) return say(VERSION), 0;
    if (!o.upstream) throw new Error('--upstream is required, for example --upstream https://api.anthropic.com');
    upstream = resolveUpstream(o.upstream);
    if (o.limit == null && !o.dryRun) throw new Error('--limit is required, for example --limit 5 (or use --dry-run to meter only)');
  } catch (err) {
    say(`runawayguard: ${err.message}`);
    return 2;
  }

  const color = o.color && !!stderr.isTTY && !env.NO_COLOR;
  const c = palette(color);
  const tty = !!stderr.isTTY;
  const prices = await loadPrices({ offline: o.offline, env });
  if (prices.note) say(`note: ${prices.note}`);
  const budget = createBudget({ limit: o.limit ?? null, per: o.per, warnAt: o.warnAt, dryRun: o.dryRun, env, now });
  try {
    budget.checkWritable();
  } catch (err) {
    say(`runawayguard: cannot write the daily spend file (${err.code || err.message}). Check ${err.path || 'XDG_STATE_HOME'}, or use --per session.`);
    return 1;
  }
  const logFile = o.log ? resolve(o.log) : null;
  const startedAt = now();
  let last = null;
  let wsNoted = false;
  let guard;

  const width = () => Math.max(40, (stderr.columns || 100) - 1);
  const drawMeter = () => {
    if (tty) stderr.write(`\r\x1b[K${meterLine({ budget, stats: guard.stats, last, color, width: width() })}`);
  };
  // Lines that must stay on screen: clear the meter, print, redraw.
  const note = (s) => {
    if (tty) stderr.write('\r\x1b[K');
    say(s);
    drawMeter();
  };

  const onEvent = (type, d) => {
    switch (type) {
      case 'request':
        last = d;
        if (tty) drawMeter();
        else say(requestLine({ entry: d, budget }));
        break;
      case 'warn':
        note(c.warn(`runawayguard: over ${Math.round(budget.warnAt * 100)}% of the ${usd(d.limit)} ${budget.periodLabel()} limit used.`));
        break;
      case 'limit':
        note(c.stop(budget.dryRun
          ? `runawayguard: ${usd(d.limit)} ${budget.periodLabel()} limit reached. Dry run, so requests still go through.`
          : `runawayguard: ${usd(d.limit)} ${budget.periodLabel()} limit reached. New requests are blocked with HTTP 402.`));
        break;
      case 'block':
        // the first block is worth a line; later ones are counted in the meter and summary
        if (d.count === 1) note(c.stop(`runawayguard: blocked POST ${d.path} (HTTP 402).`));
        else drawMeter();
        break;
      case 'unpriced':
        note(`runawayguard: no list price for "${d.model}". Its tokens are counted but cost $0 toward the limit.`);
        break;
      case 'unmetered':
        if (guard.stats.unmetered > 1) drawMeter();
        else {
          const why = d.reason === 'no usage in stream' && d.api === 'chat'
            ? 'a streamed chat completion had no usage, so it is not counted. The client must send stream_options.include_usage (see the README for Aider).'
            : `a ${d.path} response had no usage (${d.reason}). It is not counted toward the limit.`;
          note(c.warn(`runawayguard: ${why}`));
        }
        break;
      case 'error':
        note(c.stop(d.message));
        break;
      case 'websocket':
        if (!wsNoted) note(`runawayguard: refused a WebSocket connection to ${d.path}. The agent should fall back to HTTP streaming; see the README for Codex.`);
        wsNoted = true;
        break;
    }
  };

  guard = createGuard({ upstream, prices, budget, logFile, onEvent, now });
  let port;
  try {
    port = await guard.listen(o.port);
  } catch (err) {
    say(err.code === 'EADDRINUSE'
      ? `runawayguard: port ${o.port} is in use. Pass --port <n>, or --port 0 for any free port.`
      : `runawayguard: could not listen on 127.0.0.1:${o.port} (${err.code || err.message})`);
    return 1;
  }
  const url = `http://127.0.0.1:${port}`;
  say(banner({ version: VERSION, url, upstream, budget, prices, logFile, color }));
  drawMeter();

  await new Promise((done) => {
    const stop = () => done();
    if (signal) signal.addEventListener('abort', stop, { once: true });
    else {
      process.once('SIGINT', stop);
      process.once('SIGTERM', stop);
    }
  });

  // Stop first, so streams cut off by the shutdown are recorded before the summary.
  await guard.close();
  stderr.write(tty ? '\r\x1b[K\n' : '\n');
  say(summary({ stats: guard.stats, budget, prices, startedAt, now: now(), color }));
  return 0;
}
