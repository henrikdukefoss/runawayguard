// Everything runawayguard prints. All of it goes to stderr; stdout stays unused.

export const fmtInt = (x) => Math.round(x).toLocaleString('en-US');

export function fmtTokens(x) {
  if (x >= 999950) return `${(x / 1e6).toFixed(2)}M`;
  if (x >= 1000) return `${(x / 1e3).toFixed(1)}K`;
  return String(Math.round(x));
}

// Money is cut, never rounded up, to whole cents, so a total on screen is never reached
// before it is really spent and the percentage, the warning and the dollars agree.
const cents = (x) => Math.floor(x * 100 + 1e-6);
export const usd = (x) => `$${(cents(x) / 100).toFixed(2)}`;
export const pct = (spent, limit) => `${Math.floor((spent / limit) * 100 + 1e-9)}%`;

/** One request, always four decimals so the column lines up. */
export const usdRequest = (x) => (x == null ? 'unpriced' : `$${x.toFixed(4)}`);

export function palette(color) {
  const wrap = (code) => (s) => (color ? `\x1b[${code}m${s}\x1b[0m` : s);
  return { bold: wrap('1'), dim: wrap('2'), warn: wrap('33'), stop: wrap('31'), ok: wrap('32') };
}

const pad = (s, n) => (s.length >= n ? s : s + ' '.repeat(n - s.length));
const clip = (s, n) => (s.length <= n ? s : s.slice(0, n - 1) + '~');
const lpad = (s, n) => (s.length >= n ? s : ' '.repeat(n - s.length) + s);

function bar(frac, width, c, level) {
  const filled = Math.max(0, Math.min(width, Math.round(frac * width)));
  const tint = level === 'stop' ? c.stop : level === 'warn' ? c.warn : (s) => s;
  return tint('━'.repeat(filled)) + c.dim('─'.repeat(width - filled));
}

function level(budget) {
  if (budget.limit == null) return 'ok';
  const spent = budget.spent();
  if (spent >= budget.limit) return 'stop';
  if (budget.warnAt > 0 && budget.warnAt < 1 && spent >= budget.warnAt * budget.limit) return 'warn';
  return 'ok';
}

/** "$1.84 of $5.00 session" or "$1.84 today" in dry-run without a limit. */
function spentText(budget) {
  const spent = usd(budget.spent());
  const scope = budget.per === 'day' ? 'today' : 'session';
  return budget.limit == null ? `${spent} ${scope}` : `${spent} of ${usd(budget.limit)} ${scope}`;
}

/** The live meter: one line, redrawn in place on a terminal. */
export function meterLine({ budget, stats, last, color = false, width = 100 }) {
  const c = palette(color);
  const lv = level(budget);
  const parts = [];
  parts.push(c.bold(spentText(budget)));
  if (budget.limit != null) {
    const frac = budget.spent() / budget.limit;
    parts.push(bar(frac, 20, c, lv));
    const p = pct(budget.spent(), budget.limit);
    parts.push(lv === 'stop' ? c.stop(p) : lv === 'warn' ? c.warn(p) : p);
  }
  parts.push(`${fmtInt(stats.requests)} ${stats.requests === 1 ? 'request' : 'requests'}`);
  if (stats.blocked) parts.push(c.stop(`${fmtInt(stats.blocked)} blocked`));
  if (stats.unmetered) parts.push(c.warn(`${fmtInt(stats.unmetered)} without usage`));
  if (budget.dryRun) parts.push(c.dim('dry run'));
  if (last) parts.push(c.dim(`last ${last.model} ${usdRequest(last.usd)}`));
  return truncate(parts.join('  '), width);
}

/** The same information as a log line, for when stderr is not a terminal. */
export function requestLine({ entry, budget }) {
  const d = new Date(entry.time);
  const time = [d.getHours(), d.getMinutes(), d.getSeconds()].map((x) => String(x).padStart(2, '0')).join(':');
  const tokens = `${lpad(fmtTokens(entry.input + entry.cacheRead + entry.cacheWrite), 6)} in ${lpad(fmtTokens(entry.output), 6)} out`;
  const spent = budget.limit == null ? usd(budget.spent()) : `${lpad(usd(budget.spent()), 6)}  ${pct(budget.spent(), budget.limit)}`;
  const note = { client: '  (cancelled by the agent)', upstream: '  (dropped by the API)', shutdown: '  (stopped)' }[entry.aborted] || '';
  return `${time}  ${pad(clip(entry.model, 26), 26)}  ${tokens}  ${lpad(usdRequest(entry.usd), 8)}    ${spent}${note}`;
}

