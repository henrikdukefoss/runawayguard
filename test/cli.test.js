import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createBudget } from '../src/budget.js';
import { main, parseArgs, resolveUpstream } from '../src/cli.js';
import { meterLine, pct, shareCents, usd } from '../src/render.js';
import { anthropicJson, fakeUpstream, post, tmp, until } from './helpers.js';

const bin = fileURLToPath(new URL('../bin/runawayguard.js', import.meta.url));
const run = (args) => spawnSync(process.execPath, [bin, ...args], { encoding: 'utf8', env: { PATH: process.env.PATH, XDG_CACHE_HOME: tmp(), NO_COLOR: '1' } });

test('parseArgs', () => {
  assert.deepEqual(parseArgs(['--limit', '$5', '--upstream=anthropic', '--per', 'day', '--warn-at', '75%', '--port', '0', '--log', 'u.jsonl', '--offline']), {
    per: 'day', warnAt: 0.75, port: 0, dryRun: false, offline: true, color: true, limit: 5, upstream: 'anthropic', log: 'u.jsonl',
  });
  assert.equal(parseArgs(['--warn-at', '0.9']).warnAt, 0.9);
  assert.throws(() => parseArgs(['--limit', '0']), /dollar amount/);
  assert.throws(() => parseArgs(['--limit', 'abc']), /dollar amount/);
  assert.throws(() => parseArgs(['--per', 'week']), /session or day/);
  assert.throws(() => parseArgs(['--warn-at', '2']), /between 0 and 1/);
  assert.throws(() => parseArgs(['--port', '99999']), /port/);
  assert.throws(() => parseArgs(['--limit']), /needs a value/);
  assert.throws(() => parseArgs(['--nope']), /unknown option/);
});

test('money is cut to cents, never rounded up, and rows add up to the total', () => {
  assert.equal(usd(1.19996), '$1.19');
  assert.equal(usd(0.07), '$0.07');
  assert.equal(pct(1.1977, 1.5), '79%');
  assert.deepEqual(shareCents([1.51496, 0.00028]), [151, 0]);
  assert.deepEqual(shareCents([0.006, 0.006]), [1, 0]);
  assert.deepEqual(shareCents([0.333, 0.333, 0.334]), [33, 33, 34]);
});

test('resolveUpstream: shortcuts and validation', () => {
  assert.throws(() => resolveUpstream('https://user:pw@api.openai.com'), /user name or password/);
  assert.equal(resolveUpstream('anthropic'), 'https://api.anthropic.com');
  assert.equal(resolveUpstream('openai'), 'https://api.openai.com');
  assert.equal(resolveUpstream('https://openrouter.ai/api/'), 'https://openrouter.ai/api');
  assert.throws(() => resolveUpstream('api.anthropic.com'), /not a URL/);
  assert.throws(() => resolveUpstream('ftp://x'), /http/);
});

test('cli: missing --limit or --upstream exits 2 with a clear message', () => {
  let r = run(['--limit', '5']);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /--upstream is required/);
  r = run(['--upstream', 'anthropic']);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /--limit is required, for example --limit 5 \(or use --dry-run to meter only\)/);
  r = run(['--help']);
  assert.equal(r.status, 0);
  assert.match(r.stderr, /ANTHROPIC_BASE_URL=http:\/\/127\.0\.0\.1:8402 ENABLE_TOOL_SEARCH=true claude/);
  assert.equal(r.stdout, '');
});

test('cli: banner, per-request lines, warning, block and summary (not a terminal)', async () => {
  const up = await fakeUpstream((req, res) => {
    const body = JSON.stringify(anthropicJson());
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(body);
  });
  let out = '';
  const stderr = { write: (s) => (out += s), isTTY: false };
  const ac = new AbortController();
  const done = main(['--limit', '0.05', '--upstream', up.url, '--port', '0', '--offline'], { env: { XDG_CACHE_HOME: tmp(), XDG_STATE_HOME: tmp() }, stderr, signal: ac.signal });
  try {
    await until(() => /proxy +http:\/\/127\.0\.0\.1:\d+/.test(out));
    const url = /proxy +(http:\/\/127\.0\.0\.1:\d+)/.exec(out)[1];
    assert.match(out, /limit +\$0\.05 per session, warning at \$0\.04, then HTTP 402/);
    assert.match(out, /prices +LiteLLM \(bundled\), \d{4}-\d{2}-\d{2}/);
    assert.match(out, new RegExp(`ANTHROPIC_BASE_URL=${url} ENABLE_TOOL_SEARCH=true claude`));
    for (let i = 0; i < 3; i++) assert.equal((await post(url, '/v1/messages', { model: 'x' })).status, 200);
    assert.equal((await post(url, '/v1/messages', { model: 'x' })).status, 402);
    await until(() => /blocked POST/.test(out));
    assert.match(out, /\d\d:\d\d:\d\d {2}claude-sonnet-4-5-20250929 +13\.0K in +500 out +\$0\.0221 +\$0\.02 {2}44%/);
    assert.match(out, /runawayguard: over 80% of the \$0\.05 session limit used\.\n/);
    assert.match(out, /runawayguard: \$0\.05 session limit reached\. New requests are blocked with HTTP 402\./);
    assert.equal(out.match(/runawayguard: blocked POST \/v1\/messages \(HTTP 402\)\./g).length, 1);
    assert.equal((await post(url, '/v1/messages', { model: 'x' })).status, 402);
  } finally {
    ac.abort();
    assert.equal(await done, 0);
    await up.close();
  }
  assert.match(out, /runawayguard stopped after less than a minute/);
  assert.match(out, /claude-sonnet-4-5-20250929 +3 +40\.5K +30\.0K +\$0\.06/);
  assert.match(out, /TOTAL +3 +40\.5K +30\.0K +\$0\.06/);
  assert.match(out, /2 requests were blocked at the \$0\.05 session limit\./);
  assert.match(out, /runawayguard, made by Standard Compute \(standardcompute\.com\)/);
  assert.doesNotMatch(out, /—/);
  assert.doesNotMatch(out, /\x1b\[/);
});

test('meter line: fits the width, shows blocked count and dry run', () => {
  const budget = createBudget({ limit: 5, warnAt: 0.8, env: { XDG_STATE_HOME: tmp() } });
  budget.add(4.2);
  const stats = { requests: 23, blocked: 0 };
  const line = meterLine({ budget, stats, last: { model: 'claude-sonnet-5', usd: 0.0612 } });
  assert.equal(line, '$4.20 of $5.00 session  ━━━━━━━━━━━━━━━━━───  84%  23 requests  last claude-sonnet-5 $0.0612');
  assert.ok(meterLine({ budget, stats, last: { model: 'x'.repeat(200), usd: 1 }, width: 60 }).length <= 60);
  const colored = meterLine({ budget, stats: { requests: 1, blocked: 2, unmetered: 1 }, color: true });
  assert.match(colored, /1 without usage/);
  assert.match(colored, /\x1b\[33m84%/);
  assert.match(colored, /2 blocked/);
  const dry = createBudget({ dryRun: true, env: { XDG_STATE_HOME: tmp() } });
  assert.equal(meterLine({ budget: dry, stats: { requests: 0, blocked: 0 } }), '$0.00 session  0 requests  dry run');
});
