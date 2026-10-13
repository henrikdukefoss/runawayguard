// Running spend totals and the limit check.
//
// session: the total since this runawayguard process started, kept in memory.
// day:     the total for the current local calendar day, kept in a small ledger file
//          (one {"t","usd"} line per request, no other data) so it survives restarts and
//          is shared by every runawayguard process on this machine.
import { appendFileSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export function stateDir(env = process.env) {
  return join(env.XDG_STATE_HOME || join(env.RUNAWAYGUARD_HOME || homedir(), '.local', 'state'), 'runawayguard');
}

export const localDate = (ms) => {
  const d = new Date(ms);
  const p = (x) => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};

function createLedger(dir) {
  let cache = { file: null, size: -1, usd: 0 };
  const fileFor = (ms) => join(dir, `${localDate(ms)}.jsonl`);
  return {
    file: fileFor,
    total(ms) {
      const file = fileFor(ms);
      let size = 0;
      try {
        size = statSync(file).size;
      } catch {
        return 0;
      }
      if (cache.file === file && cache.size === size) return cache.usd;
      let usd = 0;
      let text;
      try {
        text = readFileSync(file, 'utf8');
      } catch {
        return cache.usd;
      }
      for (const l of text.split('\n')) {
        if (!l) continue;
        try {
          const v = JSON.parse(l).usd;
          if (typeof v === 'number' && Number.isFinite(v) && v > 0) usd += v;
        } catch {
          // a torn line from a concurrent writer; skip it
        }
      }
      cache = { file, size, usd };
      return usd;
    },
    touch(ms) {
      mkdirSync(dir, { recursive: true });
      appendFileSync(fileFor(ms), '');
    },
    add(ms, usd) {
      mkdirSync(dir, { recursive: true });
      appendFileSync(fileFor(ms), JSON.stringify({ t: new Date(ms).toISOString(), usd }) + '\n');
    },
  };
}

export function createBudget({ limit = null, per = 'session', warnAt = 0.8, dryRun = false, env = process.env, now = () => Date.now() } = {}) {
  const ledger = per === 'day' ? createLedger(join(stateDir(env), 'spend')) : null;
  let session = 0;
  let flags = { period: null, warned: false, reached: false };

  const period = () => (per === 'day' ? localDate(now()) : 'session');
  const resetFlags = () => {
    if (flags.period !== period()) flags = { period: period(), warned: false, reached: false };
  };

  const budget = {
    limit,
    per,
    warnAt,
    dryRun,
    ledgerFile: ledger ? () => ledger.file(now()) : null,
    spent: () => (ledger ? ledger.total(now()) : session),
    sessionSpent: () => session,
    /** True when a new metered request must be refused. */
    blocks() {
      return !dryRun && limit != null && budget.spent() >= limit;
    },
    reached() {
      return limit != null && budget.spent() >= limit;
    },
    /** Add a request's cost. Returns the threshold crossed by it, if any: 'warn' or 'limit'. */
    add(usd) {
      resetFlags();
      if (usd > 0) {
        session += usd;
        if (ledger) ledger.add(now(), usd);
      }
      if (limit == null) return null;
      const spent = budget.spent();
      if (!flags.reached && spent >= limit) {
        flags.reached = flags.warned = true;
        return 'limit';
      }
      if (!flags.warned && warnAt > 0 && warnAt < 1 && spent >= warnAt * limit) {
        flags.warned = true;
        return 'warn';
      }
      return null;
    },
    periodLabel: () => (per === 'day' ? 'daily' : 'session'),
    /** Throws when the day ledger cannot be written; checked once at startup. */
    checkWritable() {
      if (ledger) ledger.touch(now());
    },
  };
  resetFlags();
  return budget;
}