// Strip ANSI codes to measure, cut the visible text at width.
function truncate(s, width) {
  const visible = s.replace(/\x1b\[[0-9;]*m/g, '');
  if (visible.length <= width) return s;
  let out = '';
  let count = 0;
  for (let i = 0; i < s.length; ) {
    const m = /^\x1b\[[0-9;]*m/.exec(s.slice(i));
    if (m) {
      out += m[0];
      i += m[0].length;
      continue;
    }
    if (count >= width - 1) break;
    out += s[i++];
    count++;
  }
  return out + '\x1b[0m'.repeat(/\x1b\[/.test(s) ? 1 : 0);
}

export function banner({ version, url, upstream, budget, prices, logFile, color = false }) {
  const c = palette(color);
  const row = (k, v) => `  ${c.dim(pad(k, 10))} ${v}`;
  const out = [];
  out.push(`${c.bold('runawayguard')} ${version}`);
  out.push('');
  out.push(row('proxy', `${url}  ->  ${upstream}`));
  if (budget.limit == null) {
    out.push(row('limit', `none, dry run (meter only)`));
  } else {
    const per = budget.per === 'day' ? 'per day (local time)' : 'per session';
    const warn = budget.warnAt > 0 && budget.warnAt < 1 ? `, warning at $${(budget.warnAt * budget.limit).toFixed(2)}` : '';
    const then = budget.dryRun ? ', dry run: never blocks' : ', then HTTP 402';
    out.push(row('limit', `${usd(budget.limit)} ${per}${warn}${then}`));
  }
  if (budget.per === 'day') out.push(row('today', `${usd(budget.spent())} spent so far`));
  const date = prices.fetchedAt ? new Date(prices.fetchedAt).toISOString().slice(0, 10) : 'unknown date';
  out.push(row('prices', `${prices.source}, ${date}`));
  if (logFile) out.push(row('log', logFile));
  out.push('');
  out.push('  Point your agent at the proxy, for example:');
  for (const line of hints(url, upstream)) out.push(`    ${line}`);
  out.push('');
  out.push(c.dim('  Ctrl+C stops the proxy and prints a summary.'));
  out.push('');
  return out.join('\n');
}

export function hints(url, upstream) {
  const host = new URL(upstream).hostname;
  const anthropic = `Claude Code    ANTHROPIC_BASE_URL=${url} ENABLE_TOOL_SEARCH=true claude`;
  const openai = `OpenAI-style   base URL ${url}/v1 (Codex needs a provider entry, see the README)`;
  if (/(^|\.)anthropic\.com$/.test(host)) return [anthropic];
  if (/(^|\.)openai\.com$/.test(host)) return [openai];
  return [anthropic, openai];
}

export function summary({ stats, budget, prices, startedAt, now = Date.now(), color = false }) {
  const c = palette(color);
  const out = [];
  const mins = Math.max(0, Math.round((now - startedAt) / 60000));
  const dur = mins >= 60 ? `${Math.floor(mins / 60)}h ${mins % 60}m` : mins ? `${mins}m` : 'less than a minute';
  out.push(`${c.bold('runawayguard')} stopped after ${dur}`);
  out.push('');
  const rows = [...stats.models.entries()].sort((a, b) => b[1].usd - a[1].usd || b[1].requests - a[1].requests);
  if (!rows.length) {
    out.push('  No metered requests.');
  } else {
    const shown = shareCents(rows.map(([, m]) => m.usd));
    const W1 = Math.max(28, ...rows.map(([m]) => m.length + 2));
    const head = `  ${pad('MODEL', W1)}${lpad('REQUESTS', 9)}${lpad('TOKENS', 10)}${lpad('CACHE READ', 12)}${lpad('USD', 10)}`;
    out.push(c.dim(head));
    const sum = (f) => rows.reduce((a, [, m]) => a + f(m), 0);
    const tokens = (m) => m.input + m.output + m.cacheRead + m.cacheWrite;
    rows.forEach(([model, m], i) => {
      out.push(`  ${pad(model, W1)}${lpad(fmtInt(m.requests), 9)}${lpad(fmtTokens(tokens(m)), 10)}${lpad(fmtTokens(m.cacheRead), 12)}${lpad(m.priced ? `$${(shown[i] / 100).toFixed(2)}` : 'unpriced', 10)}`);
    });
    out.push(c.bold(`  ${pad('TOTAL', W1)}${lpad(fmtInt(sum((m) => m.requests)), 9)}${lpad(fmtTokens(sum(tokens)), 10)}${lpad(fmtTokens(sum((m) => m.cacheRead)), 12)}${lpad(usd(sum((m) => m.usd)), 10)}`));
    out.push(c.dim('  Tokens include input, output and cache reads and writes.'));
  }
  out.push('');
  if (budget.per === 'day') out.push(`  Today on this machine: ${usd(budget.spent())}${budget.limit != null ? ` of ${usd(budget.limit)}` : ''}.`);
  if (stats.blocked) out.push(`  ${fmtInt(stats.blocked)} ${stats.blocked === 1 ? 'request was' : 'requests were'} blocked at the ${usd(budget.limit)} ${budget.periodLabel()} limit.`);
  if (stats.unmetered) out.push(`  ${fmtInt(stats.unmetered)} ${stats.unmetered === 1 ? 'response had' : 'responses had'} no usage and could not be priced.`);
  const date = prices.fetchedAt ? new Date(prices.fetchedAt).toISOString().slice(0, 10) : 'unknown date';
  out.push(c.dim(`  List prices from ${prices.source}, ${date}. Your provider's invoice is the final word.`));
  out.push('');
  out.push(c.dim('runawayguard, made by Standard Compute (standardcompute.com)'));
  return out.join('\n');
}

/** Whole cents per row that add up to the total's cents (largest remainder). */
export function shareCents(values) {
  const total = cents(values.reduce((a, b) => a + b, 0));
  const exact = values.map((v) => v * 100);
  const out = exact.map((v) => Math.floor(v + 1e-6));
  let left = total - out.reduce((a, b) => a + b, 0);
  const order = exact.map((v, i) => [v - out[i], i]).sort((a, b) => b[0] - a[0]);
  for (let k = 0; left > 0 && k < order.length; k++, left--) out[order[k][1]]++;
  return out;
}
